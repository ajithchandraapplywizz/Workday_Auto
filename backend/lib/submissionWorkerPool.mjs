/**

 * Autonomous 3-Worker Submission Engine (Phase 3)

 * - 3 Dedicated Submitting Workers: submitting_worker_1, submitting_worker_2, submitting_worker_3

 * - Atomic Claim: FOR UPDATE SKIP LOCKED (oldest queued first) via RPC or atomic CAS

 * - Heartbeat: updates worker_leased_at every 30 seconds

 * - Reaper: 10-minute lease expiry marks stuck tasks as 'failed' (never re-queued)

 * - Isolated Context: each task runs in its own fresh Playwright browser context

 */



import { loadLocalEnvOnce, updateWorkerStatus, getWorkerControls, canonicalJobPostingUrl } from './supabaseClient.mjs';
import { canExecuteWorkers } from '../config/envConfig.mjs';

import { createClient } from '@supabase/supabase-js';

import { getWorkerContext, isGlobalStopRequested, isSubmitStopRequested } from './browserLifecycle.mjs';



import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';

export const getSubmissionServiceName = () => process.env.RAILWAY_SERVICE_NAME || ((Number(process.env.WORKER_OFFSET) || 0) > 0 ? 'Submitting_2' : 'Submitting_1');



loadLocalEnvOnce();

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)

  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  : null;



function getDynamicSubmitWorkerCount() {
  const list = process.env.SUBMISSION_WORKER_IDS || process.env.SUBMIT_WORKER_IDS;
  if (list) {
    const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts.length;
  }
  const envVal = Number(process.env.SUBMIT_WORKER_COUNT) ||
    Number(process.env.SUBMIT_WORKERS) ||
    Number(process.env.SUBMISSION_WORKER_COUNT) ||
    Number(process.env.SUBMISSION_WORKERS) ||
    Number(process.env.WORKER_COUNT) ||
    Number(process.env.WORKERS_COUNT) ||
    Number(process.env.WORKERS) ||
    Number(process.env.MAX_WORKERS) ||
    Number(process.env.CONCURRENT_WORKERS);
  return (Number.isFinite(envVal) && envVal > 0)
    ? Math.floor(envVal)
    : (PIPELINE_CONFIG.submitWorkersCount || PIPELINE_CONFIG.workersCount || 2);
}

const envWorkerCount = getDynamicSubmitWorkerCount();

export const SUBMISSION_WORKER_IDS = (PIPELINE_CONFIG.submitWorkerIds && PIPELINE_CONFIG.submitWorkerIds.length > 0)
  ? PIPELINE_CONFIG.submitWorkerIds
  : Array.from({ length: envWorkerCount }, (_, i) => `submitting_worker_${i + 1 + (Number(process.env.WORKER_OFFSET) || 0)}`);

/**
 * Dynamically resolves the active worker slots for this container instance.
 * Strictly respects WORKER_COUNT from env.
 */
export async function resolveInstanceSubmissionWorkerIds() {
  if (process.env.SUBMISSION_WORKER_IDS) {
    return process.env.SUBMISSION_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.SUBMIT_WORKER_IDS) {
    return process.env.SUBMIT_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const workerCount = getDynamicSubmitWorkerCount();
  const baseOffset = Number(process.env.WORKER_OFFSET);
  if (!Number.isNaN(baseOffset) && process.env.WORKER_OFFSET !== undefined) {
    return Array.from({ length: workerCount }, (_, i) => `submitting_worker_${i + 1 + baseOffset}`);
  }

  // Automatic deduction from Railway Service Name: Submitting_2 -> offset workerCount (e.g. 2 -> W3, W4)
  const serviceName = process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || '';
  if (/2\b|_2\b|-2\b/i.test(serviceName)) {
    return Array.from({ length: workerCount }, (_, i) => `submitting_worker_${i + 1 + workerCount}`);
  }
  if (/1\b|_1\b|-1\b/i.test(serviceName)) {
    return Array.from({ length: workerCount }, (_, i) => `submitting_worker_${i + 1}`);
  }

  const replicaIndex = Number(process.env.RAILWAY_REPLICA_INDEX ?? process.env.REPLICA_INDEX);
  const effectiveOffset = !Number.isNaN(replicaIndex) ? replicaIndex * workerCount : 0;
  if (!Number.isNaN(replicaIndex)) {
    return Array.from({ length: workerCount }, (_, i) => `submitting_worker_${i + 1 + effectiveOffset}`);
  }

  // Multi-replica Railway automatic allocation of size workerCount across max cluster workers (2 services * 2 workers = 4 total):
  const maxTotalSubmitWorkers = (Number(process.env.TOTAL_SUBMIT_WORKERS) && Number(process.env.TOTAL_SUBMIT_WORKERS) <= (workerCount * 2))
    ? Number(process.env.TOTAL_SUBMIT_WORKERS)
    : (workerCount * 2);
  const candidateGroups = [];
  for (let offset = 0; offset < maxTotalSubmitWorkers; offset += workerCount) {
    candidateGroups.push(
      Array.from({ length: workerCount }, (_, i) => `submitting_worker_${i + 1 + offset}`)
    );
  }

  if (!supabase || !canExecuteWorkers()) {
    return candidateGroups[0] || SUBMISSION_WORKER_IDS;
  }

  try {
    const activeCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: activeWorkers } = await supabase
      .from('worker_status')
      .select('worker_id, state, updated_at')
      .in('worker_id', candidateGroups.flat())
      .gt('updated_at', activeCutoff);

    const activeSet = new Set(
      (activeWorkers || [])
        .filter((w) => w.state === 'in_flight' || w.state === 'busy')
        .map((w) => w.worker_id)
    );

    for (const group of candidateGroups) {
      if (!group.some((id) => activeSet.has(id))) {
        return group;
      }
    }
  } catch { }

  return candidateGroups[0] || SUBMISSION_WORKER_IDS;
}



