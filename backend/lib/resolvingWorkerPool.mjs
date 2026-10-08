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
import { isGlobalStopRequested } from './browserLifecycle.mjs';
import { getCleanSupabaseEnv } from './clusterBatchRunner.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

const RESOLVER_WORKER_IDS = ['resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3'];

/**
 * Run Stage 2: 3-Worker Resolving Pool
 */
export async function runResolvingWorkerPool(options = {}) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`⚡ [STAGE 2: RESOLVER] Launching 3 Resolving Workers for Candidate Answers...`);
  console.log(`   Workers: ${RESOLVER_WORKER_IDS.join(', ')}`);
  console.log(`${'═'.repeat(72)}\n`);

  if (isGlobalStopRequested()) {
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
    url: `${url}/rest/v1/scanned_jobs?question_count=gt.0&select=id,applywizz_id,job_url,company,role_title,scraped_questions,screenshot_path&order=created_at.desc&limit=50`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });

  const scannedJobs = (scannedRes.ok && scannedRes.json()) || [];
  if (!Array.isArray(scannedJobs) || scannedJobs.length === 0) {
    console.log(`[STAGE 2] No scanned jobs with questions waiting for resolution.`);
    return { success: true, processedCount: 0 };
  }

  // 2. Fetch candidate IDs needing distributions
  const activeCandidates = await getActiveCaCandidateIds().catch(() => []);
  console.log(`[STAGE 2] Found ${scannedJobs.length} scanned jobs to match across active candidates.`);

  let jobIndex = 0;
  let resolvedTotal = 0;

  async function resolverLoop(workerId, slotIndex) {
    while (jobIndex < scannedJobs.length) {
      if (isGlobalStopRequested()) {
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
        bot_name: `Resolving Worker ${slotIndex + 1}`,
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
            const unanswered = Array.isArray(detailed?.unansweredQuestions)
              ? detailed.unansweredQuestions
              : structuredAnswers.filter(q => !q.is_answered && q.is_required).map(q => ({
                  question: q.question,
                  field_type: q.field_type || 'text',
                  step: q.step || 'Application Questions',
                  options: q.options || [],
                  is_required: true,
                  reason: 'missing_required_answer',
                }));
            const unansweredCount = (detailed?.unansweredCount !== undefined && detailed?.unansweredCount !== null)
              ? Number(detailed.unansweredCount)
              : unanswered.length;
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
      bot_name: `Resolving Worker ${slotIndex + 1}`,
    }).catch(() => {});
  }

  // Run the 3 resolver workers in parallel
  await Promise.all(RESOLVER_WORKER_IDS.map((wId, i) => resolverLoop(wId, i)));

  console.log(`\n✅ [STAGE 2: RESOLVER] Resolution complete. Total distributions pre-resolved: ${resolvedTotal}`);
  return { success: true, processedCount: resolvedTotal };
}
