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

export const SUBMISSION_WORKER_IDS = (PIPELINE_CONFIG.submitWorkerIds && PIPELINE_CONFIG.submitWorkerIds.length > 0)
  ? PIPELINE_CONFIG.submitWorkerIds
  : Array.from({ length: PIPELINE_CONFIG.workersCount || 2 }, (_, i) => `submitting_worker_${i + 1 + (Number(process.env.WORKER_OFFSET) || 0)}`);

/**
 * Dynamically resolves the active 2-worker slot pair for this container instance.
 * - If SUBMISSION_WORKER_IDS or SUBMIT_WORKER_IDS is set, uses it directly.
 * - If WORKER_OFFSET is set, uses it directly.
 * - In multi-replica Railway deployments where replicas share identical env vars,
 *   pairs of workers ([1,2], [3,4], [5,6], [7,8]) are automatically assigned without collision.
 */
export async function resolveInstanceSubmissionWorkerIds() {
  if (process.env.SUBMISSION_WORKER_IDS) {
    return process.env.SUBMISSION_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.SUBMIT_WORKER_IDS) {
    return process.env.SUBMIT_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const baseOffset = Number(process.env.WORKER_OFFSET);
  if (!Number.isNaN(baseOffset) && process.env.WORKER_OFFSET !== undefined) {
    return Array.from({ length: PIPELINE_CONFIG.workersCount || 2 }, (_, i) => `submitting_worker_${i + 1 + baseOffset}`);
  }

  // Multi-replica Railway automatic pair allocation across strictly 8 max cluster workers:
  const candidatePairs = [
    ['submitting_worker_1', 'submitting_worker_2'],
    ['submitting_worker_3', 'submitting_worker_4'],
    ['submitting_worker_5', 'submitting_worker_6'],
    ['submitting_worker_7', 'submitting_worker_8'],
  ];

  if (!supabase) {
    return SUBMISSION_WORKER_IDS;
  }

  try {
    const activeCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: activeWorkers } = await supabase
      .from('worker_status')
      .select('worker_id, state, updated_at')
      .in('worker_id', candidatePairs.flat())
      .gt('updated_at', activeCutoff);

    const activeSet = new Set(
      (activeWorkers || [])
        .filter((w) => w.state === 'in_flight' || w.state === 'busy')
        .map((w) => w.worker_id)
    );

    for (const pair of candidatePairs) {
      if (!pair.some((id) => activeSet.has(id))) {
        return pair;
      }
    }
  } catch { }

  return SUBMISSION_WORKER_IDS;
}

/**
 * Parse previous failed attempt count from error_message.
 * Returns 0 for unattempted/0th-attempt rows, 1 after Attempt 1 failure, 2 after Attempt 2 failure.
 */
export function getSubmissionAttemptCount(errorMessage) {
  const msg = String(errorMessage || '');
  const match = msg.match(/\[Attempt\s*(\d+)\s*\/\s*(\d+)[^\]]*\]/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}



/**
 * B1 Helper: Updates job_distributions directly (submission_tasks dropped in favor of single-table architecture).
 */
export async function updateSubmissionTaskWithCheck({
  taskId,
  distributionId,
  applywizzId,
  jobUrl,
  workerId = 'worker',
  patch,
  maxRetries = 3,
}) {
  return await updateJobDistributionWithCheck({
    distributionId: distributionId || taskId,
    applywizzId,
    jobUrl,
    workerId,
    patch,
  });
}

/**
 * B7 Helper: Checked update for job_distributions
 */
/**
 * B7 Helper: Checked update for job_distributions
 */
