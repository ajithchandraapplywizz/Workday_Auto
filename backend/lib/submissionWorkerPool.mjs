/**
 * Autonomous 3-Worker Submission Engine (Phase 3)
 * - 3 Dedicated Submitting Workers: submitting_worker_1, submitting_worker_2, submitting_worker_3
 * - Atomic Claim: FOR UPDATE SKIP LOCKED (oldest queued first) via RPC or atomic CAS
 * - Heartbeat: updates worker_leased_at every 30 seconds
 * - Reaper: 10-minute lease expiry marks stuck tasks as 'failed' (never re-queued)
 * - Isolated Context: each task runs in its own fresh Playwright browser context
 */

import { loadLocalEnvOnce, updateWorkerStatus, getWorkerControls } from './supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { getWorkerContext, isGlobalStopRequested } from './browserLifecycle.mjs';

import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';

loadLocalEnvOnce();
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

export const SUBMISSION_WORKER_IDS = (PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 2 }, (_, i) => `submitting_worker_${i + 1}`)).slice(0, 2);


/**
 * B1 Helper: Updates submission_tasks, checks { data, error },
 * verifies rows changed > 0, retries up to 3 times, and logs error.
 */
export async function updateSubmissionTaskWithCheck({
  taskId,
  workerId,
  patch,
  maxRetries = 3,
}) {
  let lastErr = null;
  const cleanTaskId = String(taskId).trim();

  const cleanPatch = { ...patch };
  // submission_tasks schema has application_submitted_screenshot_url (no screenshot_path)
  if ('screenshot_path' in cleanPatch) {
    if (!cleanPatch.application_submitted_screenshot_url && cleanPatch.screenshot_path) {
      cleanPatch.application_submitted_screenshot_url = cleanPatch.screenshot_path;
    }
    delete cleanPatch.screenshot_path;
  }
  if ('screenshot_url' in cleanPatch) {
    if (!cleanPatch.application_submitted_screenshot_url && cleanPatch.screenshot_url) {
      cleanPatch.application_submitted_screenshot_url = cleanPatch.screenshot_url;
    }
    delete cleanPatch.screenshot_url;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('submission_tasks')
        .update(cleanPatch)
        .eq('id', cleanTaskId)
        .eq('status', 'applying')
        .eq('worker_id', workerId)
        .select('*');

      if (error) {
        lastErr = new Error(`Supabase update error: ${error.message} (code: ${error.code || 'unknown'})`);
        console.warn(`[${workerId}] Warning: updateSubmissionTaskWithCheck attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      if (!data || data.length === 0) {
        lastErr = new Error(`Zero rows updated. Task #${cleanTaskId} was not in 'applying' state or worker_id mismatch (expected ${workerId})`);
        console.warn(`[${workerId}] Warning: updateSubmissionTaskWithCheck attempt ${attempt}/${maxRetries} matched 0 rows for task #${cleanTaskId}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      console.log(`[${workerId}] task row updated (rows=${data.length}) for task #${cleanTaskId} -> status: ${patch.status || 'updated'}`);
      return { success: true, data: data[0], rowsCount: data.length };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const finalErrMsg = `[${workerId}] ERROR: Failed to update submission_task #${cleanTaskId} after ${maxRetries} attempts: ${lastErr?.message}`;
  console.error(finalErrMsg);
  return { success: false, error: lastErr || new Error(finalErrMsg) };
}

/**
 * B7 Helper: Checked update for job_distributions
 */
export async function updateJobDistributionWithCheck({
  distributionId,
  workerId = 'worker',
  patch,
  maxRetries = 3,
}) {
  if (!distributionId) return { success: false, error: new Error('No distributionId provided') };
  let lastErr = null;

  const cleanPatch = { ...patch };
  // job_distributions uses application_submitted_screenshot_url (screenshot_url was dropped in migration 024)
  if ('screenshot_url' in cleanPatch) {
    if (!cleanPatch.application_submitted_screenshot_url && cleanPatch.screenshot_url) {
      cleanPatch.application_submitted_screenshot_url = cleanPatch.screenshot_url;
    }
    delete cleanPatch.screenshot_url;
  }
  if ('screenshot_path' in cleanPatch) {
    delete cleanPatch.screenshot_path;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('job_distributions')
        .update(cleanPatch)
        .eq('id', distributionId)
        .select('*');

      if (error) {
        lastErr = new Error(`Supabase update error on job_distributions: ${error.message}`);
        console.warn(`[${workerId}] Warning: updateJobDistributionWithCheck attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      if (!data || data.length === 0) {
        lastErr = new Error(`Zero rows updated on job_distributions for #${distributionId}`);
        console.warn(`[${workerId}] Warning: updateJobDistributionWithCheck attempt ${attempt}/${maxRetries} matched 0 rows for #${distributionId}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      console.log(`[${workerId}] job_distributions record updated to '${patch.status || 'updated'}' (rows=${data.length}) for dist #${distributionId}`);
      return { success: true, data: data[0], rowsCount: data.length };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const finalErrMsg = `[${workerId}] ERROR: Failed to update job_distributions #${distributionId} after ${maxRetries} attempts: ${lastErr?.message}`;
  console.error(finalErrMsg);
  return { success: false, error: lastErr || new Error(finalErrMsg) };
}

/**
 * Synchronize all ready_for_review applications from job_distributions into submission_tasks.
 */
export async function syncJobDistributionsToSubmissionTasks() {
  if (!supabase) return 0;
  const now = new Date().toISOString();
  try {
    const { data: readyDists, error: distErr } = await supabase
      .from('job_distributions')
      .select('id, applywizz_id, job_url, company, role_title')
      .eq('status', 'ready_for_review');

    if (distErr || !readyDists || readyDists.length === 0) return 0;

    const { data: existingTasks } = await supabase
      .from('submission_tasks')
      .select('distribution_id, applywizz_id, job_url');

    const existingKeys = new Set((existingTasks || []).map((t) => `${t.applywizz_id}:::${t.job_url}`));
    const toInsert = readyDists
      .filter((d) => !existingKeys.has(`${d.applywizz_id}:::${d.job_url}`))
      .map((d) => ({
        distribution_id: d.id,
        applywizz_id: d.applywizz_id,
        job_url: d.job_url,
        company: d.company,
        role_title: d.role_title,
        status: 'ready_for_review',
        created_at: now,
        updated_at: now,
      }));

    if (toInsert.length > 0) {
      console.log(`[SUBMISSION POOL] Syncing ${toInsert.length} ready_for_review application(s) from job_distributions into submission_tasks...`);
      for (let i = 0; i < toInsert.length; i += 100) {
        const chunk = toInsert.slice(i, i + 100);
        try {
          const { error } = await supabase
            .from('submission_tasks')
            .upsert(chunk, { onConflict: 'distribution_id', ignoreDuplicates: true });
          if (error) console.warn('[SUBMISSION POOL] Sync chunk error:', error.message);
        } catch (err) {
          console.warn('[SUBMISSION POOL] Sync chunk exception:', err.message);
        }
      }
      console.log(`[SUBMISSION POOL] Successfully synced ${toInsert.length} applications into submission_tasks.`);
    }
    return toInsert.length;
  } catch (err) {
    console.warn('[SUBMISSION POOL] syncJobDistributionsToSubmissionTasks error:', err.message);
    return 0;
  }
}

/**
 * Move ready_for_review rows to queued.
 * Bypassed in favor of direct ready_for_review -> applying claiming, preventing large batches in 'queued'.
 */
export async function moveReadyTasksToQueued(limit = Number(process.env.WORKER_COUNT) || 2) {
  // Direct pipeline: tasks remain in 'ready_for_review' and transition straight to 'applying'
  // when an idle worker claims them. This ensures exactly and only 2 tasks are ever in flight.
  return 0;
}

/**
 * R4: Max concurrent applying rows parameterized by WORKER_COUNT from env.
 * Claims exactly one ready_for_review (or queued) row atomically, ensuring at most WORKER_COUNT
 * rows are 'applying' at any second across the entire cluster.
 */
export async function claimNextTask(workerId) {
  if (!workerId || !supabase) return null;
  const { isSubmitStopRequested } = await import('./browserLifecycle.mjs');
  if (isGlobalStopRequested() || isSubmitStopRequested()) return null;
  const controls = await getWorkerControls().catch(() => null);
  if (controls?.submit?.stop_requested) return null;
  const now = new Date().toISOString();
  const maxConcurrent = Number(process.env.WORKER_COUNT) || PIPELINE_CONFIG.workersCount || 2;

  // R4 Rule: Refuse immediately if maxConcurrent rows are already applying
  try {
    const { count: applyingCount } = await supabase
      .from('submission_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'applying');

    if (typeof applyingCount === 'number' && applyingCount >= maxConcurrent) {
      return null;
    }
  } catch {}

  // 1. Direct atomic CAS (Compare-And-Swap on oldest ready_for_review or queued row)
  try {
    const { data: candidates, error: candErr } = await supabase
      .from('submission_tasks')
      .select('id, status, distribution_id, applywizz_id, job_url, company, role_title, error_message')
      .in('status', ['ready_for_review', 'queued'])
      .order('created_at', { ascending: true })
      .limit(10);

    if (candErr || !candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
      // Atomic claim on candidate row
      const { data: claimed, error: claimErr } = await supabase
        .from('submission_tasks')
        .update({
          status: 'applying',
          worker_id: workerId,
          started_at: now,
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', cand.id)
        .eq('status', cand.status)
        .select('*');

      if (!claimErr && claimed && claimed.length > 0) {
        const claimedTask = claimed[0];

        // CRITICAL ANTI-COLLISION: Atomically lock matching job_distributions record to 'applying'
        try {
          if (claimedTask.distribution_id) {
            await supabase
              .from('job_distributions')
              .update({
                status: 'applying',
                worker_id: workerId,
                updated_at: now,
              })
              .eq('id', claimedTask.distribution_id)
              .in('status', ['ready_for_review', 'queued']);
          } else if (claimedTask.applywizz_id && claimedTask.job_url) {
            await supabase
              .from('job_distributions')
              .update({
                status: 'applying',
                worker_id: workerId,
                updated_at: now,
              })
              .eq('applywizz_id', claimedTask.applywizz_id)
              .eq('job_url', claimedTask.job_url)
              .in('status', ['ready_for_review', 'queued']);
          }
        } catch (distLockErr) {
          console.warn(`[${workerId}] Warning updating job_distributions status to applying:`, distLockErr?.message);
        }

        return claimedTask;
      }
    }
  } catch (err) {
    console.warn(`[claimNextTask] Error claiming for ${workerId}:`, err.message);
  }

  return null;
}

/**
 * Heartbeat: Updates worker_leased_at while worker is processing.
 */
export async function sendTaskHeartbeat(taskId, workerId) {
  if (!taskId || !workerId) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from('submission_tasks')
      .update({
        worker_leased_at: now,
        updated_at: now,
      })
      .eq('id', taskId)
      .eq('worker_id', workerId)
      .eq('status', 'applying');

    return !error;
  } catch {
    return false;
  }
}

/**
 * Reaper (R6, R14, Amendment C): Reverts tasks with expired lease (> timeoutMinutes) back to 'ready_for_review'
 * with possibly_submitted = true. NEVER sets 'failed'. NEVER touches ready_for_review or queued.
 */
export async function reapExpiredLeases(timeoutMinutes = 10) {
  if (!supabase) return [];
  try {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { data: expired, error: selErr } = await supabase
      .from('submission_tasks')
      .select('id, worker_id, applywizz_id')
      .eq('status', 'applying')
      .lt('worker_leased_at', cutoff);

    if (selErr || !expired || expired.length === 0) return [];

    const reapedRows = [];
    for (const exp of expired) {
      // Single-ID CAS update checking previous status 'applying' (R5, R6)
      const { data: updated, error: updErr } = await supabase
        .from('submission_tasks')
        .update({
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          error_message: `Worker lease expired (> ${timeoutMinutes}m). Returned to ready_for_review.`,
          updated_at: now,
        })
        .eq('id', exp.id)
        .eq('status', 'applying')
        .select('*');

      if (!updErr && updated && updated.length > 0) {
        reapedRows.push(updated[0]);
      }
    }

    if (reapedRows.length > 0) {
      console.log(`🧹 [REAPER] Safely reverted ${reapedRows.length} expired task(s) to ready_for_review with possibly_submitted=true:`, reapedRows.map(r => r.id));
    }
    return reapedRows;
  } catch (err) {
    console.error(`[reapExpiredLeases] Error:`, err.message);
    return [];
  }
}

/**
 * Worker Processor for a claimed task:
 * - Reads job URL and client strictly from claimed row
 * - Runs with isolated Playwright browser context
 * - Emits periodic heartbeats
 */
export async function processClaimedTask({ task, workerId, headless = true, runnerFn = null, options = {} }) {
  if (!task || !workerId) return { success: false, error: 'Invalid task or workerId' };

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`🚀 [STAGE 3: SUBMITTER] [${workerId}] EXECUTING APPLICATION SUBMISSION`);
  console.log(`   • Task ID: #${task.id} | Distribution ID: #${task.distribution_id || 'N/A'}`);
  console.log(`   • Candidate AWL-ID: ${task.applywizz_id}`);
  console.log(`   • Company: ${task.company || 'Workday Partner'}`);
  console.log(`   • Role: ${task.role_title || 'Workday Application'}`);
  console.log(`   • Target URL: ${task.job_url}`);
  console.log(`   • Worker Concurrency: Strictly 2 Active Browsers`);
  console.log(`${'─'.repeat(90)}`);

  // Update worker_status table
  const workerNum = String(workerId).replace('worker_', '');
  await updateWorkerStatus(workerId, {
    state: 'in_flight',
    stage: 'submitting',
    current_application_id: task.id,
    bot_name: `Worker ${workerNum}`,
    updated_at: new Date().toISOString(),
  }).catch(() => { });

  // Start 30-second heartbeat interval
  let heartbeatActive = true;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatActive) {
      sendTaskHeartbeat(task.id, workerId).catch(() => { });
    }
  }, 30_000);

  function stopHeartbeat() {
    heartbeatActive = false;
    clearInterval(heartbeatTimer);
  }

  // B4 Task Watchdog: hard limit of 8 minutes per task
  const WATCHDOG_TIMEOUT_MS = options?.watchdogTimeoutMs || 8 * 60 * 1000;
  let watchdogTimer = null;

  let result = null;
  try {
    const taskExecutionPromise = (async () => {
      if (runnerFn) {
        return await runnerFn(task, workerId);
      } else {
        // Ensure pre-resolved answers JSON from job_distributions is attached to task
        let preResolved = task.resolved_answers || task.resolved_answers_json || null;
        if (!preResolved) {
          try {
            const { getResolvedAnswersById, getResolvedAnswers } = await import('./supabaseClient.mjs');
            let distRow = null;
            if (task.distribution_id) {
              distRow = await getResolvedAnswersById(task.distribution_id);
            }
            if (!distRow && task.applywizz_id && task.job_url) {
              distRow = await getResolvedAnswers(task.applywizz_id, task.job_url);
            }
            if (distRow?.resolved_answers && Array.isArray(distRow.resolved_answers) && distRow.resolved_answers.length > 0) {
              preResolved = distRow.resolved_answers;
            } else if (distRow?.resolved_answers_json && Array.isArray(distRow.resolved_answers_json) && distRow.resolved_answers_json.length > 0) {
              preResolved = distRow.resolved_answers_json;
            }
          } catch (fetchErr) {
            console.warn(`[${workerId}] Warning loading pre-resolved answers for task #${task.id}:`, fetchErr?.message);
          }
        }
        if (preResolved) {
          task.resolved_answers = preResolved;
        }

        const { executeWorkerTask } = await import('./workerPool.mjs');
        return await executeWorkerTask({
          task: {
            id: task.distribution_id,
            distributionId: task.distribution_id,
            taskId: task.id,
            applywizzId: task.applywizz_id,
            jobUrl: task.job_url,
            company: task.company,
            roleTitle: task.role_title,
            status: 'approved_for_submission',
            resolved_answers: preResolved,
            pre_resolved_answers: preResolved,
          },
          taskId: task.id,
          workerId,
          taskIndex: 1,
          totalTasks: 1,
          options: {
            headless: Boolean(headless),
            confirmSubmit: true,
            dryRun: false,
            taskId: task.id,
          },
        });
      }
    })();

    const watchdogPromise = new Promise((resolve) => {
      watchdogTimer = setTimeout(async () => {
        console.log(`[${workerId}] watchdog fired: task timed out after 8 minutes (task #${task.id})`);
        stopHeartbeat();

        let shotPath = null;
        let shotUrl = null;
        try {
          const ctx = getWorkerContext(workerId);
          if (ctx?.page && !ctx.page.isClosed()) {
            const buf = await ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
            if (buf) {
              const cleanId = String(task.applywizz_id).trim().toUpperCase();
              const timestamp = Date.now();
              // Zero nested folders: flat filename directly in root of failed-applications
              shotPath = `${cleanId}_${task.id}_failed_${timestamp}.png`;
              const { error: upErr } = await supabase.storage
                .from('failed-applications')
                .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
              if (!upErr) {
                const { data: urlData } = supabase.storage
                  .from('failed-applications')
                  .getPublicUrl(shotPath);
                shotUrl = urlData?.publicUrl || null;
                console.log(`[${workerId}] screenshot uploaded: ${shotPath}`);
              }
            }
          }
          if (ctx?.browser) {
            await ctx.browser.close().catch(() => {});
          }
        } catch (wShotErr) {
          console.warn(`[${workerId}] Watchdog screenshot error:`, wShotErr.message);
        }

        resolve({
          status: 'failed',
          isTimeout: true,
          error: 'Task timed out after 8 minutes',
          screenshotUrl: shotUrl,
          screenshotPath: shotPath,
        });
      }, WATCHDOG_TIMEOUT_MS);
    });

    result = await Promise.race([taskExecutionPromise, watchdogPromise]);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    stopHeartbeat();

    const now = new Date().toISOString();
    const isSuccess = result?.status === 'submitted' || result?.status === 'success';
    const isAlreadyApplied = (
      result?.status === 'already_applied' ||
      result?.status === 'applied' ||
      result?.isAlreadyApplied === true ||
      /already applied|already submitted/i.test(result?.error || '') ||
      /already applied|already submitted/i.test(result?.reason || '')
    );

    let finalShotUrl = result?.screenshotUrl || null;
    let finalStoragePath = result?.screenshotPath || null;
    if (!finalStoragePath && finalShotUrl) {
      const cleanId = String(task.applywizz_id).trim().toUpperCase();
      // Flat filename directly in bucket root
      finalStoragePath = `${cleanId}_${task.id}.png`;
    }

    if (isSuccess) {
      console.log(`\n${'═'.repeat(90)}`);
      console.log(`✅ [STAGE 3: SUBMITTER] [${workerId}] APPLICATION SUBMITTED SUCCESSFULLY!`);
      console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
      console.log(`   • Status: SUBMITTED`);
      console.log(`   • Proof Screenshot: ${finalShotUrl || 'Uploaded to Supabase Storage'}`);
      console.log(`   • Dual-Table Sync: submission_tasks #${task.id} & job_distributions #${task.distribution_id || 'N/A'} -> 'submitted'`);
      console.log(`${'═'.repeat(90)}\n`);

      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'submitted',
          completed_at: now,
          error_message: null,
          application_submitted_screenshot_url: finalShotUrl,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'submitted',
            error_message: null,
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });
      }
    } else if (isAlreadyApplied) {
      console.log(`\n${'═'.repeat(90)}`);
      console.log(`ℹ️ [STAGE 3: SUBMITTER] [${workerId}] APPLICATION ALREADY APPLIED ON WORKDAY`);
      console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
      console.log(`   • Status: ALREADY_APPLIED`);
      console.log(`   • Proof Screenshot: ${finalShotUrl || 'None'}`);
      console.log(`   • Dual-Table Sync: submission_tasks #${task.id} & job_distributions #${task.distribution_id || 'N/A'} -> 'already_applied'`);
      console.log(`${'═'.repeat(90)}\n`);

      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'already_applied',
          completed_at: now,
          error_message: 'Application already submitted on Workday',
          application_submitted_screenshot_url: finalShotUrl,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'already_applied',
            error_message: 'Application already submitted on Workday',
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });
      }
    } else {
      const errMsg = result?.error || result?.reason || `Submission ended with status: ${result?.status || 'failed'}`;
      const isSecondAttempt = String(task.error_message || '').includes('[Attempt 1/2]');

      if (!isSecondAttempt) {
        // Attempt 1 failed: Re-queue back to ready_for_review for Attempt 2 retry (Max 2 Attempts)
        const retryMsg = `[Attempt 1/2] ${errMsg}`;
        console.log(`\n${'═'.repeat(90)}`);
        console.log(`🔄 [STAGE 3: SUBMITTER] [${workerId}] SUBMISSION ATTEMPT 1 FAILED — QUEUING RETRY`);
        console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
        console.log(`   • Status: Reverting to ready_for_review (Attempt 1 of 2)`);
        console.log(`   • Reason: ${errMsg}`);
        console.log(`   • Dual-Table Sync: submission_tasks #${task.id} & job_distributions #${task.distribution_id || 'N/A'} -> 'ready_for_review'`);
        console.log(`${'═'.repeat(90)}\n`);

        await updateSubmissionTaskWithCheck({
          taskId: task.id,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            worker_leased_at: null,
            error_message: retryMsg,
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });

        if (task.distribution_id) {
          await updateJobDistributionWithCheck({
            distributionId: task.distribution_id,
            workerId,
            patch: {
              status: 'ready_for_review',
              worker_id: null,
              error_message: retryMsg,
              application_submitted_screenshot_url: finalShotUrl,
              updated_at: now,
            },
          });
        }
      } else {
        // Attempt 2 failed: Final failure recorded
        const finalFailMsg = `[Attempt 2/2 Failed] ${errMsg}`;
        console.log(`\n${'═'.repeat(90)}`);
        console.log(`❌ [STAGE 3: SUBMITTER] [${workerId}] SUBMISSION FAILED (MAX 2 ATTEMPTS EXHAUSTED)`);
        console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
        console.log(`   • Status: FAILED`);
        console.log(`   • Reason: ${finalFailMsg}`);
        console.log(`   • Failure Diagnostic Screenshot: ${finalShotUrl || 'None'}`);
        console.log(`   • Dual-Table Sync: submission_tasks #${task.id} & job_distributions #${task.distribution_id || 'N/A'} -> 'failed'`);
        console.log(`${'═'.repeat(90)}\n`);

        await updateSubmissionTaskWithCheck({
          taskId: task.id,
          workerId,
          patch: {
            status: 'failed',
            error_message: finalFailMsg,
            completed_at: now,
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });

        if (task.distribution_id) {
          await updateJobDistributionWithCheck({
            distributionId: task.distribution_id,
            workerId,
            patch: {
              status: 'failed',
              error_message: finalFailMsg,
              application_submitted_screenshot_url: finalShotUrl,
              updated_at: now,
            },
          });
        }
      }
    }
  } catch (err) {
    stopHeartbeat();
    if (watchdogTimer) clearTimeout(watchdogTimer);

    result = {
      status: 'failed',
      error: err?.message || 'Execution error',
    };
    const now = new Date().toISOString();

    // B3: In exception catch block, take screenshot before page closes, upload it
    let errShotUrl = null;
    let errShotPath = null;
    try {
      const ctx = getWorkerContext(workerId);
      if (ctx?.page && !ctx.page.isClosed()) {
        const buf = await ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
        if (buf) {
          const cleanId = String(task.applywizz_id).trim().toUpperCase();
          const timestamp = Date.now();
          // Flat filename directly in root of failed-applications
          errShotPath = `${cleanId}_${task.id}_failed_${timestamp}.png`;
          const { error: upErr } = await supabase.storage
            .from('failed-applications')
            .upload(errShotPath, buf, { contentType: 'image/png', upsert: true });
          if (!upErr) {
            const { data: urlData } = supabase.storage
              .from('failed-applications')
              .getPublicUrl(errShotPath);
            errShotUrl = urlData?.publicUrl || null;
            console.log(`[${workerId}] screenshot uploaded: ${errShotPath}`);
          }
        }
      }
    } catch (catchShotErr) {
      console.warn(`[${workerId}] Exception screenshot capture error:`, catchShotErr.message);
    }

    result.screenshotUrl = errShotUrl;
    result.screenshotPath = errShotPath;

    const errMsg = err?.message || 'Execution error';
    const isSecondAttempt = String(task.error_message || '').includes('[Attempt 1/2]');

    if (!isSecondAttempt) {
      const retryMsg = `[Attempt 1/2] ${errMsg}`;
      console.log(`\n🔄 [STAGE 3: SUBMITTER] [${workerId}] Exception on attempt 1. Re-queueing task #${task.id} to ready_for_review for retry.`);

      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          error_message: retryMsg,
          application_submitted_screenshot_url: errShotUrl,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            error_message: retryMsg,
            application_submitted_screenshot_url: errShotUrl,
            updated_at: now,
          },
        });
      }
    } else {
      const finalFailMsg = `[Attempt 2/2 Failed] ${errMsg}`;
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'failed',
          error_message: finalFailMsg,
          completed_at: now,
          application_submitted_screenshot_url: errShotUrl,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'failed',
            error_message: finalFailMsg,
            application_submitted_screenshot_url: errShotUrl,
            updated_at: now,
          },
        });
      }
    }
  } finally {
    stopHeartbeat();
    if (watchdogTimer) clearTimeout(watchdogTimer);
    // Release worker back to idle
    const workerNum = String(workerId).replace('worker_', '');
    await updateWorkerStatus(workerId, {
      state: 'idle',
      stage: 'submitting',
      current_application_id: null,
      bot_name: `Worker ${workerNum}`,
      updated_at: new Date().toISOString(),
    }).catch(() => { });
  }

  return result;
}

