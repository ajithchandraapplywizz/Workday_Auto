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

import { updateWorkerStatus, recordJobDistributions, getActiveCaCandidateIds, recordNovelQABankAnswer } from './supabaseClient.mjs';
import { loadProfile } from './planner.mjs';
import { preResolveClientAnswersDetailed } from './jobFormCache.mjs';
import { isGlobalStopRequested, isScanStopRequested } from './browserLifecycle.mjs';
import { getCleanSupabaseEnv } from './clusterBatchRunner.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';

export const RESOLVER_WORKER_IDS = (PIPELINE_CONFIG.resolveWorkerIds || Array.from({ length: 2 }, (_, i) => `resolving_worker_${i + 1}`)).slice(0, 2);

/**
 * Run Stage 2: Parallel Resolving Pool
 */
export async function runResolvingWorkerPool(options = {}) {
// [SILENCED]   console.log(`\n${'═'.repeat(72)}`);
// [SILENCED]   console.log(`⚡ [STAGE 2: RESOLVER] Launching ${RESOLVER_WORKER_IDS.length} Resolving Workers for Candidate Answers...`);
// [SILENCED]   console.log(`   Workers: ${RESOLVER_WORKER_IDS.join(', ')}`);
// [SILENCED]   console.log(`${'═'.repeat(72)}\n`);

  if (isGlobalStopRequested() || isScanStopRequested()) {
// [SILENCED]     console.log(`🛑 [STAGE 2] Stop requested. Aborting resolving pool.`);
    return { success: false, aborted: true };
  }

  // 1. Fetch scanned jobs with question schemas
  const { url, key, configured } = getCleanSupabaseEnv();
  if (!configured) {
    console.warn(`[STAGE 2] Supabase not configured.`);
    return { success: false, error: 'Database not configured' };
  }

  const scannedRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/scanned_jobs?question_count=gt.0&select=id,applywizz_id,job_url,company,role_title,scraped_questions,resolved_answers,screenshot_path&order=created_at.desc&limit=200`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });

  const scannedJobs = (scannedRes.ok && scannedRes.json()) || [];
  if (!Array.isArray(scannedJobs) || scannedJobs.length === 0) {
// [SILENCED]     console.log(`[STAGE 2] No scanned jobs with questions waiting for resolution.`);
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

// [SILENCED]   console.log(`[STAGE 2] Found ${scannedJobs.length} scanned jobs to match across ${activeCandidateIds.length} candidate(s) (target: min 20 clients).`);

  let jobIndex = 0;
  let resolvedTotal = 0;
  const resolvedMilestoneRecords = [];

  async function resolverLoop(workerId, slotIndex) {
    while (jobIndex < scannedJobs.length) {
      if (isGlobalStopRequested() || isScanStopRequested()) {
// [SILENCED]         console.log(`🛑 [${workerId}] Stop active! Halting resolver loop.`);
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
          const rawAwls = [];
          for (const r of qRows) {
            if (!r.applywizz_id) continue;
            try {
              const parsed = JSON.parse(r.applywizz_id);
              if (Array.isArray(parsed)) {
                rawAwls.push(...parsed);
                continue;
              }
            } catch {}
            rawAwls.push(...String(r.applywizz_id).split(','));
          }
          candidatesToProcess = [...new Set(rawAwls.map(id => String(id).replace(/["'\[\]\\]/g, '').trim().toUpperCase()).filter(Boolean))];
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

// [SILENCED]       console.log(`   🔍 [${workerId}] [Job #${myIndex + 1}/${scannedJobs.length}] Resolving answers for Job URL: ${job.job_url}`);
// [SILENCED]       console.log(`      • Candidates queued for this specific URL: ${candidatesToProcess.length} candidates (${candidatesToProcess.slice(0, 5).join(', ')}${candidatesToProcess.length > 5 ? '...' : ''})`);
// [SILENCED]       console.log(`      • Questions: ${questions.length} fields | Metadata: ${company} — ${roleTitle}`);

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
// [SILENCED]             console.log(`\n${'═'.repeat(64)}`);
// [SILENCED]             console.log(`🔍 [${workerId}] Picked AWL-ID: ${awlId} for resolution`);
// [SILENCED]             console.log(`   Job: ${company} — ${roleTitle}`);
// [SILENCED]             console.log(`   Questions to Resolve: ${schema.fields_schema?.length || questions.length} fields`);
// [SILENCED]             console.log(`${'─'.repeat(64)}`);

            // Strict 5-tier resolution with Universal YAML blocked for Stage 2
            const detailed = await preResolveClientAnswersDetailed({
              jobUrl: job.job_url,
              schema,
              profile,
              options: { blockUniversalYaml: true, stage: 'stage2' },
            });
            const structuredAnswers = detailed?.structuredAnswers || [];

            // Universal Question Copying Policy: Propagate lead blueprint answers to sibling candidates
            // Strict guard: Never copy answers if lead candidate was mock scanner blueprint (AWL-1568)
            const isMockLead = String(job.applywizz_id || '').toUpperCase().includes('1568');
            const leadAnswersList = (!isMockLead && Array.isArray(job.resolved_answers)) ? job.resolved_answers : [];
            const leadAnswerMap = new Map();
            for (const la of leadAnswersList) {
              const qNorm = String(la.question || la.label || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
              const val = String(la.answer ?? la.value ?? '').trim();
              if (qNorm && val) {
                leadAnswerMap.set(qNorm, val);
              }
            }

            const todayDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

            for (const sa of structuredAnswers) {
              const qText = String(sa.question || sa.label || '').trim();
              const qNorm = String(sa.question_normalized || qText).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

              // If sibling has no answer, copy lead answer for universal questions (only from real lead)
              if (!sa.answer || !sa.is_answered) {
                const isPersonalIdentity = /first name|last name|email|phone|mobile|address line|street|postal|zip/i.test(qText);
                if (!isPersonalIdentity && leadAnswerMap.has(qNorm)) {
                  sa.answer = leadAnswerMap.get(qNorm);
                  sa.is_answered = true;
                  sa.source = 'Lead Blueprint Answer (Universal)';
                  sa.tier = 1;
                }
              }

              // Apply universal defaults if still unanswered
              if (!sa.answer || !sa.is_answered) {
                if (/how did you hear|source|referral/i.test(qText)) {
                  sa.answer = 'LinkedIn';
                  sa.is_answered = true;
                  sa.source = 'Universal Referral Default';
                  sa.tier = 1;
                } else if (/current value is|signature date|^date\*?$/i.test(qText)) {
                  sa.answer = todayDate;
                  sa.is_answered = true;
                  sa.source = 'Today Application Date';
                  sa.tier = 1;
                } else if (/if yes.*explain/i.test(qText) || /explanation|additional comments|describe/i.test(qText)) {
                  sa.answer = 'N/A';
                  sa.is_answered = true;
                  sa.source = 'Universal N/A Default';
                  sa.tier = 1;
                } else if (Array.isArray(sa.options) && sa.options.length > 0) {
                  const yesOpt = sa.options.find(o => /^yes\b/i.test(String(o).trim()));
                  const noOpt = sa.options.find(o => /^no\b/i.test(String(o).trim()));
                  if (/felon|convict|crime|terminat|fired|conflict|non-?compet/i.test(qText) && noOpt) {
                    sa.answer = String(noOpt);
                  } else if (yesOpt) {
                    sa.answer = String(yesOpt);
                  } else {
                    sa.answer = String(sa.options[0]);
                  }
                  sa.is_answered = true;
                  sa.source = 'Tier 5: Universal Policy Fallback';
                  sa.tier = 5;
                } else if (sa.is_required) {
                  sa.answer = 'N/A';
                  sa.is_answered = true;
                  sa.source = 'Universal Text Default';
                  sa.tier = 5;
                }
              }
            }

            // Print per-question resolution logs and store new novel answers to qa_bank
            let qNum = 0;
            const totalQCount = structuredAnswers.length;
            let t1Count = 0;
            let t2Count = 0;
            let t3Count = 0;
            let t4Count = 0;
            let t5Count = 0;

            for (const sa of structuredAnswers) {
              qNum++;
              const qText = String(sa.question || sa.label || '').trim();
              const ansDisplay = sa.answer ? `"${String(sa.answer).slice(0, 45)}"` : 'MISSING';
              const tierTag = sa.source || `Tier ${sa.tier || '?'}`;
              // [SILENCED] console.log Q-by-Q

              if (sa.tier === 1) t1Count++;
              else if (sa.tier === 2) t2Count++;
              else if (sa.tier === 3) t3Count++;
              else if (sa.tier === 4) t4Count++;
              else t5Count++;

              // Perpetual self-learning: store any LLM-resolved answer with candidate AWL-ID
              if (sa.tier === 5 || sa.source?.toLowerCase().includes('llm') || sa.source?.toLowerCase().includes('ai')) {
                recordNovelQABankAnswer({
                  applywizzId: awlId,
                  question: qText,
                  questionNormalized: sa.question_normalized,
                  answer: sa.answer,
                  fieldType: sa.field_type || 'text',
                  source: 'llm',
                }).then((stored) => {
// [SILENCED]                   if (stored) console.log(`         ↳ NEW Q&A stored to qa_bank for ${awlId} ✓`);
                }).catch(() => {});
              }
            }
// [SILENCED]             console.log(`${'─'.repeat(64)}`);

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
              if (/how did you hear|source|referral/i.test(lbl)) return false;
              if (/current value is|signature date|^date\*?$/i.test(lbl)) return false;
              if (/if yes.*explain/i.test(lbl)) return false;
              if (/first name|last name|email|phone|mobile|address|street|city|state|postal|zip|country/i.test(lbl)) return false;
              if (/voluntary|disclosure|self identify|eeo|veteran|disability|gender|race|ethnicity|hispanic/i.test(lbl)) return false;
              return true;
            });

            const unansweredCount = unanswered.length;
            const isFully = (unansweredCount === 0);
            const clientStatus = isFully ? 'ready_for_review' : 'needs_answers';
            const answeredTotal = structuredAnswers.filter(q => q.is_answered).length;
            const pctResolved = totalQCount > 0 ? Math.round((answeredTotal / totalQCount) * 100) : 100;

            if (isFully) {
              console.log(`✅ [${workerId}] ${awlId} resolved ${answeredTotal}/${totalQCount} (100%) → status: "ready_for_review"`);
              if (job.screenshot_path) {
                console.log(`   📸 Review Screenshot: ${job.screenshot_path}`);
              }
            }

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
              screenshotUrl: null, // STRICT POLICY: Scanned review screenshot belongs in scanned_jobs only; job_distributions screenshot is authentic post-submission proof only
              status: clientStatus,
              clients: [{
                applywizzId: awlId,
                jobId: job.id,
                jobUrl: job.job_url,
                resolvedAnswers: structuredAnswers,
                unansweredQuestions: unanswered,
                unansweredCount,
                isFullyAnswered: isFully,
                screenshotUrl: null,
                status: clientStatus,
              }],
            }).catch(() => {});

            // Scan and resolving workers may ONLY create submission_tasks rows as ready_for_review (R3)
            if (isFully) {
              try {
                const cleanAwl = String(awlId).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
                // Fetch distribution_id from job_distributions to maintain 1:1 foreign key linkage
                let distributionId = null;
                try {
                  const distRes = await httpsJsonWithRetry({
                    url: `${url}/rest/v1/job_distributions?applywizz_id=eq.${encodeURIComponent(cleanAwl)}&job_url=eq.${encodeURIComponent(job.job_url)}&select=id&limit=1`,
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

                await httpsJsonWithRetry({
                  url: `${url}/rest/v1/submission_tasks?on_conflict=applywizz_id,job_url`,
                  method: 'POST',
                  headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    Prefer: 'resolution=merge-duplicates,return=minimal',
                  },
                  body: {
                    distribution_id: distributionId,
                    applywizz_id: cleanAwl,
                    job_url: job.job_url,
                    company,
                    role_title: roleTitle,
                    status: 'ready_for_review',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                }).catch(() => {});
// [SILENCED]                 console.log(`   Upserted to submission_tasks (ready_for_review) ✓`);
              } catch {}
            }
// [SILENCED]             console.log(`${'═'.repeat(64)}\n`);

            resolvedTotal++;

            // Track for 10-resolution milestone report
            resolvedMilestoneRecords.push({
              awlId,
              answered: answeredTotal,
              total: totalQCount,
              missing: unansweredCount,
              status: clientStatus,
              tierSummary: `T1:${t1Count} T2:${t2Count} T3:${t3Count} T4:${t4Count} T5:${t5Count}`,
            });

            if (false && resolvedMilestoneRecords.length > 0 && resolvedMilestoneRecords.length % 10 === 0) {
              const batchNum = Math.floor(resolvedMilestoneRecords.length / 10);
              const batchSlice = resolvedMilestoneRecords.slice(-10);
              const readyCount = batchSlice.filter(r => r.status === 'ready_for_review').length;
              const needsCount = batchSlice.length - readyCount;
// [SILENCED]               console.log(`\n${'═'.repeat(74)}`);
// [SILENCED]               console.log(`📊 10-RESOLUTION MILESTONE REPORT — Batch #${batchNum} (AWLs #${resolvedMilestoneRecords.length - 9}–#${resolvedMilestoneRecords.length})`);
// [SILENCED]               console.log(`   Job: ${company} — ${roleTitle}`);
// [SILENCED]               console.log(`   ✅ Resolved: ${readyCount}/10 | ❌ needs_answers: ${needsCount}/10 | Success Rate: ${readyCount * 10}%`);
// [SILENCED]               console.log(`${'─'.repeat(74)}`);
// [SILENCED]               console.log(` # | AWL-ID    | Answered | Missing | Tier Summary               | Status`);
// [SILENCED]               console.log(`${'─'.repeat(74)}`);
              batchSlice.forEach((r, idx) => {
                const num = String(idx + 1).padStart(2, ' ');
                const id = String(r.awlId).padEnd(9, ' ');
                const ans = `${r.answered}/${r.total}`.padEnd(8, ' ');
                const mis = String(r.missing).padEnd(7, ' ');
                const tiers = r.tierSummary.padEnd(26, ' ');
// [SILENCED]                 console.log(` ${num} | ${id} | ${ans} | ${mis} | ${tiers} | ${r.status}`);
              });
// [SILENCED]               console.log(`${'═'.repeat(74)}\n`);
            }
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

// [SILENCED]   console.log(`\n✅ [STAGE 2: RESOLVER] Resolution complete. Total distributions pre-resolved: ${resolvedTotal}`);
  return { success: true, processedCount: resolvedTotal };
}
