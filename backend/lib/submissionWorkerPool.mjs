/**
 * Autonomous 3-Worker Submission Engine (Phase 3)
 * - 3 Dedicated Submitting Workers: submitting_worker_1, submitting_worker_2, submitting_worker_3
 * - Atomic Claim: FOR UPDATE SKIP LOCKED (oldest queued first) via RPC or atomic CAS
 * - Heartbeat: updates worker_leased_at every 30 seconds
 * - Reaper: 10-minute lease expiry marks stuck tasks as 'failed' (never re-queued)
 * - Isolated Context: each task runs in its own fresh Playwright browser context
 */

import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { updateWorkerStatus } from './supabaseClient.mjs';
import { getWorkerContext } from './browserLifecycle.mjs';
import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const SUBMISSION_WORKER_IDS = PIPELINE_CONFIG?.submitWorkerIds || [
  'submitting_worker_1',
  'submitting_worker_2',
  'submitting_worker_3',
];

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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('submission_tasks')
        .update(patch)
        .eq('id', cleanTaskId)
        .eq('status', 'applying')
        .eq('worker_id', workerId)
        .select('*');

      if (error) {
        if (error.code === '23514' && patch.status === 'already_applied') {
          console.warn(`[${workerId}] Warning: 'already_applied' check constraint pending migration. Falling back to status='submitted'.`);
          patch = { ...patch, status: 'submitted', error_message: patch.error_message || 'The application is already submitted' };
          continue;
        }
        lastErr = new Error(`Supabase update error: ${error.message} (code: ${error.code || 'unknown'})`);
        console.warn(`[${workerId}] Warning: updateSubmissionTaskWithCheck attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      if (!data || data.length === 0) {
        // Fallback: update by ID directly in case lease/status was altered during submission
        const { data: fallbackData, error: fbErr } = await supabase
          .from('submission_tasks')
          .update(patch)
          .eq('id', cleanTaskId)
          .select('*');

        if (fbErr?.code === '23514' && patch.status === 'already_applied') {
          console.warn(`[${workerId}] Warning: 'already_applied' check constraint pending migration. Falling back to status='submitted'.`);
          patch = { ...patch, status: 'submitted', error_message: patch.error_message || 'The application is already submitted' };
          continue;
        }

        if (!fbErr && fallbackData && fallbackData.length > 0) {
          console.log(`[${workerId}] task row updated via fallback (rows=${fallbackData.length}) for task #${cleanTaskId} -> status: ${patch.status || 'updated'}`);
          return { success: true, data: fallbackData[0], rowsCount: fallbackData.length };
        }

        lastErr = new Error(`Zero rows updated. Task #${cleanTaskId} not found or update rejected: ${fbErr?.message || 'not matched'}`);
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
 * Atomic Task Claim (FOR UPDATE SKIP LOCKED)
 * Sets applying, worker_id, started_at, worker_leased_at in the exact same statement.
 */
export async function claimNextTask(workerId) {
  if (!workerId) return null;
  const now = new Date().toISOString();

  // 1. Try PostgreSQL RPC (guarantees DB-level FOR UPDATE SKIP LOCKED)
  try {
    const { data: rpcRows, error: rpcErr } = await supabase
      .rpc('claim_next_submission_task', { p_worker_id: workerId });

    if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length > 0) {
      return rpcRows[0];
    }
  } catch { }

  // 2. Direct atomic fallback (CAS: Compare-And-Swap on oldest queued or ready_for_review row)
  try {
    const { data: candidates } = await supabase
      .from('submission_tasks')
      .select('id, status')
      .in('status', ['queued', 'ready_for_review'])
      .order('created_at', { ascending: true })
      .limit(10);

    if (!candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
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
 * Reaper: Marks tasks with expired lease (> timeoutMinutes) as 'failed'.
 * Never auto re-queues, preserving safety against duplicate submissions.
 */
export async function reapExpiredLeases(timeoutMinutes = 10) {
  // 1. Try PostgreSQL RPC
  try {
    const { data: reaped, error: rpcErr } = await supabase
      .rpc('reap_expired_submission_leases', { p_timeout_minutes: timeoutMinutes });

    if (!rpcErr && Array.isArray(reaped) && reaped.length > 0) {
      console.log(`🧹 [REAPER] Reaped ${reaped.length} expired task(s) via RPC.`);
      return reaped;
    }
  } catch { }

  // 2. Fallback direct query
  try {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { data: expired } = await supabase
      .from('submission_tasks')
      .select('id, worker_id, applywizz_id')
      .eq('status', 'applying')
      .lt('worker_leased_at', cutoff);

    if (!expired || expired.length === 0) return [];

    const reapedRows = [];
    for (const exp of expired) {
      const { data: updated } = await supabase
        .from('submission_tasks')
        .update({
          status: 'failed',
          error_message: `Worker lease expired (> ${timeoutMinutes} minutes). Possible worker process crash. Requires admin inspection.`,
          completed_at: now,
          updated_at: now,
        })
        .eq('id', exp.id)
        .eq('status', 'applying')
        .select('*');

      if (updated && updated.length > 0) {
        reapedRows.push(updated[0]);
      }
    }

    if (reapedRows.length > 0) {
      console.log(`🧹 [REAPER] Reaped ${reapedRows.length} expired task(s):`, reapedRows.map(r => r.id));
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

  // Hard stop check: Abort immediately before doing any work or launching browsers
  const { isGlobalStopRequested, isSubmitStopRequested } = await import('./browserLifecycle.mjs');
  if (isGlobalStopRequested() || isSubmitStopRequested()) {
    console.log(`🛑 [${workerId}] Stop signal active! Aborting task #${task.id} immediately and reverting to ready_for_review.`);
    await supabase
      .from('submission_tasks')
      .update({ status: 'ready_for_review', worker_id: null, updated_at: new Date().toISOString() })
      .eq('id', task.id);
    await updateWorkerStatus(workerId, {
      state: 'idle',
      stage: 'idle',
      current_application_id: null,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    return { status: 'stopped', error: 'Stopped by user' };
  }

  console.log(`\n🚀 [${workerId}] Processing task #${task.id} (${task.applywizz_id} @ ${task.company || 'Company'})...`);

  // Pre-flight check: Has candidate already submitted to this company?
  const cleanComp = String(task.company || '').trim();
  const cleanId = String(task.applywizz_id || '').trim().toUpperCase();
  if (cleanId && cleanComp && cleanComp !== 'Workday Employer' && cleanComp !== 'Workday') {
    const { hasClientAppliedToCompany } = await import('./supabaseClient.mjs');
    const alreadyApplied = await hasClientAppliedToCompany(cleanId, cleanComp, { excludeTaskId: task.id });
    if (alreadyApplied) {
      console.log(`⚡ [${workerId}] Pre-flight guard: Candidate ${cleanId} has ALREADY submitted an application to company "${cleanComp}". Skipping browser launch and marking already_applied.`);
      const now = new Date().toISOString();
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'already_applied',
          error_message: `Candidate has already submitted an application to ${cleanComp}`,
          completed_at: now,
          updated_at: now,
        },
      });
      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'already_applied',
            error_message: `Candidate has already submitted an application to ${cleanComp}`,
            updated_at: now,
          },
        });
      }
      return { status: 'already_applied', success: true };
    }
  }

  // Update worker_status table
  await updateWorkerStatus(workerId, {
    state: 'in_flight',
    stage: 'submitting',
    current_application_id: task.id,
    bot_name: `Submitting Worker ${workerId.slice(-1)}`,
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
              shotPath = `${cleanId}_${task.id}_failed_${timestamp}.png`;
              let upRes = await supabase.storage
                .from('failed-applications')
                .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
              let bucketUsed = 'failed-applications';
              if (upRes.error) {
                upRes = await supabase.storage
                  .from('submitted-applications')
                  .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
                bucketUsed = 'submitted-applications';
              }
              if (!upRes.error) {
                const { data: urlData } = supabase.storage
                  .from(bucketUsed)
                  .getPublicUrl(shotPath);
                shotUrl = urlData?.publicUrl || null;
                console.log(`[${workerId}] screenshot uploaded to ${bucketUsed}: ${shotPath}`);
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
      finalStoragePath = `${cleanId}_${task.id}.png`;
    }

    if (isSuccess) {
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'submitted',
          completed_at: now,
          application_submitted_screenshot_url: finalShotUrl || finalStoragePath,
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

      // Clean up local cached resume immediately after successful submission
      try {
        const { cleanupClientResume } = await import('./applyWizzResume.mjs');
        await cleanupClientResume({ _applyWizzId: task.applywizz_id, applywizz_id: task.applywizz_id });
      } catch {}
    } else if (result?.status === 'already_applied' || result?.alreadyApplied) {
      console.log(`✅ [${workerId}] Candidate ${task.applywizz_id} has ALREADY APPLIED to this job (${task.company}). Recording proof screenshot and setting status to 'already_applied'.`);
      const proofUrl = result?.screenshotUrl || finalShotUrl || finalStoragePath;
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'already_applied',
          completed_at: now,
          application_submitted_screenshot_url: proofUrl,
          error_message: null,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'already_applied',
            application_submitted_screenshot_url: proofUrl,
            error_message: null,
            updated_at: now,
          },
        });
      }

      try {
        const { cleanupClientResume } = await import('./applyWizzResume.mjs');
        await cleanupClientResume({ _applyWizzId: task.applywizz_id, applywizz_id: task.applywizz_id });
      } catch {}
    } else if (result?.status === 'job_expired' || result?.isExpired || result?.status === 'job_not_found') {
      const expiredReason = "Job link expired: The page you are looking for doesn't exist";
      console.log(`❌ [${workerId}] Job link expired for task #${task.id} (${task.company}): ${expiredReason}`);
      const expiredShot = result?.screenshotUrl || finalShotUrl || finalStoragePath;

      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'failed',
          error_message: expiredReason,
          completed_at: now,
          application_submitted_screenshot_url: expiredShot,
          updated_at: now,
        },
      });

      if (task.distribution_id) {
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id,
          workerId,
          patch: {
            status: 'failed',
            error_message: expiredReason,
            application_submitted_screenshot_url: expiredShot,
            updated_at: now,
          },
        });
      }

      try {
        const { recordFailedJob } = await import('./supabaseClient.mjs');
        await recordFailedJob({
          applywizzId: task.applywizz_id,
          jobId: task.job_id || null,
          jobUrl: task.job_url,
          company: task.company,
          roleTitle: task.role_title,
          failureReason: expiredReason,
          failedAtStep: 'Job link expired',
          screenshotPath: expiredShot,
        });
      } catch {}

      try {
        const { cleanupClientResume } = await import('./applyWizzResume.mjs');
        await cleanupClientResume({ _applyWizzId: task.applywizz_id, applywizz_id: task.applywizz_id });
      } catch {}
    } else if (
      result?.status === 'stopped' ||
      isGlobalStopRequested() ||
      isSubmitStopRequested() ||
      String(result?.error || result?.reason || '').toLowerCase().includes('closed') ||
      String(result?.error || result?.reason || '').toLowerCase().includes('abort') ||
      String(result?.error || result?.reason || '').toLowerCase().includes('target')
    ) {
      // User requested stop: Revert cleanly to ready_for_review so no work is corrupted and it can resume cleanly
      console.log(`🛑 [${workerId}] Task #${task.id} aborted due to stop request. Reverting status to ready_for_review.`);
      await supabase
        .from('submission_tasks')
        .update({ status: 'ready_for_review', worker_id: null, updated_at: now })
        .eq('id', task.id);
      if (task.distribution_id) {
        await supabase
          .from('job_distributions')
          .update({ status: 'ready_for_review', worker_id: null, updated_at: now })
          .eq('id', task.distribution_id);
      }
    } else {
      const errMsg = result?.error || result?.reason || `Submission ended with status: ${result?.status || 'failed'}`;
      const failShot = finalShotUrl || finalStoragePath || null;
      await updateSubmissionTaskWithCheck({
        taskId: task.id,
        workerId,
        patch: {
          status: 'failed',
          error_message: errMsg,
          completed_at: now,
          application_submitted_screenshot_url: failShot,
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
            application_submitted_screenshot_url: failShot,
            screenshot_path: failShot,
            updated_at: now,
          },
        });
      }

      try {
        const { recordFailedJob } = await import('./supabaseClient.mjs');
        await recordFailedJob({
          applywizzId: task.applywizz_id,
          jobId: task.job_id || null,
          jobUrl: task.job_url,
          company: task.company,
          roleTitle: task.role_title,
          failureReason: errMsg,
          failedAtStep: result?.stoppedAtStep || 'Submission',
          screenshotPath: failShot,
        });
      } catch {}
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
          errShotPath = `${cleanId}_${task.id}_failed_${timestamp}.png`;
          let upRes = await supabase.storage
            .from('failed-applications')
            .upload(errShotPath, buf, { contentType: 'image/png', upsert: true });
          if (!upRes.error) {
            const { data: urlData } = supabase.storage
              .from('failed-applications')
              .getPublicUrl(errShotPath);
            errShotUrl = urlData?.publicUrl || null;
            console.log(`[${workerId}] screenshot uploaded to failed-applications: ${errShotPath}`);
          }
        }
      }
    } catch (catchShotErr) {
      console.warn(`[${workerId}] Exception screenshot capture error:`, catchShotErr.message);
    }

    result.screenshotUrl = errShotUrl;
    result.screenshotPath = errShotPath;

    const catchShot = errShotUrl || errShotPath || null;
    const catchErr = err?.message || 'Execution error';

    await updateSubmissionTaskWithCheck({
      taskId: task.id,
      workerId,
      patch: {
        status: 'failed',
        error_message: catchErr,
        completed_at: now,
        application_submitted_screenshot_url: catchShot,
        updated_at: now,
      },
    });

    if (task.distribution_id) {
      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id,
        workerId,
        patch: {
          status: 'failed',
          error_message: catchErr,
          application_submitted_screenshot_url: catchShot,
          screenshot_path: catchShot,
          updated_at: now,
        },
      });
    }

    try {
      const { recordFailedJob } = await import('./supabaseClient.mjs');
      await recordFailedJob({
        applywizzId: task.applywizz_id,
        jobId: task.job_id || null,
        jobUrl: task.job_url,
        company: task.company,
        roleTitle: task.role_title,
        failureReason: catchErr,
        failedAtStep: 'Runtime Exception',
        screenshotPath: catchShot,
      });
    } catch {}
  } finally {
    stopHeartbeat();
    if (watchdogTimer) clearTimeout(watchdogTimer);
    try {
      const { cleanupClientResume } = await import('./applyWizzResume.mjs');
      await cleanupClientResume({ _applyWizzId: task.applywizz_id, applywizz_id: task.applywizz_id });
    } catch {}
    // Release worker back to idle
    await updateWorkerStatus(workerId, {
      state: 'idle',
      stage: 'submitting',
      current_application_id: null,
      bot_name: `Submitting Worker ${workerId.slice(-1)}`,
      updated_at: new Date().toISOString(),
    }).catch(() => { });
  }

  return result;
}