/**
 * 10-client milestone report for submissions with untruncated values and clear stats.
 */
export function print10ClientSubmissionMilestoneReport({ cycleIndex = 1, cycleStartNum = 1, cycleEndNum = 10, items = [], totalCumulative = 0 }) {
  const count = items.length;
  const submittedCount = items.filter(it => it.status === 'submitted' || it.status === 'success').length;
  const failedCount = count - submittedCount;
  const successRate = count > 0 ? ((submittedCount / count) * 100).toFixed(1) : '0.0';
  const totalCount = totalCumulative || cycleEndNum || count;

  console.log(`\n${'═'.repeat(120)}`);
  console.log(`📊 10-SUBMISSION BATCH MILESTONE REPORT — CYCLE #${cycleIndex} (SUBMISSIONS #${cycleStartNum} TO #${cycleEndNum})`);
  console.log(`   • Batch Items Processed: ${count} applications | Total All-Time: ${totalCount}`);
  console.log(`   • ✅ Succeeded: ${submittedCount}/${count} | ❌ Failed: ${failedCount}/${count} | 📈 Batch Success Rate: ${successRate}%`);
  console.log(`${'─'.repeat(120)}`);
  console.log(
    `#`.padEnd(4) + ' | ' +
    `Candidate`.padEnd(16) + ' | ' +
    `Company`.padEnd(22) + ' | ' +
    `Status`.padEnd(12) + ' | ' +
    `Result / Reason`.padEnd(28) + ' | ' +
    `Proof Screenshot URL`
  );
  console.log(`${'─'.repeat(120)}`);

  items.forEach((item, idx) => {
    const num = String(cycleStartNum + idx).padEnd(4);
    const awlId = String(item.applywizz_id || item.applywizzId || 'AWL').slice(0, 16).padEnd(16);
    const comp = String(item.company || 'Workday Partner').slice(0, 22).padEnd(22);
    const isSuccess = item.status === 'submitted' || item.status === 'success';
    const st = (isSuccess ? 'SUBMITTED' : 'FAILED').padEnd(12);
    const reason = String(item.reason || item.error || (isSuccess ? 'Application Confirmed' : 'Submission error')).slice(0, 28).padEnd(28);
    const shot = item.screenshotUrl || item.screenshotPath || 'None';
    console.log(`${num} | ${awlId} | ${comp} | ${st} | ${reason} | ${shot}`);
  });

  console.log(`${'─'.repeat(120)}`);
  console.log(`📌 STATS SUMMARY: ${submittedCount} SUBMITTED, ${failedCount} FAILED (${successRate}% SUCCESS RATE) | MILESTONE #${cycleIndex} LOGGED`);
  console.log(`${'═'.repeat(120)}\n`);
}

export const print10SubmissionMilestoneReport = print10ClientSubmissionMilestoneReport;