export async function updateJobDistributionWithCheck({
  distributionId,
  applywizzId,
  jobUrl,
  workerId = 'worker',
  patch,
  maxRetries = 3,
}) {
  if (!distributionId && (!applywizzId || !jobUrl)) {
    return { success: false, error: new Error('Neither distributionId nor (applywizzId and jobUrl) provided') };
  }
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
    if (!cleanPatch.application_submitted_screenshot_url && cleanPatch.screenshot_path) {
      cleanPatch.application_submitted_screenshot_url = cleanPatch.screenshot_path;
    }
    delete cleanPatch.screenshot_path;
  }
  // job_distributions has no completed_at column in schema; updated_at stores the completion timestamp
  if ('completed_at' in cleanPatch) {
    if (!cleanPatch.updated_at && cleanPatch.completed_at) {
      cleanPatch.updated_at = cleanPatch.completed_at;
    }
    delete cleanPatch.completed_at;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let query = supabase.from('job_distributions').update(cleanPatch);
      if (distributionId) {
        query = query.eq('id', distributionId);
      } else {
        query = query.eq('applywizz_id', applywizzId).eq('job_url', jobUrl);
      }
      const { data, error } = await query.select('*');

      if (error) {
        lastErr = new Error(`Supabase update error on job_distributions: ${error.message}`);
        console.warn(`[${workerId}] Warning: updateJobDistributionWithCheck attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      if (!data || data.length === 0) {
        // If matched 0 rows by distributionId, attempt fallback by applywizz_id + job_url if available
        if (distributionId && applywizzId && jobUrl) {
          const { data: fbData, error: fbErr } = await supabase
            .from('job_distributions')
            .update(cleanPatch)
            .eq('applywizz_id', applywizzId)
            .eq('job_url', jobUrl)
            .select('*');
          if (!fbErr && fbData && fbData.length > 0) {
            console.log(`[${workerId}] job_distributions record updated via fallback (applywizz_id=${applywizzId}) to '${patch.status || 'updated'}'`);
            return { success: true, data: fbData[0], rowsCount: fbData.length };
          }
        }
        lastErr = new Error(`Zero rows updated on job_distributions for #${distributionId || `${applywizzId}/${jobUrl}`}`);
        console.warn(`[${workerId}] Warning: updateJobDistributionWithCheck attempt ${attempt}/${maxRetries} matched 0 rows`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      console.log(`[${workerId}] job_distributions record updated to '${patch.status || 'updated'}' (rows=${data.length}) for dist #${distributionId || applywizzId}`);
      return { success: true, data: data[0], rowsCount: data.length };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const finalErrMsg = `[${workerId}] ERROR: Failed to update job_distributions #${distributionId || applywizzId} after ${maxRetries} attempts: ${lastErr?.message}`;
  console.error(finalErrMsg);
  return { success: false, error: lastErr || new Error(finalErrMsg) };
}

/**
 * Synchronize all ready_for_review applications from job_distributions into submission_tasks.
 * Bypass: User explicit policy — tasks are picked directly from job_distributions without comparison or pre-sync.
 */
export async function syncJobDistributionsToSubmissionTasks() {
  return 0;
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
  const MAX_CLUSTER_CONCURRENCY = 8;
  const maxConcurrent = Math.min(
    MAX_CLUSTER_CONCURRENCY,
    Number(process.env.CLUSTER_CONCURRENCY) ||
    Number(process.env.GLOBAL_WORKER_COUNT) ||
    Number(process.env.MAX_CONCURRENT_SUBMISSIONS) ||
    MAX_CLUSTER_CONCURRENCY
  );

  // Cluster Concurrency Guard: Strictly at most 8 rows can be 'applying' across all services and replicas
  try {
    // Check raw total count of rows currently in 'applying' state across the entire database
    const { count: rawApplyingCount } = await supabase
      .from('job_distributions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'applying');

    if (typeof rawApplyingCount === 'number' && rawApplyingCount >= maxConcurrent) {
      // Proactively reap any stale / expired leases right now
      const reaped = await reapExpiredLeases(6).catch(() => []);
      const remainingApplying = rawApplyingCount - (reaped?.length || 0);
      if (remainingApplying >= maxConcurrent) {
        return null;
      }
    }
  } catch { }

  // 1. Direct atomic CAS on job_distributions (Candidate picking strictly from job_distributions without pre-sync)
  try {
    // Stage 3 Progressive Priority Policy (Max 3 Attempts):
    // 1. First claim unattempted 0th attempt applications (error_message is null or has not failed any attempt)
    let { data: candidates, error: candErr } = await supabase
      .from('job_distributions')
      .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers')
      .in('status', ['ready_for_review', 'queued'])
      .or('error_message.is.null,error_message.not.ilike.%[Attempt%')
      .order('created_at', { ascending: true })
      .limit(10);

    // Cool-down for retries: Don't immediately re-claim a task that just failed seconds ago.
    // Give other tasks priority and provide a 60-second backoff before retrying.
    const retryCooldownCutoff = new Date(Date.now() - 60 * 1000).toISOString();

    // 2. Only after all 0th attempt applications have finished processing, claim deferred Attempt 1 retries
    if (!candidates || candidates.length === 0) {
      const { data: retryCandidates } = await supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers')
        .in('status', ['ready_for_review', 'queued'])
        .or('error_message.ilike.%[Attempt 1/3]%,error_message.ilike.%[Attempt 1/2]%')
        .lte('updated_at', retryCooldownCutoff)
        .order('updated_at', { ascending: true })
        .limit(10);
      candidates = retryCandidates || [];
    }

    // 3. Only after all Attempt 1 retries have finished processing, claim deferred Attempt 2 retries
    if (!candidates || candidates.length === 0) {
      const { data: retryCandidates2 } = await supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers')
        .in('status', ['ready_for_review', 'queued'])
        .or('error_message.ilike.%[Attempt 2/3]%,error_message.ilike.%[Attempt 2/2]%')
        .lte('updated_at', retryCooldownCutoff)
        .order('updated_at', { ascending: true })
        .limit(10);
      candidates = retryCandidates2 || [];
    }

    if (!candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
      // Atomic claim directly on job_distributions row
      const { data: claimed, error: claimErr } = await supabase
        .from('job_distributions')
        .update({
          status: 'applying',
          worker_id: workerId,
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', cand.id)
        .eq('status', cand.status)
        .select('*');

      if (!claimErr && claimed && claimed.length > 0) {
        const claimedDist = claimed[0];

        // Format task object for worker execution directly from job_distributions
        const claimedTask = {
          id: claimedDist.id,
          distribution_id: claimedDist.id,
          applywizz_id: claimedDist.applywizz_id,
          job_url: claimedDist.job_url,
          company: claimedDist.company,
          role_title: claimedDist.role_title,
          status: 'applying',
          error_message: claimedDist.error_message,
          resolved_answers: claimedDist.resolved_answers || claimedDist.resolved_answers_json,
          worker_id: workerId,
          started_at: now,
        };

        return claimedTask;
      }
    }
  } catch (err) {
    console.warn(`[claimNextTask] Error claiming directly from job_distributions for ${workerId}:`, err.message);
  }

  return null;
}

/**
 * Heartbeat: Updates worker_leased_at on job_distributions while worker is processing.
 */
export async function sendTaskHeartbeat(taskId, workerId) {
  if (!taskId || !workerId) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from('job_distributions')
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
 * Reaper: Reverts tasks with expired lease (> timeoutMinutes) back to 'ready_for_review'
 * on job_distributions directly. NEVER sets 'failed'.
 */
export async function reapExpiredLeases(timeoutMinutes = 6) {
  if (!supabase) return [];
  try {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { data: expired, error: selErr } = await supabase
      .from('job_distributions')
      .select('id, worker_id, applywizz_id')
      .eq('status', 'applying')
      .or(`worker_leased_at.lt.${cutoff},worker_leased_at.is.null`);

    if (selErr || !expired || expired.length === 0) return [];

    const reapedRows = [];
    for (const exp of expired) {
      // Single-ID CAS update checking previous status 'applying'
      const { data: updated, error: updErr } = await supabase
        .from('job_distributions')
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
      console.log(`🧹 [REAPER] Safely reverted ${reapedRows.length} expired task(s) on job_distributions to ready_for_review:`, reapedRows.map(r => r.id));
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

  const previousFailedAttempts = getSubmissionAttemptCount(task.error_message);
  const currentAttempt = previousFailedAttempts + 1; // 1, 2, or 3
  const isFinalAttempt = currentAttempt >= 3;

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`🚀 [STAGE 3: SUBMITTER] [${workerId}] EXECUTING APPLICATION SUBMISSION`);
  console.log(`   • Task ID: #${task.id} | Distribution ID: #${task.distribution_id || 'N/A'}`);
  console.log(`   • Candidate AWL-ID: ${task.applywizz_id}`);
  console.log(`   • Company: ${task.company || 'Workday Partner'}`);
  console.log(`   • Role: ${task.role_title || 'Workday Application'}`);
  console.log(`   • Target URL: ${task.job_url}`);
  console.log(`   • Submission Attempt: ${currentAttempt} of 3 (Max 3 Attempts)`);
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

  // B4 Task Watchdog: hard limit of 4 minutes per task (fail-fast to prevent queue block)
  const WATCHDOG_TIMEOUT_MS = options?.watchdogTimeoutMs || 4 * 60 * 1000;
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
            let distRow = null;
            if (task.distribution_id) {
              const { data: dRow } = await supabase.from('job_distributions').select('resolved_answers').eq('id', task.distribution_id).maybeSingle();
              distRow = dRow;
            }
            if (!distRow && task.applywizz_id && task.job_url) {
              const { data: dRow } = await supabase.from('job_distributions').select('resolved_answers').eq('applywizz_id', task.applywizz_id).eq('job_url', task.job_url).maybeSingle();
              distRow = dRow;
            }
            if (distRow?.resolved_answers && Array.isArray(distRow.resolved_answers) && distRow.resolved_answers.length > 0) {
              preResolved = distRow.resolved_answers;
            }
          } catch (fetchErr) {
            console.warn(`[${workerId}] Warning loading pre-resolved answers for task #${task.id}:`, fetchErr?.message);
          }
        }
        if (preResolved) {
          task.resolved_answers = preResolved;
        }

        const { isGlobalStopRequested, isSubmitStopRequested } = await import('./browserLifecycle.mjs');
        if (isGlobalStopRequested() || isSubmitStopRequested()) {
          console.log(`🛑 [${workerId}] Halting claimed submission task #${task.id}: Stop requested.`);
          return { status: 'stopped', message: 'Stop requested by user' };
        }

        const cleanAwlId = String(task.applywizz_id || '').replace(/["'\\[\]]/g, '').trim().toUpperCase();
        const { getClientRecordByAwlId } = await import('./supabaseClient.mjs');
        const dbClient = await getClientRecordByAwlId(cleanAwlId);

        if (!dbClient || !dbClient.company_email || !String(dbClient.company_email).trim()) {
          const errMsg = `[STRICT AUTH GUARD] No valid company_email found in clients table for client "${task.applywizz_id}" (${cleanAwlId}). Refusing to authenticate with unverified/mock credentials.`;
          console.error(`❌ [${workerId}] ${errMsg}`);
          return {
            status: 'failed',
            error: errMsg,
            reason: errMsg,
            stoppedAtStep: 'Strict Auth Guard',
          };
        }

        const candidateCompanyEmail = String(dbClient.company_email).trim().toLowerCase();
        console.log(`🔒 [STRICT AUTH GUARD] [${workerId}] Verified candidate company_email from clients table: ${candidateCompanyEmail} for ${cleanAwlId} (${dbClient.client_name || ''})`);

        task.candidateEmail = candidateCompanyEmail;
        task.dbClient = dbClient;

        const { executeWorkerTask, setWorkerPoolStop } = await import('./workerPool.mjs');
        setWorkerPoolStop(false);
        return await executeWorkerTask({
          task: {
            id: task.distribution_id,
            distributionId: task.distribution_id,
            taskId: task.id,
            applywizzId: cleanAwlId,
            jobUrl: task.job_url,
            company: task.company,
            roleTitle: task.role_title,
            status: 'approved_for_submission',
            isDirectSubmission: true,
            resolved_answers: preResolved,
            pre_resolved_answers: preResolved,
            candidateEmail: candidateCompanyEmail,
            dbClient,
            currentAttempt,
            maxAttempts: 3,
            isFinalAttempt,
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
            isDirectSubmission: true,
            currentAttempt,
            maxAttempts: 3,
            isFinalAttempt,
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
          // STRICT RULE: Only capture and upload failure screenshot strictly on 3rd attempt
          if (isFinalAttempt && ctx?.page && !ctx.page.isClosed()) {
            const buf = await ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
            if (buf) {
              const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
              const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
              const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
              const timestamp = Date.now();
              // Zero nested folders: flat filename directly in root of failed-applications
              shotPath = `${compPrefix}_${task.id}_failed_${timestamp}.png`;
              const { error: upErr } = await supabase.storage
                .from('failed-applications')
                .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
              if (!upErr) {
                const { data: urlData } = supabase.storage
                  .from('failed-applications')
                  .getPublicUrl(shotPath);
                shotUrl = urlData?.publicUrl || null;
                console.log(`[${workerId}] 3rd attempt failure screenshot uploaded: ${shotPath}`);
              }
            }
          }
          if (ctx?.browser) {
            await ctx.browser.close().catch(() => { });
          }
        } catch (wShotErr) {
          console.warn(`[${workerId}] Watchdog screenshot error:`, wShotErr.message);
        }

        resolve({
          status: 'failed',
          isTimeout: true,
          error: 'Task timed out after 8 minutes',
          stoppedAtStep: 'Watchdog Timeout (8 min)',
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
      result?.reason === 'already_applied' ||
      result?.isAlreadyApplied === true ||
      result?.alreadyApplied === true ||
      /already applied|already submitted/i.test(result?.error || '') ||
      /already applied|already submitted/i.test(result?.reason || '') ||
      /already applied|already submitted/i.test(result?.failureReason || '')
    );

    let finalShotUrl = result?.screenshotUrl || result?.reviewScreenshotUrl || result?.failureScreenshotUrl || null;
    let finalStoragePath = result?.screenshotPath || null;

    // MANDATORY Screenshot: If candidate already applied, ensure proof screenshot is captured even on attempt 1
    if (isAlreadyApplied && !finalShotUrl) {
      try {
        const ctx = getWorkerContext(workerId);
        if (ctx?.page && !ctx.page.isClosed()) {
          const buf = await ctx.page.screenshot({ type: 'jpeg', quality: 85 }).catch(() => null);
          if (buf) {
            const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
            const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
            const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
            finalStoragePath = `${compPrefix}_${task.id}_already_applied_${Date.now()}.jpg`;
            const { error: upErr } = await supabase.storage
              .from('submitted-applications')
              .upload(finalStoragePath, buf, { contentType: 'image/jpeg', upsert: true });
            if (!upErr) {
              const { data: urlData } = supabase.storage
                .from('submitted-applications')
                .getPublicUrl(finalStoragePath);
              finalShotUrl = urlData?.publicUrl || null;
            }
          }
        }
      } catch { }
    }

    if (isAlreadyApplied) {
      try {
        const ctx = getWorkerContext(workerId);
        if (ctx?.browser) {
          await ctx.browser.close().catch(() => { });
        }
      } catch { }
    }

    if (!finalStoragePath && finalShotUrl) {
      const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
      const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
      // Flat filename directly in bucket root
      finalStoragePath = `${compPrefix}_${task.id}.png`;
    }
    if (result && typeof result === 'object') {
      result.screenshotUrl = finalShotUrl;
      result.screenshotPath = finalStoragePath;
    }

    if (isSuccess) {
      console.log(`\n${'═'.repeat(90)}`);
      console.log(`✅ [STAGE 3: SUBMITTER] [${workerId}] APPLICATION SUBMITTED SUCCESSFULLY!`);
      console.log(`✅ [STAGE 3: SUBMITTER] [${workerId}] This application was submitted with screenshot: ${finalShotUrl || 'Uploaded to Supabase Storage'}`);
      console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
      console.log(`   • Status: SUBMITTED`);
      console.log(`   • Proof Screenshot: ${finalShotUrl || 'Uploaded to Supabase Storage'}`);
      console.log(`   • Table: job_distributions #${task.distribution_id || task.id} -> 'submitted'`);
      console.log(`${'═'.repeat(90)}\n`);

      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id || task.id,
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        workerId,
        patch: {
          status: 'submitted',
          error_message: null,
          application_submitted_screenshot_url: finalShotUrl,
          updated_at: now,
        },
      });
    } else if (isAlreadyApplied) {
      console.log(`\n${'═'.repeat(90)}`);
      console.log(`ℹ️ [STAGE 3: SUBMITTER] [${workerId}] APPLICATION ALREADY APPLIED ON WORKDAY`);
      console.log(`ℹ️ [STAGE 3: SUBMITTER] [${workerId}] This application was ALREADY APPLIED with screenshot: ${finalShotUrl || 'None'}`);
      console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
      console.log(`   • Status: ALREADY_APPLIED`);
      console.log(`   • Proof Screenshot: ${finalShotUrl || 'None'}`);
      console.log(`   • Table: job_distributions #${task.distribution_id || task.id} -> 'already_applied'`);
      console.log(`${'═'.repeat(90)}\n`);

      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id || task.id,
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        workerId,
        patch: {
          status: 'already_applied',
          error_message: 'Application already submitted on Workday',
          application_submitted_screenshot_url: finalShotUrl,
          updated_at: now,
        },
      });
    } else {
      const failedStep = result?.stoppedAtStep || result?.stoppedBlock || result?.step || 'Unknown Step';
      const rawErrMsg = result?.error || result?.reason || result?.failureReason || `Submission ended with status: ${result?.status || 'failed'}`;

      const isFatalNonRetryable = (
        /mailbox_not_connected|no valid company_email|no company_email|unverified\/mock credentials|link expired|dead\/expired|does not exist|error 404/i.test(rawErrMsg) ||
        /strict auth guard/i.test(failedStep) ||
        result?.status === 'job_expired' ||
        result?.status === 'invalid_url'
      );

      if (currentAttempt < 3 && !isFatalNonRetryable) {
        // Attempts 1 and 2: STRICT PROGRESSIVE RETRY POLICY (DO NOT mark failed, revert strictly to ready_for_review)
        const retryMsg = `[Attempt ${currentAttempt}/3] Halted at "${failedStep}": ${rawErrMsg}`;
        console.log(`\n${'═'.repeat(90)}`);
        console.log(`🔄 [STAGE 3: SUBMITTER] [${workerId}] SUBMISSION ATTEMPT ${currentAttempt}/3 FAILED — REVERTING TO READY_FOR_REVIEW`);
        console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
        console.log(`   • Attempt: ${currentAttempt} of 3 (Will retry up to 3 attempts before marking failed)`);
        console.log(`   • Status: Reverting strictly to ready_for_review (DO NOT MARK FAILED)`);
        console.log(`   • Halted At Step: ${failedStep}`);
        console.log(`   • Reason: ${rawErrMsg}`);
        console.log(`   • Table: job_distributions #${task.distribution_id || task.id} -> 'ready_for_review'`);
        console.log(`${'═'.repeat(90)}\n`);

        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id || task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            worker_leased_at: null,
            error_message: retryMsg,
            application_submitted_screenshot_url: null,
            updated_at: now,
          },
        });

        // Ensure NO premature row in failed_jobs on attempt 1 or 2
        try {
          const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
          const cleanUrl = String(task.job_url).trim().replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '');
          await supabase.from('failed_jobs').delete().eq('applywizz_id', cleanId).eq('job_url', cleanUrl);
        } catch { }
      } else {
        // Attempt 3: STRICT 3RD ATTEMPT FAILURE POLICY
        let finalShotUrl = result?.screenshotUrl || result?.failureScreenshotUrl || result?.reviewScreenshotUrl || null;
        if (!finalShotUrl) {
          try {
            const ctx = getWorkerContext(workerId);
            if (ctx?.page && !ctx.page.isClosed()) {
              const buf = await ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
              if (buf) {
                const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
                const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
                const timestamp = Date.now();
                const shotPath = `${compPrefix}_${task.id}_failed_${timestamp}.png`;
                const { error: upErr } = await supabase.storage
                  .from('failed-applications')
                  .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
                if (!upErr) {
                  const { data: urlData } = supabase.storage
                    .from('failed-applications')
                    .getPublicUrl(shotPath);
                  finalShotUrl = urlData?.publicUrl || null;
                  console.log(`[${workerId}] 3rd attempt failure screenshot uploaded: ${shotPath}`);
                }
              }
            }
          } catch (fShotErr) {
            console.warn(`[${workerId}] 3rd attempt screenshot capture error:`, fShotErr.message);
          }
        }

        const finalFailMsg = `[Attempt 3/3 Failed at "${failedStep}"]: ${rawErrMsg}`;
        console.log(`\n${'═'.repeat(90)}`);
        console.log(`❌ [STAGE 3: SUBMITTER] [${workerId}] SUBMISSION PERMANENTLY FAILED (MAX 3 ATTEMPTS EXHAUSTED)`);
        console.log(`   • Candidate: ${task.applywizz_id} @ ${task.company || 'Workday'}`);
        console.log(`   • Attempt: 3 of 3 (Max attempts reached)`);
        console.log(`   • Status: FAILED`);
        console.log(`   • Failed At Step: ${failedStep}`);
        console.log(`   • Failure Reason: ${rawErrMsg}`);
        console.log(`   • Failure Diagnostic Screenshot: ${finalShotUrl || 'None'}`);
        console.log(`   • Table: job_distributions #${task.distribution_id || task.id} -> 'failed'`);
        console.log(`${'═'.repeat(90)}\n`);

        const failPatch = {
          status: 'failed',
          error_message: finalShotUrl ? `${finalFailMsg} [diagnostic_screenshot: ${finalShotUrl}]` : finalFailMsg,
          application_submitted_screenshot_url: finalShotUrl,
          updated_at: now,
        };

        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id || task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          workerId,
          patch: failPatch,
        });

        try {
          const { recordFailedJob } = await import('./supabaseClient.mjs');
          await recordFailedJob({
            applywizzId: task.applywizz_id,
            jobId: task.job_id || null,
            jobUrl: task.job_url,
            company: task.company || 'Workday Partner',
            roleTitle: task.role_title || 'Workday Application',
            failureReason: `${rawErrMsg} (Attempt 3/3 exhausted)`,
            failedAtStep: failedStep,
            screenshotPath: finalShotUrl,
          });
        } catch (recErr) {
          console.warn(`[${workerId}] Warning writing to failed_jobs:`, recErr.message);
        }
      }
    }
  } catch (err) {
    stopHeartbeat();
    if (watchdogTimer) clearTimeout(watchdogTimer);

    result = {
      status: 'failed',
      error: err?.message || 'Execution error',
      stoppedAtStep: 'Execution Exception',
    };
    const now = new Date().toISOString();

    const previousFailedAttempts = getSubmissionAttemptCount(task.error_message);
    const currentAttempt = previousFailedAttempts + 1;
    const isFinalAttempt = currentAttempt >= 3;

    let errShotUrl = null;
    let errShotPath = null;

    // STRICT RULE: Capture and upload screenshot ONLY strictly on 3rd attempt
    if (isFinalAttempt) {
      try {
        const ctx = getWorkerContext(workerId);
        if (ctx?.page && !ctx.page.isClosed()) {
          const buf = await ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
          if (buf) {
            const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
            const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
            const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
            const timestamp = Date.now();
            errShotPath = `${compPrefix}_${task.id}_failed_${timestamp}.png`;
            const { error: upErr } = await supabase.storage
              .from('failed-applications')
              .upload(errShotPath, buf, { contentType: 'image/png', upsert: true });
            if (!upErr) {
              const { data: urlData } = supabase.storage
                .from('failed-applications')
                .getPublicUrl(errShotPath);
              errShotUrl = urlData?.publicUrl || null;
              console.log(`[${workerId}] 3rd attempt exception screenshot uploaded: ${errShotPath}`);
            }
          }
        }
      } catch (catchShotErr) {
        console.warn(`[${workerId}] Exception screenshot capture error:`, catchShotErr.message);
      }
    }

    result.screenshotUrl = errShotUrl;
    result.screenshotPath = errShotPath;

    const errMsg = err?.message || 'Execution error';
    const failedStep = 'Execution Exception';

    const isFatalNonRetryable = (
      /mailbox_not_connected|no valid company_email|no company_email|unverified\/mock credentials|link expired|dead\/expired|does not exist|error 404/i.test(errMsg) ||
      /strict auth guard/i.test(errMsg)
    );

    if (currentAttempt < 3 && !isFatalNonRetryable) {
      const retryMsg = `[Attempt ${currentAttempt}/3] Halted at "${failedStep}": ${errMsg}`;
      console.log(`\n🔄 [STAGE 3: SUBMITTER] [${workerId}] Exception on attempt ${currentAttempt}/3. Re-queueing job_distributions #${task.distribution_id || task.id} to ready_for_review for retry.`);

      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id || task.id,
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        workerId,
        patch: {
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          error_message: retryMsg,
          application_submitted_screenshot_url: null,
          updated_at: now,
        },
      });

      // Ensure NO premature row in failed_jobs on attempt 1 or 2
      try {
        const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
        const cleanUrl = String(task.job_url).trim().replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '');
        await supabase.from('failed_jobs').delete().eq('applywizz_id', cleanId).eq('job_url', cleanUrl);
      } catch { }
    } else {
      const finalFailMsg = `[Attempt 3/3 Failed at "${failedStep}"]: ${errMsg}`;
      const failPatch = {
        status: 'failed',
        error_message: errShotUrl ? `${finalFailMsg} [diagnostic_screenshot: ${errShotUrl}]` : finalFailMsg,
        application_submitted_screenshot_url: errShotUrl,
        updated_at: now,
      };

      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id || task.id,
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        workerId,
        patch: failPatch,
      });

      try {
        const { recordFailedJob } = await import('./supabaseClient.mjs');
        await recordFailedJob({
          applywizzId: task.applywizz_id,
          jobId: task.job_id || null,
          jobUrl: task.job_url,
          company: task.company || 'Workday Partner',
          roleTitle: task.role_title || 'Workday Application',
          failureReason: `${errMsg} (Attempt 3/3 exhausted)`,
          failedAtStep: failedStep,
          screenshotPath: errShotUrl,
        });
      } catch (recErr) {
        console.warn(`[${workerId}] Warning writing to failed_jobs:`, recErr.message);
      }
    }
  } finally {
    stopHeartbeat();
    if (watchdogTimer) clearTimeout(watchdogTimer);
    try {
      const { releaseBrowserSlot, unregisterWorkerContext } = await import('./browserLifecycle.mjs');
      releaseBrowserSlot(workerId);
      unregisterWorkerContext(workerId);
    } catch { }
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
    const shot = item.screenshotUrl || item.screenshotPath || item.application_submitted_screenshot_url || 'None';
    console.log(`${num} | ${awlId} | ${comp} | ${st} | ${reason} | ${shot}`);
  });

  console.log(`\n📸 [10-SUBMISSION BATCH PROOF SCREENSHOTS — CYCLE #${cycleIndex}]`);
  items.forEach((item, idx) => {
    const num = cycleStartNum + idx;
    const awl = item.applywizz_id || item.applywizzId || 'AWL';
    const comp = item.company || 'Workday Partner';
    const shot = item.screenshotUrl || item.screenshotPath || item.application_submitted_screenshot_url || 'No screenshot captured';
    const isSuccess = item.status === 'submitted' || item.status === 'success';
    const stIcon = isSuccess ? '✅ SUBMITTED' : '❌ FAILED';
    console.log(`   [#${num}] ${stIcon} | ${awl} @ ${comp} ➔ Screenshot URL: ${shot}`);
  });

  console.log(`${'─'.repeat(120)}`);
  console.log(`📌 STATS SUMMARY: ${submittedCount} SUBMITTED, ${failedCount} FAILED (${successRate}% SUCCESS RATE) | MILESTONE #${cycleIndex} LOGGED`);
  console.log(`${'═'.repeat(120)}\n`);
}

export const print10SubmissionMilestoneReport = print10ClientSubmissionMilestoneReport;