/**

 * Parse previous failed attempt count from error_message.

 * Returns 0 for unattempted/0th-attempt rows, 1 after Attempt 1 failure, 2 after Attempt 2 failure.

 */

export function getSubmissionAttemptCount(errorMessage) {
  const msg = String(errorMessage || '');
  if (/stopped by user/i.test(msg)) {
    return 0;
  }
  const match = msg.match(/\[Attempt\s*(\d+)\s*\/\s*(\d+)[^\]]*\]/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

/**
 * Extract Workday requisition ID from job posting URL.
 * e.g. "Senior-Software-Engineer_JR1985432" -> "jr1985432"
 *      "Claims-Specialist_R-123456" -> "r-123456"
 */
export function extractWorkdayRequisitionId(url = '') {
  if (!url) return '';
  const clean = String(url).trim();
  const match = clean.match(/(?:_|\/)([a-z]{0,4}-?\d{4,10})(?:[/?#]|$)/i)
    || clean.match(/(?:req(?:uisition)?[-_]?id=|[?&]id=)([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Pre-Browser Fast Check: Verifies if candidate already submitted or applied to this job.
 * Checks previous submissions in job_distributions via:
 * 1. Exact URL match
 * 2. Canonical URL match
 * 3. Same Company + Requisition ID match
 */
export async function checkIfClientAlreadyAppliedToJob({ applywizzId, jobUrl, company, currentTaskId = null }) {
  if (!applywizzId || !jobUrl || !supabase) {
    return { alreadyApplied: false };
  }

  const cleanId = String(applywizzId).trim();
  const canonicalTarget = typeof canonicalJobPostingUrl === 'function' ? canonicalJobPostingUrl(jobUrl) : jobUrl.split('?')[0];
  const targetReqId = extractWorkdayRequisitionId(jobUrl);
  const cleanCompany = String(company || '').trim().toLowerCase();

  try {
    const { data: priorRows, error: queryErr } = await supabase
      .from('job_distributions')
      .select('id, job_url, company, status, application_submitted_screenshot_url, created_at, updated_at')
      .eq('applywizz_id', cleanId)
      .in('status', ['submitted', 'already_applied', 'completed']);

    if (queryErr || !Array.isArray(priorRows) || priorRows.length === 0) {
      return { alreadyApplied: false };
    }

    for (const prior of priorRows) {
      if (currentTaskId && String(prior.id) === String(currentTaskId)) {
        continue;
      }

      const priorRawUrl = prior.job_url || '';
      const priorCanonical = typeof canonicalJobPostingUrl === 'function' ? canonicalJobPostingUrl(priorRawUrl) : priorRawUrl.split('?')[0];
      const priorReqId = extractWorkdayRequisitionId(priorRawUrl);
      const priorCompany = String(prior.company || '').trim().toLowerCase();

      // Check 1: Exact URL match
      if (priorRawUrl === jobUrl) {
        return {
          alreadyApplied: true,
          matchedId: prior.id,
          matchedUrl: priorRawUrl,
          matchedDate: prior.updated_at || prior.created_at,
          screenshotUrl: prior.application_submitted_screenshot_url,
          matchType: 'exact_url',
        };
      }

      // Check 2: Canonical URL match
      if (canonicalTarget && priorCanonical && canonicalTarget === priorCanonical) {
        return {
          alreadyApplied: true,
          matchedId: prior.id,
          matchedUrl: priorRawUrl,
          matchedDate: prior.updated_at || prior.created_at,
          screenshotUrl: prior.application_submitted_screenshot_url,
          matchType: 'canonical_url',
        };
      }

      // Check 3: Same Company + Same Requisition ID match
      if (targetReqId && priorReqId && targetReqId === priorReqId) {
        const companyMatches = !cleanCompany || !priorCompany ||
          cleanCompany === priorCompany ||
          priorRawUrl.toLowerCase().includes(cleanCompany) ||
          jobUrl.toLowerCase().includes(priorCompany);
        if (companyMatches) {
          return {
            alreadyApplied: true,
            matchedId: prior.id,
            matchedUrl: priorRawUrl,
            matchedDate: prior.updated_at || prior.created_at,
            screenshotUrl: prior.application_submitted_screenshot_url,
            matchType: 'requisition_id',
          };
        }
      }
    }

    return { alreadyApplied: false };
  } catch (err) {
    console.warn(`[checkIfClientAlreadyAppliedToJob] Pre-check notice for ${cleanId}: ${err?.message || err}`);
    return { alreadyApplied: false };
  }
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

  // Never overwrite an existing proof screenshot with null or undefined
  if (cleanPatch.application_submitted_screenshot_url === null || cleanPatch.application_submitted_screenshot_url === undefined) {
    delete cleanPatch.application_submitted_screenshot_url;
  }

  // STRICT ATTEMPT 3 FAILURE POLICY: Any application that reaches or exhausts Attempt 3 is permanently marked 'failed'!
  const errText = String(cleanPatch.error_message || '');
  if (/\[Attempt 3\/3|Attempt 3\/3 Failed/i.test(errText)) {
    cleanPatch.status = 'failed';
  }

  // Auto-populate application_submitted_screenshot_url from diagnostic_screenshot in error_message if missing
  if (!cleanPatch.application_submitted_screenshot_url && /\[diagnostic_screenshot:\s*([^\s\]]+)\]/i.test(errText)) {
    const shotMatch = errText.match(/\[diagnostic_screenshot:\s*([^\s\]]+)\]/i);
    if (shotMatch && shotMatch[1] && shotMatch[1] !== 'none' && shotMatch[1] !== 'None') {
      cleanPatch.application_submitted_screenshot_url = shotMatch[1].trim();
    }
  }

  // STRICT IMMUTABILITY GUARD: If row is already 'submitted' or possesses authentic confirmation proof,
  // permanently refuse any downgrades to 'ready_for_review', 'failed', or 'applying'!
  if (cleanPatch.status && cleanPatch.status !== 'submitted' && cleanPatch.status !== 'completed') {
    try {
      let checkQ = supabase.from('job_distributions').select('id, status, application_submitted_screenshot_url');
      if (distributionId) checkQ = checkQ.eq('id', distributionId);
      else checkQ = checkQ.eq('applywizz_id', applywizzId).eq('job_url', jobUrl);
      const { data: targetRows } = await checkQ.limit(1);
      const targetRow = targetRows?.[0];
      if (targetRow) {
        const isAlreadySubmitted = targetRow.status === 'submitted' || targetRow.status === 'completed';
        const hasAuthenticProof = Boolean(
          targetRow.application_submitted_screenshot_url &&
          !targetRow.application_submitted_screenshot_url.includes('failed') &&
          (targetRow.application_submitted_screenshot_url.includes('workday-submitted') || (targetRow.application_submitted_screenshot_url.includes('submitted-applications') && !targetRow.application_submitted_screenshot_url.includes('review_blueprint')))
        );
        if (isAlreadySubmitted || (hasAuthenticProof && targetRow.status === 'submitted')) {
          console.log(`🔒 [${workerId}] IMMUTABLE PROTECTION: Row #${targetRow.id} (${applywizzId || 'target'}) is already permanently 'submitted' (proof: ${targetRow.application_submitted_screenshot_url || 'confirmed'}). Refusing downgrade to '${cleanPatch.status}'.`);
          return { success: true, data: targetRow, rowsCount: 1, protected: true };
        }
      }
    } catch (guardErr) {
      console.warn(`[${workerId}] Immutable pre-check note:`, guardErr.message);
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let query = supabase.from('job_distributions').update(cleanPatch);

      if (distributionId) {
        query = query.eq('id', distributionId);
      } else {
        query = query.eq('applywizz_id', applywizzId).eq('job_url', jobUrl);
      }

      if (cleanPatch.status && cleanPatch.status !== 'submitted' && cleanPatch.status !== 'completed') {
        query = query.neq('status', 'submitted').neq('status', 'completed');
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

          let fbQuery = supabase
            .from('job_distributions')
            .update(cleanPatch)
            .eq('applywizz_id', applywizzId)
            .eq('job_url', jobUrl);

          if (cleanPatch.status && cleanPatch.status !== 'submitted' && cleanPatch.status !== 'completed') {
            fbQuery = fbQuery.neq('status', 'submitted').neq('status', 'completed');
          }

          const { data: fbData, error: fbErr } = await fbQuery.select('*');

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

 * R4: Max concurrent applying rows parameterized by WORKER_COUNT from env.

 * Claims exactly one ready_for_review (or queued) row atomically, ensuring at most WORKER_COUNT

 * rows are 'applying' at any second across the entire cluster.

 */

/**
 * Counts all remaining applications awaiting submission across the system.
 * Returns total count of unsubmitted ready_for_review, ready_to_review, queued, or in-flight applying tasks.
 */
export async function getRemainingReadyForReviewCount() {
  if (!supabase) return 0;
  try {
    const { count, error } = await supabase
      .from('job_distributions')
      .select('*', { count: 'exact', head: true })
      .in('status', ['ready_for_review', 'applying'])
      .eq('is_fully_answered', true)
      .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
      .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.not.ilike.%submitted-applications%')
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .neq('status', 'archived');
    if (error) {
      console.warn('[SUBMISSION QUEUE] getRemainingReadyForReviewCount error:', error.message);
      return -1;
    }
    return typeof count === 'number' ? count : 0;
  } catch (err) {
    console.warn('[SUBMISSION QUEUE] getRemainingReadyForReviewCount exception:', err.message);
    return -1;
  }
}

export async function claimNextTask(workerId) {
  if (!workerId || !supabase) return null;

  // Cloud Protection Guard: Local development machines NEVER claim tasks unless local workers are enabled
  if (!canExecuteWorkers()) {
    return null;
  }

  const { isSubmitStopRequested } = await import('./browserLifecycle.mjs');

  if (isGlobalStopRequested() || isSubmitStopRequested()) return null;

  const controls = await getWorkerControls().catch(() => null);

  if (controls?.submit?.stop_requested) return null;

  // 1. Strict Single-Task per Worker Guard:
  // A worker cannot claim another task if it currently has an active 'applying' task
  try {
    const { data: existingApplying } = await supabase
      .from('job_distributions')
      .select('id, awl_id')
      .eq('worker_id', workerId)
      .eq('status', 'applying')
      .limit(1);

    if (existingApplying && existingApplying.length > 0) {
      return null;
    }
  } catch {}

  const now = new Date().toISOString();

  // Strictly respect worker count dynamically from env
  const envWorkerCount = getDynamicSubmitWorkerCount();
  const totalServices = Number(process.env.TOTAL_SERVICES) || Number(PIPELINE_CONFIG.totalServices) || 2;
  const maxClusterSubmitLimit = envWorkerCount * totalServices;
  const maxConcurrent = Math.max(
    maxClusterSubmitLimit,
    Number(process.env.CLUSTER_CONCURRENCY) || 0,
    Number(process.env.GLOBAL_WORKER_COUNT) || 0,
    Number(process.env.MAX_CONCURRENT_SUBMISSIONS) || 0
  );

  // Cluster Concurrency Guard: Strictly at most maxConcurrent rows can be 'applying' across all services and replicas
  try {
    // Check raw total count of rows currently in 'applying' state across the entire database
    const { count: rawApplyingCount } = await supabase
      .from('job_distributions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'applying');

    if (typeof rawApplyingCount === 'number' && rawApplyingCount >= maxConcurrent) {
      // Proactively reap any stale / expired leases right now (>2m cutoff)
      const reaped = await reapExpiredLeases(2).catch(() => []);
      const remainingApplying = rawApplyingCount - (reaped?.length || 0);
      if (remainingApplying >= maxConcurrent) {
        return null;
      }
    }
  } catch { }



  // 1. Direct atomic CAS on job_distributions (Candidate picking strictly from job_distributions without pre-sync)
  try {
    // Fetch active batch URLs from batch_job_queue to strictly guarantee submitter ONLY picks recently uploaded links
    let activeBatchUrls = null;
    try {
      const { getRecentBatchJobUrls } = await import('./supabaseClient.mjs');
      const { urls } = await getRecentBatchJobUrls({ windowMinutes: 720 });
      if (urls && urls.length > 0) {
        activeBatchUrls = urls;
      }
    } catch (batchErr) {
      console.warn(`[${workerId}] Note on recent batch query: ${batchErr.message}`);
    }

    if (!activeBatchUrls || activeBatchUrls.length === 0) {
      console.log(`[${workerId}] ℹ️ No recent batch filter active. Proceeding with all ready_for_review tasks in job_distributions.`);
    }

    // Stage 3 Progressive Priority Policy (Max 3 Attempts):
    // 1. First claim unattempted 0th attempt applications (error_message is null or has not failed any attempt, OR was stopped by user)
    // Strictly pick ONLY ready_for_review rows!
    let candQuery = supabase
      .from('job_distributions')
      .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers')
      .eq('status', 'ready_for_review')
      .eq('is_fully_answered', true)
      .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
      .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .neq('status', 'archived');

    if (activeBatchUrls && activeBatchUrls.length > 0 && activeBatchUrls.length <= 30) {
      candQuery = candQuery.in('job_url', activeBatchUrls);
    }

    let { data: allRawCandidates, error: candErr } = await candQuery
      .order('created_at', { ascending: true })
      .limit(30);

    if (candErr) {
      console.warn(`[${workerId}] candQuery error: ${candErr.message}`);
    }

    if ((!allRawCandidates || allRawCandidates.length === 0) && activeBatchUrls && activeBatchUrls.length > 0) {
      let fallback0Query = supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers')
        .eq('status', 'ready_for_review')
        .eq('is_fully_answered', true)
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
        .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .neq('status', 'archived');

      const { data: fbCandidates } = await fallback0Query
        .order('created_at', { ascending: true })
        .limit(30);
      allRawCandidates = fbCandidates || [];
    }

    // In JavaScript: filter strictly for 0th attempt tasks (error_message null or not containing [Attempt)
    let candidates = (allRawCandidates || []).filter((r) => {
      const err = r.error_message || '';
      if (err.includes('Resource Cooldown') || err.includes('Host process limit')) return false;
      return !err || !err.includes('[Attempt') || err.includes('Stopped by user');
    });

    // Cool-down for retries: Don't immediately re-claim a task that just failed seconds ago.
    // Give other tasks priority and provide a 60-second backoff before retrying.
    const retryCooldownCutoff = new Date(Date.now() - 60 * 1000).toISOString();

    // 2. Only after all 0th attempt applications have finished processing, claim deferred Attempt 1 retries
    if (!candidates || candidates.length === 0) {
      let retryQuery1 = supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers, application_submitted_screenshot_url')
        .eq('status', 'ready_for_review')
        .eq('is_fully_answered', true)
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .neq('status', 'archived')
        .or('error_message.ilike.%[Attempt 1/3]%,error_message.ilike.%[Attempt 1/2]%')
        .lte('updated_at', retryCooldownCutoff);

      if (activeBatchUrls && activeBatchUrls.length > 0 && activeBatchUrls.length <= 30) {
        retryQuery1 = retryQuery1.in('job_url', activeBatchUrls);
      }

      const { data: retryCandidates, error: r1Err } = await retryQuery1
        .order('updated_at', { ascending: true })
        .limit(10);
      if (r1Err) console.warn(`[${workerId}] retryQuery1 error: ${r1Err.message}`);
      candidates = retryCandidates || [];
    }

    // 3. Only after all Attempt 1 retries have finished processing, claim deferred Attempt 2 retries
    if (!candidates || candidates.length === 0) {
      let retryQuery2 = supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers, application_submitted_screenshot_url')
        .eq('status', 'ready_for_review')
        .eq('is_fully_answered', true)
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .neq('status', 'archived')
        .or('error_message.ilike.%[Attempt 2/3]%,error_message.ilike.%[Attempt 2/2]%')
        .lte('updated_at', retryCooldownCutoff);

      if (activeBatchUrls && activeBatchUrls.length > 0 && activeBatchUrls.length <= 30) {
        retryQuery2 = retryQuery2.in('job_url', activeBatchUrls);
      }

      const { data: retryCandidates2, error: r2Err } = await retryQuery2
        .order('updated_at', { ascending: true })
        .limit(10);
      if (r2Err) console.warn(`[${workerId}] retryQuery2 error: ${r2Err.message}`);
      candidates = retryCandidates2 || [];
    }

    // 4. Fallback for any unsubmitted ready_for_review applications (e.g. tasks reset to ready_for_review)
    if (!candidates || candidates.length === 0) {
      let retryQuery3 = supabase
        .from('job_distributions')
        .select('id, status, applywizz_id, job_url, company, role_title, error_message, resolved_answers, application_submitted_screenshot_url')
        .eq('status', 'ready_for_review')
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .neq('status', 'archived')
        .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%');

      const { data: retryCandidates3, error: r3Err } = await retryQuery3
        .order('updated_at', { ascending: true })
        .limit(10);
      if (r3Err) console.warn(`[${workerId}] retryQuery3 error: ${r3Err.message}`);
      candidates = retryCandidates3 || [];
    }

    if (!candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
      // Atomic CAS claim directly on job_distributions row:
      // Strictly claims ONLY IF status is currently 'ready_for_review' and application is not already submitted
      const { data: claimed, error: claimErr } = await supabase
        .from('job_distributions')
        .update({
          status: 'applying',
          worker_id: workerId,
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', cand.id)
        .eq('status', 'ready_for_review')
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.ilike.%review_blueprint%,application_submitted_screenshot_url.not.ilike.%workday-submitted%')
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .select('id, applywizz_id, job_url, company, role_title, error_message, resolved_answers');

      if (!claimErr && claimed && claimed.length > 0) {
        const claimedDist = claimed[0];

        // Immediately reflect in_flight state in worker_status table for dashboard and multi-replica visibility
        try {
          const { updateWorkerStatus } = await import('./supabaseClient.mjs');
          const workerNum = String(workerId).replace(/\D+/g, '') || '1';
          await updateWorkerStatus(workerId, {
            state: 'in_flight',
            stage: 'submitting',
            current_application_id: claimedDist.id,
            bot_name: `Submitting Worker ${workerNum}`,
            updated_at: now,
          });
        } catch {}

        // Format task object for worker execution directly from job_distributions
        const claimedTask = {
          id: claimedDist.id,
          distribution_id: claimedDist.id,
          applywizz_id: claimedDist.applywizz_id || cand.applywizz_id,
          job_url: claimedDist.job_url || cand.job_url,
          company: claimedDist.company || cand.company,
          role_title: claimedDist.role_title || cand.role_title,
          status: 'applying',
          error_message: claimedDist.error_message || cand.error_message,
          resolved_answers: claimedDist.resolved_answers || claimedDist.resolved_answers_json || cand.resolved_answers,
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
    const { updateWorkerStatus } = await import('./supabaseClient.mjs');
    const workerNum = String(workerId).replace(/\D+/g, '') || '1';
    await Promise.allSettled([
      supabase
        .from('job_distributions')
        .update({
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', taskId)
        .eq('worker_id', workerId)
        .eq('status', 'applying'),
      updateWorkerStatus(workerId, {
        state: 'in_flight',
        stage: 'submitting',
        current_application_id: taskId,
        bot_name: `Submitting Worker ${workerNum}`,
        updated_at: now,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}



/**

 * Reaper: Reverts tasks with expired lease (> timeoutMinutes) back to 'ready_for_review'

 * on job_distributions directly. NEVER sets 'failed'.

 */

export async function reapExpiredLeases(timeoutMinutes = 3) {

  if (!supabase || !canExecuteWorkers()) return [];

  try {

    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

    const now = new Date().toISOString();



    const { data: expiredByTime } = await supabase
      .from('job_distributions')
      .select('id, worker_id, applywizz_id, application_submitted_screenshot_url')
      .eq('status', 'applying')
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .lt('worker_leased_at', cutoff);

    const { data: expiredByNull } = await supabase
      .from('job_distributions')
      .select('id, worker_id, applywizz_id, application_submitted_screenshot_url')
      .eq('status', 'applying')
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .is('worker_leased_at', null);

    const seen = new Set();
    const expired = [...(expiredByTime || []), ...(expiredByNull || [])].filter((row) => {
      if (!row?.id || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    if (!expired || expired.length === 0) return [];

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
        .neq('status', 'submitted')
        .neq('status', 'completed')
        .select('id');



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

export async function processClaimedTask({ task, workerId, headless = (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) ? true : (process.env.HEADLESS !== 'false'), runnerFn = null, options = {} }) {

  if (!task || !workerId) return { success: false, error: 'Invalid task or workerId' };



  const previousFailedAttempts = getSubmissionAttemptCount(task.error_message);

  const currentAttempt = previousFailedAttempts + 1; // 1, 2, or 3

  const isFinalAttempt = currentAttempt >= 3;



  const serviceName = getSubmissionServiceName();
  console.log(`[${serviceName}] [${workerId}] [${task.applywizz_id}] | Company: ${task.company || 'Workday'} | Status: submitting | Screenshot: none`);



  // Update worker_status table
  const workerNum = String(workerId).replace(/\D+/g, '') || '1';
  await updateWorkerStatus(workerId, {
    state: 'in_flight',
    stage: 'submitting',
    current_application_id: task.id,
    bot_name: `Submitting Worker ${workerNum}`,
    updated_at: new Date().toISOString(),
  }).catch(() => { });

  // ⚡ Pre-Browser Fast Check: Skip browser if candidate already submitted or applied to this job
  const priorApp = await checkIfClientAlreadyAppliedToJob({
    applywizzId: task.applywizz_id,
    jobUrl: task.job_url,
    company: task.company,
    currentTaskId: task.id,
  });

  if (priorApp.alreadyApplied) {
    const formattedDate = priorApp.matchedDate ? new Date(priorApp.matchedDate).toLocaleDateString() : 'prior run';
    console.log(`⚡ [${serviceName}] [${workerId}] [PRE-CHECK FAST-PATH] Candidate ${task.applywizz_id} already applied to ${task.company} (matched ${priorApp.matchType} #${priorApp.matchedId} on ${formattedDate}). Skipping browser launch!`);

    await updateJobDistributionWithCheck({
      id: task.id,
      status: 'already_applied',
      application_submitted_screenshot_url: priorApp.screenshotUrl || 'prior_submission_proof',
      error_message: `Pre-check: Already applied (matched previous submission #${priorApp.matchedId} on ${formattedDate})`,
      updated_at: new Date().toISOString(),
    });

    return {
      success: true,
      status: 'already_applied',
      skippedBrowser: true,
      screenshotUrl: priorApp.screenshotUrl,
      reason: `Pre-check: Already applied (matched prior submission #${priorApp.matchedId})`,
    };
  }



  // Start 30-second heartbeat interval with a 15-minute hard limit
  let heartbeatActive = true;
  const heartbeatStartTime = Date.now();
  const MAX_HEARTBEAT_DURATION_MS = 15 * 60 * 1000; // 15 mins max for a single submission task

  const heartbeatTimer = setInterval(() => {
    if (heartbeatActive) {
      if (Date.now() - heartbeatStartTime > MAX_HEARTBEAT_DURATION_MS) {
        console.warn(`[${workerId}] Heartbeat duration limit reached (15m) for task #${task.id}. Stopping heartbeat so reaper can recover.`);
        stopHeartbeat();
        return;
      }
      sendTaskHeartbeat(task.id, workerId).catch(() => { });
    }
  }, 30_000);



  function stopHeartbeat() {

    heartbeatActive = false;

    clearInterval(heartbeatTimer);

  }



  // B4 Task Watchdog: configurable or 25-minute default per task (prevents runaway browser while allowing multi-step forms)
  const WATCHDOG_TIMEOUT_MS = options?.watchdogTimeoutMs
    || (process.env.SUBMISSION_WATCHDOG_TIMEOUT_MS ? parseInt(process.env.SUBMISSION_WATCHDOG_TIMEOUT_MS, 10) : 25 * 60 * 1000);
  const watchdogMins = Math.round(WATCHDOG_TIMEOUT_MS / 60000);

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



        const resetMatch = String(task.error_message || '').match(/\[password_reset_requested:(\d+)\]/);
        const passwordResetRequestedAt = resetMatch ? parseInt(resetMatch[1], 10) : null;

        const { executeWorkerTask } = await import('./workerPool.mjs');

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

            passwordResetRequestedAt,

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

        console.log(`[${workerId}] watchdog fired: task timed out after ${watchdogMins} minutes (task #${task.id})`);

        stopHeartbeat();



        let shotPath = null;

        let shotUrl = null;

        try {

          const ctx = getWorkerContext(workerId);

          // Strictly capture and upload failure screenshot on ANY attempt where failure/timeout occurs
          if (ctx?.page && !ctx.page.isClosed()) {

            const buf = await ctx.page.screenshot({ type: 'png', fullPage: true, timeout: 8000 })
              .catch(() => ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null));

            if (buf) {

              const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();

              const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();

              const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;

              const timestamp = Date.now();

              shotPath = `${compPrefix}_${task.id}_attempt${currentAttempt}_failed_${timestamp}.png`;

              const { error: upErr } = await supabase.storage

                .from('failed-applications')

                .upload(shotPath, buf, { contentType: 'image/png', upsert: true });

              if (!upErr) {

                const { data: urlData } = supabase.storage

                  .from('failed-applications')

                  .getPublicUrl(shotPath);

                shotUrl = urlData?.publicUrl || null;

                console.log(`[${workerId}] Attempt ${currentAttempt} failure screenshot uploaded: ${shotPath}`);

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

          error: `Task timed out after ${watchdogMins} minutes`,

          stoppedAtStep: `Watchdog Timeout (${watchdogMins} min)`,

          screenshotUrl: shotUrl,

          screenshotPath: shotPath,

        });

      }, WATCHDOG_TIMEOUT_MS);

    });



    result = await Promise.race([taskExecutionPromise, watchdogPromise]);

    if (watchdogTimer) clearTimeout(watchdogTimer);

    stopHeartbeat();



    const now = new Date().toISOString();

    let finalShotUrl = result?.screenshotUrl || result?.reviewScreenshotUrl || result?.failureScreenshotUrl || null;

    let finalStoragePath = result?.screenshotPath || null;

    const isSubmittedProof = Boolean(
      (typeof finalShotUrl === 'string' && (
        (finalShotUrl.includes('submitted-applications') && !finalShotUrl.includes('review_blueprint')) ||
        finalShotUrl.includes('workday-submitted')
      )) ||
      (typeof result?.screenshotUrl === 'string' && (
        (result.screenshotUrl.includes('submitted-applications') && !result.screenshotUrl.includes('review_blueprint')) ||
        result.screenshotUrl.includes('workday-submitted')
      ))
    );

    const isSuccess = (
      result?.status === 'submitted' ||
      result?.status === 'success' ||
      result?.submitted === true ||
      result?.isSubmitted === true ||
      isSubmittedProof
    );

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
      const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
      console.log(`[${cleanId}] | Company: ${task.company || 'Workday'} | Status: submitted | Screenshot: ${finalShotUrl || 'none'}`);

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
      const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
      console.log(`[${cleanId}] | Company: ${task.company || 'Workday'} | Status: already_applied | Screenshot: ${finalShotUrl || 'none'}`);



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
      const rawErrMsg = result?.error || result?.reason || result?.failureReason || `Submission ended with status: ${result?.status || 'failed'}`;
      let failedStep = result?.stoppedAtStep || result?.stoppedBlock || result?.step || 'Unknown Step';
      if (/auth|login|zoho|mailbox|sign[- ]?in|verification/i.test(rawErrMsg) || result?.status === 'auth-failed' || result?.status === 'zoho_not_connected' || result?.isZohoNotConnected) {
        failedStep = 'Authentication';
      }

      const isUserStop = Boolean(
        result?.status === 'stopped' ||
        /stopped by user|stop requested/i.test(rawErrMsg) ||
        isGlobalStopRequested() ||
        isSubmitStopRequested()
      );

      if (isUserStop) {
        console.log(`🛑 [STAGE 3: SUBMITTER] [${workerId}] Application #${task.distribution_id || task.id} halted by user stop signal — preserving cleanly in ready_for_review without burning attempts.`);
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id || task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            worker_leased_at: null,
            error_message: 'Stopped by user',
            updated_at: now,
          },
        });
        return { status: 'stopped', reason: 'Stopped by user' };
      }

      // PASSWORD RESET PENDING: Protect against attempt burn while waiting for Zoho Mail delivery
      const isPasswordResetPending = Boolean(
        result?.passwordResetPending ||
        result?.reason === 'password_reset_pending' ||
        /password_reset_pending|password reset requested/i.test(rawErrMsg)
      );

      if (isPasswordResetPending) {
        const resetMsg = result?.error || `[Attempt 1/3] Halted at "Authentication": [password_reset_requested:${result?.requestedAt || Date.now()}] Password reset requested on Workday — awaiting Zoho Mail delivery (valid for 2 hours)`;
        const resetShot = result?.screenshotUrl || finalShotUrl;
        console.log(`⏳ [STAGE 3: SUBMITTER] [${workerId}] Password reset instructions submitted for ${task.applywizz_id} — preserving in ready_for_review without burning attempt count.`);
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id || task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            worker_leased_at: null,
            error_message: resetShot ? `${resetMsg} [diagnostic_screenshot: ${resetShot}]` : resetMsg,
            application_submitted_screenshot_url: resetShot || undefined,
            updated_at: now,
          },
        });
        return { status: 'ready_for_review', reason: 'password_reset_pending' };
      }

      const isHostResourceError = Boolean(
        /spawn.*EAGAIN|browserType\.launch|Failed to launch|HOST_RESOURCE_EXHAUSTION|ENOMEM|EACCES/i.test(rawErrMsg)
      );

      if (isHostResourceError) {
        console.warn(`\n⚠️ [STAGE 3: SUBMITTER] [${workerId}] Host resource limitation detected (${rawErrMsg}). Preserving task #${task.distribution_id || task.id} in ready_for_review WITHOUT burning attempt count.`);
        try {
          const { cleanupOrphanChromeProcesses } = await import('./browserLifecycle.mjs');
          cleanupOrphanChromeProcesses();
        } catch {}
        await updateJobDistributionWithCheck({
          distributionId: task.distribution_id || task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          workerId,
          patch: {
            status: 'ready_for_review',
            worker_id: null,
            worker_leased_at: null,
            error_message: '[Resource Cooldown] Host process limit reached (EAGAIN) — standing by for resources',
            updated_at: now,
          },
        });
        await new Promise((r) => setTimeout(r, 10000));
        return { status: 'resource_cooldown', error: rawErrMsg };
      }



      const isZohoNotConnected = Boolean(

        /zoho.*not.*connected|mailbox.*not.*connected/i.test(rawErrMsg) ||

        result?.isZohoNotConnected ||

        result?.status === 'zoho_not_connected' ||

        result?.reason === 'zoho mail not connected' ||

        result?.reason === 'mailbox_not_connected'

      );



      const isFatalNonRetryable = Boolean(
        result?.status === 'job_expired' ||
        result?.status === 'invalid_url' ||
        /dead\/expired|does not exist|error 404/i.test(rawErrMsg)
      );

      if (isZohoNotConnected) {
        const cleanAwl = String(task.applywizz_id).replace(/["'\[\]]/g, '').trim().toUpperCase();
        const zohoErr = `zoho mail not connected (AWL-ID: ${cleanAwl}, mail: ${task.candidateEmail || ''})`;
        console.log(`⚠️ [STAGE 3: SUBMITTER] [${workerId}] Zoho mail not connected for ${task.applywizz_id} (${task.candidateEmail || 'no email'}) on Attempt ${currentAttempt}/3.`);

        if (task.candidateEmail) {
          const { updateClientZohoStatus } = await import('./supabaseClient.mjs');
          await updateClientZohoStatus(task.candidateEmail, { status: 'not_connected', connected: false }).catch(() => {});
        }
      }

      if (currentAttempt < 3 && !isFatalNonRetryable) {

        // Attempts 1 and 2: STRICT PROGRESSIVE RETRY POLICY
        // Strictly capture and save failure screenshot for Attempt 1 / Attempt 2
        if (!finalShotUrl) {
          try {
            const ctx = getWorkerContext(workerId);
            if (ctx?.page && !ctx.page.isClosed()) {
              const buf = await ctx.page.screenshot({ type: 'png', fullPage: true, timeout: 8000 })
                .catch(() => ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null));
              if (buf) {
                const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
                const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
                const timestamp = Date.now();
                const shotPath = `${compPrefix}_${task.id}_attempt${currentAttempt}_failed_${timestamp}.png`;
                const { error: upErr } = await supabase.storage
                  .from('failed-applications')
                  .upload(shotPath, buf, { contentType: 'image/png', upsert: true });
                if (!upErr) {
                  const { data: urlData } = supabase.storage
                    .from('failed-applications')
                    .getPublicUrl(shotPath);
                  finalShotUrl = urlData?.publicUrl || null;
                  console.log(`[${workerId}] Attempt ${currentAttempt} failure screenshot uploaded: ${shotPath}`);
                }
              }
            }
          } catch (fShotErr) {
            console.warn(`[${workerId}] Attempt ${currentAttempt} screenshot capture error:`, fShotErr.message);
          }
        }

        const retryMsg = `[Attempt ${currentAttempt}/3] Halted at "${failedStep}": ${rawErrMsg}`;

        console.log(`🔄 [STAGE 3: SUBMITTER] [${workerId}] Attempt ${currentAttempt}/3 failed for ${task.applywizz_id} @ ${task.company || 'Workday'} (step: ${failedStep}). Reverted to ready_for_review. Reason: ${rawErrMsg} | Screenshot: ${finalShotUrl || 'None'}`);



        await updateJobDistributionWithCheck({

          distributionId: task.distribution_id || task.id,

          applywizzId: task.applywizz_id,

          jobUrl: task.job_url,

          workerId,

          patch: {

            status: 'ready_for_review',

            worker_id: null,

            worker_leased_at: null,

            error_message: finalShotUrl ? `${retryMsg} [diagnostic_screenshot: ${finalShotUrl}]` : retryMsg,

            application_submitted_screenshot_url: finalShotUrl || undefined,

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
        if (!finalShotUrl) finalShotUrl = result?.screenshotUrl || result?.failureScreenshotUrl || result?.reviewScreenshotUrl || null;

        if (!finalShotUrl) {
          try {
            const ctx = getWorkerContext(workerId);
            if (ctx?.page && !ctx.page.isClosed()) {
              const buf = await ctx.page.screenshot({ type: 'png', fullPage: true, timeout: 8000 })
                .catch(() => ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null));
              if (buf) {
                const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
                const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;
                const timestamp = Date.now();
                const shotPath = `${compPrefix}_${task.id}_attempt3_failed_${timestamp}.png`;

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

        const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();
        console.log(`[${cleanId}] | Company: ${task.company || 'Workday'} | Status: failed | Reason: ${rawErrMsg} | Screenshot: ${finalShotUrl || 'none'}`);



        const failPatch = {
          status: 'failed',
          worker_id: null,
          worker_leased_at: null,
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
            failureReason: isFatalNonRetryable && (result?.status === 'job_expired' || /expired|no longer available/i.test(rawErrMsg))
              ? 'expired'
              : `${rawErrMsg} (Attempt 3/3 exhausted)`,
            failedAtStep: isFatalNonRetryable && (result?.status === 'job_expired' || /expired|no longer available/i.test(rawErrMsg))
              ? 'Job Discovery / Link Expired'
              : failedStep,
            screenshotPath: finalShotUrl,
          });

          if (result?.status === 'job_expired' || /expired|no longer available/i.test(rawErrMsg)) {
            try {
              await supabase.from('batch_job_queue')
                .update({
                  status: 'expired',
                  screenshot_path: finalShotUrl,
                  worker_id: null,
                  locked_at: null,
                  updated_at: now,
                })
                .eq('job_url', task.job_url);
            } catch {}
          }
        } catch (recErr) {
          console.warn(`[${workerId}] Warning writing to failed_jobs:`, recErr.message);
        }

      }

    }

  } catch (err) {

    stopHeartbeat();

    if (watchdogTimer) clearTimeout(watchdogTimer);



    const prevResult = result;
    const existingShotUrl = prevResult?.screenshotUrl || prevResult?.failureScreenshotUrl || prevResult?.reviewScreenshotUrl || null;

    result = {
      status: 'failed',
      error: err?.message || 'Execution error',
      stoppedAtStep: 'Execution Exception',
      screenshotUrl: existingShotUrl,
    };

    const now = new Date().toISOString();

    const previousFailedAttempts = getSubmissionAttemptCount(task.error_message);
    const currentAttempt = previousFailedAttempts + 1;
    const isFinalAttempt = currentAttempt >= 3;

    let errShotUrl = existingShotUrl || null;
    let errShotPath = prevResult?.screenshotPath || null;



    // Strictly capture and upload failure screenshot on ANY attempt where exception occurs
    try {

      const ctx = getWorkerContext(workerId);

      if (ctx?.page && !ctx.page.isClosed()) {

        const buf = await ctx.page.screenshot({ type: 'png', fullPage: true, timeout: 8000 })
          .catch(() => ctx.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null));

        if (buf) {

          const cleanId = String(task.applywizz_id).replace(/["'\[\]\\]/g, '').trim().toUpperCase();

          const cleanCompany = String(task.company || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();

          const compPrefix = cleanCompany ? `${cleanId}_${cleanCompany}` : cleanId;

          const timestamp = Date.now();

          errShotPath = `${compPrefix}_${task.id}_attempt${currentAttempt}_failed_${timestamp}.png`;

          const { error: upErr } = await supabase.storage

            .from('failed-applications')

            .upload(errShotPath, buf, { contentType: 'image/png', upsert: true });

          if (!upErr) {

            const { data: urlData } = supabase.storage

              .from('failed-applications')

              .getPublicUrl(errShotPath);

            errShotUrl = urlData?.publicUrl || errShotUrl;

            console.log(`[${workerId}] Attempt ${currentAttempt} exception screenshot uploaded: ${errShotPath}`);

          }

        }

      }

    } catch (catchShotErr) {

      console.warn(`[${workerId}] Exception screenshot capture error:`, catchShotErr.message);

    }



    result.screenshotUrl = errShotUrl;

    result.screenshotPath = errShotPath;



    const errMsg = err?.message || 'Execution error';
    const failedStep = 'Execution Exception';

    const isHostResourceError = Boolean(
      /HOST_RESOURCE_EXHAUSTION|spawn.*EAGAIN|pthread_create|browserType\.launch|Target page, context or browser has been closed|Failed to launch|ENOMEM|EACCES/i.test(errMsg)
    );

    if (isHostResourceError) {
      console.warn(`\n⚠️ [STAGE 3: SUBMITTER] [${workerId}] Host resource limitation caught in outer handler (${errMsg}). Preserving task #${task.distribution_id || task.id} cleanly in ready_for_review WITHOUT burning attempts.`);
      try {
        const { cleanupOrphanChromeProcesses } = await import('./browserLifecycle.mjs');
        cleanupOrphanChromeProcesses();
      } catch {}
      await updateJobDistributionWithCheck({
        distributionId: task.distribution_id || task.id,
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        workerId,
        patch: {
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          error_message: '[Resource Cooldown] Host process limit reached (EAGAIN) — standing by for resources',
          updated_at: now,
        },
      });
      await new Promise((r) => setTimeout(r, 10000));
      return { status: 'resource_cooldown', error: errMsg };
    }

    const isFatalNonRetryable = Boolean(
      /dead\/expired|does not exist|error 404/i.test(errMsg) ||
      prevResult?.status === 'job_expired' ||
      prevResult?.status === 'invalid_url'
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

          error_message: errShotUrl ? `${retryMsg} [diagnostic_screenshot: ${errShotUrl}]` : retryMsg,

          application_submitted_screenshot_url: errShotUrl || undefined,

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
        worker_id: null,
        worker_leased_at: null,
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

    const workerNum = String(workerId).replace(/\D+/g, '') || '1';
    await updateWorkerStatus(workerId, {
      state: 'idle',
      stage: 'submitting',
      current_application_id: null,
      bot_name: `Submitting Worker ${workerNum}`,
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



  console.log(`[BATCH SUMMARY] Cycle #${cycleIndex}: ${submittedCount}/${count} submitted (${successRate}%), ${failedCount} failed | Total: ${totalCount}`);

}



export const print10SubmissionMilestoneReport = print10ClientSubmissionMilestoneReport;



