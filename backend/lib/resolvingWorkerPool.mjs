/**
 * resolvingWorkerPool.mjs — Stage 2: 3-Worker Parallel Answer Resolution
 *
 * Runs strictly 3 resolving workers (resolving_worker_1, resolving_worker_2, resolving_worker_3):
 * 1. Reads scanned_jobs that have harvested questions.
 * 2. Matches questions against candidate facts, Zoho/ApplyWizz profiles, and resumes.
 * 3. Saves structured 4-tier answers into job_distributions with status 'ready_for_review'.
 * 4. Dynamically updates resolving_worker_1..3 rows in worker_status.
 * 5. Halts immediately if Stop is requested.
 */

import { updateWorkerStatus, recordJobDistributions, getActiveCaCandidateIds } from './supabaseClient.mjs';
import { loadProfile } from './planner.mjs';
import { preResolveClientAnswersDetailed } from './jobFormCache.mjs';
import { isGlobalStopRequested, isScanStopRequested } from './browserLifecycle.mjs';
import { getCleanSupabaseEnv } from './clusterBatchRunner.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';

export const RESOLVER_WORKER_IDS = PIPELINE_CONFIG.resolveWorkerIds || Array.from({ length: 2 }, (_, i) => `worker_${i + 1}`);

/**
 * Run Stage 2: Parallel Resolving Pool
 */
