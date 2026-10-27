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

export const SUBMISSION_WORKER_IDS = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 2 }, (_, i) => `worker_${i + 1}`);


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
  if ('application_submitted_screenshot_url' in cleanPatch) {
    if (!cleanPatch.screenshot_path && cleanPatch.application_submitted_screenshot_url) {
      cleanPatch.screenshot_path = cleanPatch.application_submitted_screenshot_url;
    }
    delete cleanPatch.application_submitted_screenshot_url;
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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('job_distributions')
        .update(patch)
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
 * Move ready_for_review rows to queued (up to limit, R4 / Phase 2)
 * Phase 1 Guard (R1, R3b): Submit is fully disabled until Phase 2.
 * Nothing may move ready_for_review -> queued automatically.
 */
export async function moveReadyTasksToQueued(limit = Number(process.env.WORKER_COUNT) || 2) {
  // Phase 1: Submit is fully disabled until Phase 2 manual Submit toggle is active.
  return 0;
}

/**
 * R4: Max concurrent applying rows parameterized by WORKER_COUNT from env.
 * The claim is ONE atomic call (FOR UPDATE SKIP LOCKED) that takes exactly one `queued` row
 * and refuses when WORKER_COUNT rows are applying.
 */
export async function claimNextTask(workerId) {
  if (!workerId || !supabase) return null;
  const { isSubmitStopRequested } = await import('./browserLifecycle.mjs');
  if (isGlobalStopRequested() || isSubmitStopRequested()) return null;
  const controls = await getWorkerControls().catch(() => null);
  if (controls?.submit?.stop_requested) return null;
  const now = new Date().toISOString();
  const maxConcurrent = Number(process.env.WORKER_COUNT) || PIPELINE_CONFIG.workersCount || 2;

  // R4 Rule: Refuse immediately if WORKER_COUNT rows are already applying
  try {
    const { count: applyingCount } = await supabase
      .from('submission_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'applying');

    if (typeof applyingCount === 'number' && applyingCount >= maxConcurrent) {
      return null;
    }
  } catch {}

  // 1. Try PostgreSQL RPC (guarantees DB-level FOR UPDATE SKIP LOCKED & refusal when maxConcurrent applying)
  try {
    const { data: rpcRows, error: rpcErr } = await supabase
      .rpc('claim_next_submission_task', { p_worker_id: workerId, p_max_concurrent: maxConcurrent });

    if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length > 0) {
      return rpcRows[0];
    }
  } catch { }

  // 2. Direct atomic fallback (CAS: Compare-And-Swap on oldest strictly queued row)
  try {
    const { data: candidates } = await supabase
      .from('submission_tasks')
      .select('id, status')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(10);

    if (!candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
      // Atomic claim on queued row
      const { data: claimed, error: claimErr } = await supabase
        .from('submission_tasks')
        .update({
          status: 'applying',
          status_actor: 'system',
          worker_id: workerId,
          started_at: now,
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', cand.id)
        .eq('status', 'queued')
        .select('*');

      if (!claimErr && claimed && claimed.length > 0) {
        return claimed[0];
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
          status_actor: 'reaper',
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

  console.log(`\n🚀 [${workerId}] Processing task #${task.id} (${task.applywizz_id} @ ${task.company || 'Company'})...`);

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
              shotPath = `${cleanId}/${task.id}_failed_${timestamp}.png`;
              const { error: upErr } = await supabase.storage
                .from('submitted-applications')
                .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
              if (!upErr) {
                const { data: urlData } = supabase.storage
                  .from('submitted-applications')
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

    let finalShotUrl = result?.screenshotUrl || result?.reviewScreenshotUrl || null;
    let finalStoragePath = result?.screenshotPath || null;
    if (!finalStoragePath && finalShotUrl) {
      const cleanId = String(task.applywizz_id).trim().toUpperCase();
      finalStoragePath = `${cleanId}/${task.id}.png`;
    }

    if (isSuccess) {
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'submitted',
          status_actor: 'system',
          completed_at: now,
          application_submitted_screenshot_url: finalShotUrl,
          screenshot_path: finalStoragePath,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'submitted',
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });
      }
    } else {
      const errMsg = result?.error || result?.reason || `Submission ended with status: ${result?.status || 'failed'}`;
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'failed',
          status_actor: 'system',
          error_message: errMsg,
          completed_at: now,
          application_submitted_screenshot_url: finalShotUrl,
          screenshot_path: finalStoragePath,
          review_flag: (!finalShotUrl && !finalStoragePath) ? 'screenshot_capture_failed' : null,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'failed',
            error_message: errMsg,
            application_submitted_screenshot_url: finalShotUrl,
            updated_at: now,
          },
        });
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
          errShotPath = `${cleanId}/${task.id}_failed_${timestamp}.png`;
          const { error: upErr } = await supabase.storage
            .from('submitted-applications')
            .upload(errShotPath, buf, { contentType: 'image/png', upsert: true });
          if (!upErr) {
            const { data: urlData } = supabase.storage
              .from('submitted-applications')
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

    await updateSubmissionTaskWithCheck({
      taskId: task.id,
      workerId,
      patch: {
        status: 'failed',
        status_actor: 'system',
        error_message: err?.message || 'Execution error',
        completed_at: now,
        application_submitted_screenshot_url: errShotUrl,
        screenshot_path: errShotPath,
        review_flag: (!errShotUrl && !errShotPath) ? 'screenshot_capture_failed' : null,
        updated_at: now,
      },
    });

    if (task.distribution_id) {
      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id,
        workerId,
        patch: {
          status: 'failed',
          error_message: err?.message || 'Execution error',
          application_submitted_screenshot_url: errShotUrl,
          updated_at: now,
        },
      });
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