export async function runResolvingWorkerPool(options = {}) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`⚡ [STAGE 2: RESOLVER] Launching ${RESOLVER_WORKER_IDS.length} Resolving Workers for Candidate Answers...`);
  console.log(`   Workers: ${RESOLVER_WORKER_IDS.join(', ')}`);
  console.log(`${'═'.repeat(72)}\n`);

  if (isGlobalStopRequested() || isScanStopRequested()) {
    console.log(`🛑 [STAGE 2] Stop requested. Aborting resolving pool.`);
    return { success: false, aborted: true };
  }

  // 1. Fetch scanned jobs with question schemas
  const { url, key, configured } = getCleanSupabaseEnv();
  if (!configured) {
    console.warn(`[STAGE 2] Supabase not configured.`);
    return { success: false, error: 'Database not configured' };
  }

  const scannedRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/scanned_jobs?question_count=gt.0&select=id,applywizz_id,job_url,company,role_title,scraped_questions,screenshot_path&order=created_at.desc&limit=200`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });

  const scannedJobs = (scannedRes.ok && scannedRes.json()) || [];
  if (!Array.isArray(scannedJobs) || scannedJobs.length === 0) {
    console.log(`[STAGE 2] No scanned jobs with questions waiting for resolution.`);
    return { success: true, processedCount: 0 };
  }

  // 2. Fetch candidate IDs needing distributions (ensuring min 20 clients)
  const activeCandidatesRes = await getActiveCaCandidateIds().catch(() => ({}));
  let activeCandidateIds = Array.isArray(activeCandidatesRes)
    ? activeCandidatesRes
    : (Array.isArray(activeCandidatesRes?.candidateIds) ? activeCandidatesRes.candidateIds : []);

  // Ensure candidate pool has at least 20 clients by querying clients table
  if (activeCandidateIds.length < 20) {
    try {
      const clientRes = await httpsJsonWithRetry({
        url: `${url}/rest/v1/clients?select=applywizz_id&limit=100`,
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (clientRes.ok) {
        const clientRows = clientRes.json() || [];
        const extraIds = clientRows
          .map((c) => String(c.applywizz_id || '').toUpperCase().trim())
          .filter(Boolean);
        activeCandidateIds = Array.from(new Set([...activeCandidateIds, ...extraIds]));
      }
    } catch {}
  }

  // Fallback: check batch_job_queue unique applywizz_ids if still under 20
  if (activeCandidateIds.length < 20) {
    try {
      const bqRes = await httpsJsonWithRetry({
        url: `${url}/rest/v1/batch_job_queue?select=applywizz_id&limit=2000`,
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (bqRes.ok) {
        const bqRows = bqRes.json() || [];
        const bqIds = bqRows
          .map((r) => String(r.applywizz_id || '').toUpperCase().trim())
          .filter(Boolean);
        activeCandidateIds = Array.from(new Set([...activeCandidateIds, ...bqIds]));
      }
    } catch {}
  }

  console.log(`[STAGE 2] Found ${scannedJobs.length} scanned jobs to match across ${activeCandidateIds.length} candidate(s) (target: min 20 clients).`);

  let jobIndex = 0;
  let resolvedTotal = 0;

  async function resolverLoop(workerId, slotIndex) {
    while (jobIndex < scannedJobs.length) {
      if (isGlobalStopRequested() || isScanStopRequested()) {
        console.log(`🛑 [${workerId}] Stop active! Halting resolver loop.`);
        break;
      }

      const myIndex = jobIndex++;
      const job = scannedJobs[myIndex];
      if (!job) break;

      const company = job.company || 'Workday Partner';
      const roleTitle = job.role_title || 'Workday Application';
      const questions = job.scraped_questions || [];

      await updateWorkerStatus(workerId, {
        state: 'in_flight',
        current_application_id: job.job_url, // STRICT URL IDENTIFICATION
        stage: 'resolving',
        bot_name: `Worker ${slotIndex + 1}`,
      }).catch(() => {});

      // STRICT URL IDENTIFICATION: Find candidates specifically assigned to this Job URL in batch_job_queue
      const cleanJobUrl = String(job.job_url || '').split('?')[0].trim();
      let candidatesToProcess = [];
      try {
        const queueRes = await httpsJsonWithRetry({
          url: `${url}/rest/v1/batch_job_queue?job_url=ilike.${encodeURIComponent(cleanJobUrl)}*&select=applywizz_id`,
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        if (queueRes.ok) {
          const qRows = queueRes.json() || [];
          candidatesToProcess = [...new Set(qRows.map(r => r.applywizz_id).filter(Boolean))];
        }
      } catch {}

      // Ensure at least 20 clients are included for resolution across the client pool
      if (candidatesToProcess.length < 20 && activeCandidateIds.length > 0) {
        for (const cid of activeCandidateIds) {
          if (!candidatesToProcess.includes(cid)) {
            candidatesToProcess.push(cid);
          }
          if (candidatesToProcess.length >= 20) break;
        }
      }

      if (candidatesToProcess.length === 0) {
        candidatesToProcess = [job.applywizz_id || 'AWL-PRIMARY'];
      }

      console.log(`   🔍 [${workerId}] [Job #${myIndex + 1}/${scannedJobs.length}] Resolving answers for Job URL: ${job.job_url}`);
      console.log(`      • Candidates queued for this specific URL: ${candidatesToProcess.length} candidates (${candidatesToProcess.slice(0, 5).join(', ')}${candidatesToProcess.length > 5 ? '...' : ''})`);
      console.log(`      • Questions: ${questions.length} fields | Metadata: ${company} — ${roleTitle}`);

      const schema = {
        id: job.id,
        fields_schema: questions,
        company,
        role_title: roleTitle,
      };

      for (const awlId of candidatesToProcess) {
        if (isGlobalStopRequested()) break;
        try {
          const profile = await loadProfile(null, { applywizzId: awlId });
          if (profile) {
            profile._applyWizzId = awlId;
            profile._canonicalJobUrl = job.job_url;
            profile._jobUrl = job.job_url;
            profile._company = company;

            const detailed = await preResolveClientAnswersDetailed({ jobUrl: job.job_url, schema, profile });
            const structuredAnswers = detailed?.structuredAnswers || [];
            const rawUnanswered = Array.isArray(detailed?.unansweredQuestions)
              ? detailed.unansweredQuestions
              : structuredAnswers.filter(q => !q.is_answered && q.is_required).map(q => ({
                  question: q.question,
                  field_type: q.field_type || 'text',
                  step: q.step || 'Application Questions',
                  options: q.options || [],
                  is_required: true,
                  reason: 'missing_required_answer',
                }));

            const unanswered = rawUnanswered.filter((q) => {
              const lbl = String(q.question || q.label || '').toLowerCase();
              if (/first name|last name|email|phone|mobile|address|street|city|state|postal|zip|country/i.test(lbl)) return false;
              if (/voluntary|disclosure|self identify|eeo|veteran|disability|gender|race|ethnicity|hispanic/i.test(lbl)) return false;
              return true;
            });

            const unansweredCount = unanswered.length;
            const isFully = (unansweredCount === 0);
            const clientStatus = isFully ? 'ready_for_review' : 'needs_answers';

            await recordJobDistributions({
              leadApplywizzId: job.applywizz_id,
              jobId: job.id,
              jobUrl: job.job_url,
              company,
              roleTitle,
              scrapedQuestions: questions,
              resolvedAnswers: structuredAnswers,
              unansweredQuestions: unanswered,
              unansweredCount,
              screenshotUrl: job.screenshot_path || null,
              status: clientStatus,
              clients: [{
                applywizzId: awlId,
                jobId: job.id,
                jobUrl: job.job_url,
                resolvedAnswers: structuredAnswers,
                unansweredQuestions: unanswered,
                unansweredCount,
                isFullyAnswered: isFully,
                status: clientStatus,
              }],
            }).catch(() => {});

            // Scan and resolving workers may ONLY create submission_tasks rows as ready_for_review (R3)
            if (isFully) {
              try {
                // Fetch distribution_id from job_distributions to maintain 1:1 foreign key linkage
                let distributionId = null;
                try {
                  const distRes = await httpsJsonWithRetry({
                    url: `${url}/rest/v1/job_distributions?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(job.job_url)}&select=id&limit=1`,
                    method: 'GET',
                    headers: {
                      apikey: key,
                      Authorization: `Bearer ${key}`,
                    },
                    });
                  const distRows = (distRes && distRes.ok) ? distRes.json() : [];
                  if (Array.isArray(distRows) && distRows.length > 0) {
                    distributionId = distRows[0].id;
                  }
                } catch { }

                let alreadyExists = false;
                try {
                  const existCheck = await httpsJsonWithRetry({
                    url: `${url}/rest/v1/submission_tasks?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(job.job_url)}&select=id&limit=1`,
                    method: 'GET',
                    headers: { apikey: key, Authorization: `Bearer ${key}` },
                    });
                  const existRows = (existCheck && existCheck.ok) ? existCheck.json() : [];
                  if (Array.isArray(existRows) && existRows.length > 0) alreadyExists = true;
                } catch { }

                if (!alreadyExists) {
                  await httpsJsonWithRetry({
                  url: `${url}/rest/v1/submission_tasks`,
                  method: 'POST',
                  headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    Prefer: 'resolution=ignore-duplicates',
                  },
                  body: {
                    distribution_id: distributionId,
                    applywizz_id: awlId,
                    job_url: job.job_url,
                    company,
                    role_title: roleTitle,
                    status: 'ready_for_review',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  });
                }
              } catch {}
            }

            resolvedTotal++;
          }
        } catch (err) {
          console.warn(`   ⚠️ [${workerId}] Resolution note for ${awlId}: ${err.message}`);
        }
      }
    }

    await updateWorkerStatus(workerId, {
      state: 'idle',
      current_application_id: null,
      stage: 'resolving',
      bot_name: `Worker ${slotIndex + 1}`,
    }).catch(() => {});
  }

  // Run the 10 resolver workers in parallel
  await Promise.all(RESOLVER_WORKER_IDS.map((wId, i) => resolverLoop(wId, i)));

  console.log(`\n✅ [STAGE 2: RESOLVER] Resolution complete. Total distributions pre-resolved: ${resolvedTotal}`);
  return { success: true, processedCount: resolvedTotal };
}
