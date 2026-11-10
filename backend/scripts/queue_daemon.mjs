/**
 * queue_daemon.mjs — 9-Worker Pipeline Autonomous Webhook Engine & Controller
 * ===========================================================================
 * Event-driven webhook controller with instant (<500ms) browser abortion.
 *
 * Pipeline Architecture:
 *   - Strictly 9 Canonical Workers in worker_status:
 *       • Scanning (3): scanning_worker_1, scanning_worker_2, scanning_worker_3
 *       • Resolving (3): resolving_worker_1, resolving_worker_2, resolving_worker_3
 *       • Submitting (3): submitting_worker_1, submitting_worker_2, submitting_worker_3
 *   - Global Control: public.bot_control table ('primary' row) tracks pipeline state,
 *     stop signals, active worker counts, and trigger requests.
 *   - Stage 1 (Scanning): 3 scanning workers visit unique links, extract schemas,
 *     scrape questions with field types & options, and save blueprint -> scanned_jobs.
 *   - Stage 2 (Resolving): 3 resolving workers match candidate facts, resumes, and
 *     QA bank into structured 4-tier answers -> job_distributions (status: 'ready_for_review').
 *   - CA Review Pause: Career Associates review answers and inspect proof in UI.
 *   - Stage 3 (Submissions): 3 submitting workers execute Playwright form filling on Workday,
 *     commit inputs with Enter/blur, verify DOM, submit, capture authentic confirmation
 *     screenshot, and update status to 'submitted'.
 */

import http from 'node:http';
import '../lib/polyfills.mjs';
import {
  loadLocalEnvOnce,
  assertRequiredEnv,
  isSupabaseConfigured,
  updateDaemonCaState,
  updateWorkerStatus,
  getWorkerStatuses,
  ensureCanonicalWorkers,
  getBotControl,
  updateBotControl,
  getWorkerControls,
  updateWorkerControl,
} from '../lib/supabaseClient.mjs';
import { PIPELINE_CONFIG, WORKER_COUNT } from '../config/pipelineConfig.mjs';
import {
  setGlobalStop,
  isGlobalStopRequested,
  abortAllActiveBrowsers,
  abortScanBrowsers,
  abortSubmitBrowsers,
  setScanStop,
  isScanStopRequested,
  setSubmitStop,
  isSubmitStopRequested,
} from '../lib/browserLifecycle.mjs';
import { setClusterStop } from '../lib/clusterBatchRunner.mjs';
import { createClient } from '@supabase/supabase-js';
import { handleAuthRequest, handleOperatorsRequest, authenticateStaffRole } from '../lib/authService.mjs';
import { handleAdminStatsRequest } from '../lib/adminStatsService.mjs';
import {
  handleAdminDashboardRequest,
  handleDeveloperDashboardRequest,
  handleManagerDashboardRequest,
} from '../lib/dashboardStats.mjs';
import {
  handleAdminApplicationsRequest,
  handleDeveloperApplicationsRequest,
  handleManagerApplicationsRequest,
} from '../lib/dashboardApplications.mjs';
import {
  handleUnifiedStatsRequest,
  handleClientApplicationsRequest,
} from '../lib/unifiedStatsService.mjs';
import {
  getActiveClientsRoster,
  syncActiveClientProfiles,
} from '../lib/activeClientsSyncService.mjs';

loadLocalEnvOnce();
assertRequiredEnv();

if (!isSupabaseConfigured()) {
  console.error('[DAEMON FATAL] Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Configuration
const args = process.argv.slice(2);
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT) || Boolean(process.env.RAILWAY_STATIC_URL);
// In production (Railway), HEADLESS is strictly enforced.
// On local machines, HEADLESS is true by default unless --headed is explicitly passed.
const HEADLESS = isProduction ? true : (process.env.HEADLESS !== 'false' && !args.includes('--headful') && !args.includes('--headed'));
const TEST_MODE = args.includes('--test');

let envRole = (process.env.SERVICE_ROLE || '').toLowerCase();
if (!envRole) {
  if (args.includes('submitter') || args.includes('submit') || args.includes('--submit')) {
    envRole = 'submitter';
  } else if (args.includes('scanner') || args.includes('scan') || args.includes('--scan')) {
    envRole = 'scanner';
  } else {
    envRole = 'all';
  }
}
export const SERVICE_ROLE = envRole;

let defaultPort = 3001;
if (SERVICE_ROLE === 'submitter') {
  defaultPort = 3002;
}
const PORT = Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || defaultPort;

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}
console.log(`[DAEMON] Active Service Role: "${SERVICE_ROLE.toUpperCase()}" on PORT ${PORT} (main = 0 workers, scanner = scan only, submitter = submit only, all = combined).`);

let isPoolRunning = false;
let isPoolPaused = false;
let currentStage = 'idle';
let currentMode = 'idle'; // 'idle' | 'scanning' | 'submitting' (R3 Sequence and Mode Lock)
let scanStatus = 'off';   // 'off' | 'running' | 'stopping' (R11 Independent Toggle State)
let submitStatus = 'off'; // 'off' | 'running' | 'stopping' (R11 Independent Toggle State)
let scanStopRequested = false;
let submitStopRequested = false;
let scanCompleteMessage = null; // "Scan complete: ready for Submit."
let submitRefusalReason = null;
let scanRefusalReason = null;

// In-memory ring buffers for streaming live logs to dashboard (R11 Separate Logs)
export const daemonLogs = [];
export const scanLogs = [];
export const submitLogs = [];

const origLog = console.log;
const origErr = console.error;

// Streamlined Log Filter: Strips micro-step DOM noise and large ASCII banners so Railway logs never exceed limits
const NOISE_PATTERNS = [
  /^[═─┌└┼│\s\-─=]{6,}$/,
  /data-automation-id/i,
  /querySelector|querySelectorAll/i,
  /waiting for selector/i,
  /dispatching (change|blur|input)/i,
  /fuzzyScore|tokenSetRatio/i,
  /finding container/i,
  /clicking option/i,
  /element evaluated/i,
  /looking up label/i,
  /parsing resume/i,
  /found \d+ inputs/i,
  /table:\s*job_distributions\s*#\d+/i,
  /raw_profile_json/i,
  /^\s*•\s*(Candidate AWL-ID|Target URL|Submission Attempt|Worker Concurrency|Table:)/i,
];

function isNoisyLog(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;

  // 1. Mandatory candidate step & lifecycle logs:
  // e.g. [AWL-6307] Scanning: MY INFORMATION
  // e.g. [AWL-6307] Submitting: MY INFORMATION
  // e.g. [AWL-6307] scanned_completed | Status: ready_for_review
  // e.g. [AWL-6307] submission_completed | Screenshot: ...
  // e.g. [AWL-6307] already_applied | Screenshot: ...
  if (/^\[AWL-[A-Za-z0-9_-]+\]/i.test(trimmed)) {
    return false;
  }

  // 2. 10-Submission Milestone Report, Table Rows, Summaries & Batch Proof Screenshots:
  if (
    /MILESTONE REPORT/i.test(trimmed) ||
    /STATS SUMMARY/i.test(trimmed) ||
    /PROOF SCREENSHOTS/i.test(trimmed) ||
    /Batch Items Processed/i.test(trimmed) ||
    /Batch Success Rate/i.test(trimmed) ||
    /^#\s*\|\s*Candidate\s*\|\s*Company/i.test(trimmed) ||
    /^\d+\s*\|\s*AWL-[A-Za-z0-9_-]+/i.test(trimmed) ||
    /^\[#\d+\]\s*[✅❌ℹ️]/i.test(trimmed) ||
    /^[═─┌└┼│\-─=]{10,}$/.test(trimmed)
  ) {
    return false;
  }

  // 3. Candidate submission results and dispatcher announcements:
  // e.g. ✅ [SUBMISSION RESULT] AWL-ID: AWL-1568 | Status: SUBMITTED | ...
  // e.g. 📋 [SUBMITTER DISPATCH] AWL-ID: AWL-1568 | Status: SUBMITTED | ...
  // e.g. 🚀 [SUBMISSION WORKER] submitting_worker_1 atomically claimed task ...
  // e.g. ⚡ [submitting_worker_1] Completed application & saved proof screenshot ...
  if (/(\[SUBMISSION RESULT\]|\[SUBMITTER DISPATCH\]|\[SUBMISSION WORKER\]|\[.*-WORKER DISPATCHER\])/i.test(trimmed)) {
    return false;
  }
  if (/^⚡\s*\[(submitting_worker|scanning_worker|resolving_worker)/i.test(trimmed)) {
    return false;
  }
  if (/^📋\s*\[SUBMITTER/i.test(trimmed)) {
    return false;
  }

  // 4. Essential high-level setup and phase milestones (cluster assignment, clean links, auth):
  if (/^(\[SCANNER\]\s*\[.*\]\s*Assigned cluster|📋\s*Found\s*\d+\s*clean|🔍\s*\[PHASE|\[Zoho\]|🔒\s*\[STRICT AUTH GUARD\]|ℹ️\s*Rollover:)/i.test(trimmed)) {
    return false;
  }

  // 5. Essential high-level daemon signals, service role startup, stop requests, & milestone status:
  if (/^\[DAEMON\]\s*(Active Service Role|PORT|⚠️\s*TEST MODE)/i.test(trimmed)) {
    return false;
  }
  if (/^[🛑✅❌⚠️ℹ️🚀⚡]\s*\[(DAEMON|SCANNER|SUBMITTER|STAGE|SUBMISSION)/i.test(trimmed)) {
    if (/(Field \d|disarmed|unfilled|still empty|waiting for selector|Attempt \d)/i.test(trimmed)) {
      return true;
    }
    return false;
  }
  if (/^\[DAEMON.*TRIGGER\]/i.test(trimmed)) {
    return false;
  }
  if (/^\[(SCANNER|SUBMITTER|DAEMON|MAIN APP|SUBMISSION WORKER)\]/i.test(trimmed)) {
    if (/(Field \d|disarmed|unfilled|still empty|waiting for selector|Attempt \d)/i.test(trimmed)) return true;
    return false;
  }

  // 6. Suppress all other micro-step logs, DOM operations, ASCII banners, and dumps:
  return true;
}

function routeLogEntry(level, args) {
  try {
    const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const isSubmitRelated = (
      SERVICE_ROLE === 'submitter' ||
      text.includes('SUBMISSION') ||
      text.includes('SUBMIT') ||
      text.includes('Submit') ||
      text.includes('submitting') ||
      text.includes('already_applied') ||
      text.includes('MILESTONE REPORT') ||
      text.includes('STATS SUMMARY') ||
      text.includes('10-SUBMISSION') ||
      text.includes('Proof Screenshot')
    );
    const cluster = isSubmitRelated ? 'Submit' : (currentStage === 'resolving' ? 'Resolve' : 'Scan');

    const entry = { ts: new Date().toISOString(), message: text, level, cluster };

    daemonLogs.push(entry);
    if (daemonLogs.length > 500) daemonLogs.shift();

    if (isSubmitRelated) {
      submitLogs.push({ ...entry, cluster: 'Submit' });
      if (submitLogs.length > 500) submitLogs.shift();
    } else {
      scanLogs.push(entry);
      if (scanLogs.length > 500) scanLogs.shift();
    }
  } catch { }
}

console.log = function (...args) {
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (isNoisyLog(text)) return;
  origLog.apply(console, args);
  routeLogEntry('info', args);
};

console.error = function (...args) {
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (isNoisyLog(text)) return;
  origErr.apply(console, args);
  routeLogEntry('error', args);
};

const ALL_CANONICAL_WORKERS = PIPELINE_CONFIG.allWorkerIds || Array.from({ length: 3 }, (_, i) => `submitting_worker_${i + 1}`);

/**
 * Reset all 10 workers in worker_status to idle
 */
async function resetAllWorkersIdle() {
  for (const wId of ALL_CANONICAL_WORKERS) {
    const meta = PIPELINE_CONFIG.workerNames[wId] || `Worker ${wId.replace('worker_', '')}`;
    await updateWorkerStatus(wId, {
      state: 'idle',
      current_application_id: null,
      stage: 'idle',
      bot_name: meta,
    }).catch(() => { });
  }
}

/**
 * Synchronize global bot_control table state (R3 mode lock & R11 independent columns)
 */
async function syncBotControlState(patch = {}) {
  // Guard against idle service overwriting active opposite service
  if (!isPoolRunning && !patch.is_running) {
    const bc = await getBotControl().catch(() => null);
    if (SERVICE_ROLE === 'scanner' && (bc?.stage === 'submitting' || bc?.stage === 'parallel' || bc?.last_action_requested?.includes('submit')) && bc?.is_running) {
      return;
    }
    if (SERVICE_ROLE === 'submitter' && (bc?.stage === 'scanning' || bc?.stage === 'resolving' || bc?.stage === 'parallel' || bc?.last_action_requested?.includes('scan')) && bc?.is_running) {
      return;
    }
  }

  const sanitizedPatch = { ...patch };

  if (SERVICE_ROLE === 'submitter') {
    delete sanitizedPatch.scan_status;
    delete sanitizedPatch.scan_enabled;
    delete sanitizedPatch.scan_stop_requested;
    delete sanitizedPatch.scan_run_id;
    delete sanitizedPatch.scan_run_started_at;
  } else if (SERVICE_ROLE === 'scanner') {
    delete sanitizedPatch.submit_status;
    delete sanitizedPatch.submit_enabled;
    delete sanitizedPatch.submit_stop_requested;
  }



  const updatePayload = {
    stage: sanitizedPatch.stage || currentStage,
    current_action: sanitizedPatch.current_action || (isPoolRunning ? `Running ${currentStage}...` : 'Idle'),
    active_worker_count: sanitizedPatch.active_worker_count !== undefined ? sanitizedPatch.active_worker_count : (isPoolRunning ? (currentStage === 'submitting' ? Math.max(activeSubmittingWorkers.size, 1) : WORKER_COUNT) : 0),
    ...sanitizedPatch,
  };
  if (sanitizedPatch.is_running !== undefined) updatePayload.is_running = sanitizedPatch.is_running;
  if (sanitizedPatch.is_paused !== undefined) updatePayload.is_paused = sanitizedPatch.is_paused;
  if (sanitizedPatch.stop_requested !== undefined) updatePayload.stop_requested = sanitizedPatch.stop_requested;
  if (sanitizedPatch.trigger_requested !== undefined) updatePayload.trigger_requested = sanitizedPatch.trigger_requested;
  if (sanitizedPatch.last_action_requested !== undefined) updatePayload.last_action_requested = sanitizedPatch.last_action_requested;

  await updateBotControl(updatePayload).catch(() => { });
}

/**
 * R3: Server-side check if Stage 1 is fully complete before Submit is allowed.
 * Stage 2: SUBMIT. Starts only after Stage 1 is fully complete (no pending or in-progress
 * batch_job_queue / job_distributions work, no active scan or resolve worker).
 */
export async function checkStage1Completion() {
  let pendingBatchCount = 0;
  try {
    const { count, error: bqErr } = await supabase
      .from('batch_job_queue')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'processing']);

    if (!bqErr && typeof count === 'number') {
      pendingBatchCount = count;
    }
  } catch { }

  if (pendingBatchCount > 0) {
    console.log(`[DAEMON] Note: ${pendingBatchCount} batch item(s) pending/processing in Stage 1. Proceeding with submissions for all ready/approved applications.`);
  }

  return {
    allowed: true,
    pendingBatchCount,
    statusNote: pendingBatchCount > 0 ? `${pendingBatchCount} items pending scan & resolve` : 'Stage 1 complete',
  };
}

/**
 * Server-side check if Scan is allowed
 */
export function checkCanStartScan() {
  return { allowed: true };
}

/**
 * R11: Stop Scan & Resolve ONLY.
 * Turning Scan OFF or Stop must NOT touch submission_tasks!
 */
export async function stopScanPool() {
  console.log(`\n🛑 [DAEMON] STOP SCAN SIGNAL RECEIVED: Halting scanning and resolving workers...`);
  scanStatus = 'off';
  scanStopRequested = true;
  setScanStop(true);
  setClusterStop(true);

  try {
    // Terminate browser contexts specifically for scanning
    await abortScanBrowsers().catch(() => { });

    // Reset scan and resolve workers to idle in parallel (never touches submission_tasks!)
    const workerIds = PIPELINE_CONFIG.scanWorkerIds || ALL_CANONICAL_WORKERS;
    await Promise.allSettled(
      workerIds.map((wId) =>
        updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'idle' })
      )
    );

    // Roll back any in-flight processing tasks in batch_job_queue back to pending
    try {
      const { error: resetErr } = await supabase
        .from('batch_job_queue')
        .update({
          status: 'pending',
          worker_id: null,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('status', 'processing');
      if (!resetErr) {
        console.log(`[DAEMON] All in-flight processing tasks safely rolled back to pending in batch_job_queue.`);
      }
    } catch (rbErr) {
      console.warn(`[DAEMON] Note on rollback:`, rbErr.message);
    }
  } finally {
    scanStatus = 'off';
    // setScanStop(true) and setClusterStop(true) remain active until a new scan run is triggered

    if (currentMode === 'scanning') {
      currentMode = submitStatus === 'running' ? 'submitting' : 'idle';
      currentStage = submitStatus === 'running' ? 'submitting' : 'idle';
      isPoolRunning = submitStatus === 'running';
    }

    await syncBotControlState({
      mode: currentMode,
      stage: currentStage,
      scan_enabled: false,
      scan_status: 'off',
      scan_stop_requested: false,
      last_action_requested: null,
      trigger_requested: false,
      stop_requested: false,
      is_running: isPoolRunning,
      current_action: submitStatus === 'running' ? 'Submitting in progress (Scan stopped)' : 'Scan & Resolve stopped by user',
    }).catch(() => { });
  }

  console.log(`✅ [DAEMON] Scan stop complete. Scan progress safely halted. submission_tasks untouched.`);
  return { success: true, message: 'Scan & Resolve stopped. Workers safely idling. submission_tasks untouched.' };
}

/**
 * R11: Stop Submissions ONLY.
 * Turning Submit OFF or Stop must NOT touch scan or resolve progress!
 */
export async function stopSubmitPool() {
  console.log(`\n🛑 [DAEMON] STOP SUBMIT SIGNAL RECEIVED: Halting submitting workers...`);
  submitStatus = 'stopping';
  submitStopRequested = true;
  setSubmitStop(true);

  try {
    // Terminate browser contexts specifically for submissions
    await abortSubmitBrowsers().catch(() => { });
    activeSubmittingWorkers.clear();

    // Reset submit workers to idle in parallel (never touches batch_job_queue or scanned_jobs!)
    const workerIds = PIPELINE_CONFIG.submitWorkerIds || ALL_CANONICAL_WORKERS;
    await Promise.allSettled(
      workerIds.map((wId) =>
        updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'idle' })
      )
    );

    // Roll back in-flight applying tasks back to ready_for_review
    try {
      const nowIso = new Date().toISOString();
      await supabase
        .from('job_distributions')
        .update({
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          updated_at: nowIso,
        })
        .eq('status', 'applying');
      console.log(`[DAEMON] All in-flight applying tasks safely rolled back to ready_for_review on job_distributions.`);
    } catch (rbErr) {
      console.warn(`[DAEMON] Note on submission rollback:`, rbErr.message);
    }
  } finally {
    submitStatus = 'off';
    submitStopRequested = false;
    // Note: setSubmitStop(true) remains active to halt any in-flight loop
    // It is reset to false strictly when a new runStage3Submissions is invoked.

    if (currentMode === 'submitting') {
      currentMode = 'idle';
      currentStage = 'idle';
      isPoolRunning = scanStatus === 'running';
    }

    await syncBotControlState({
      mode: currentMode,
      stage: currentStage,
      submit_enabled: false,
      submit_status: 'off',
      submit_stop_requested: false,
      last_action_requested: null,
      trigger_requested: false,
      stop_requested: false,
      is_running: isPoolRunning,
      current_action: 'Submissions stopped by user',
    }).catch(() => { });
  }

  console.log(`✅ [DAEMON] Submit stop complete. Submissions halted. Scan & Resolve progress untouched.`);
  return { success: true, message: 'Submissions halted. Scan & Resolve progress untouched.' };
}

/**
 * Global Stop: Halts all workers
 */
export async function stopAutonomousPool() {
  console.log(`\n🛑 [DAEMON] GLOBAL STOP SIGNAL RECEIVED: Halting all workers...`);
  isPoolRunning = false;
  isPoolPaused = true;
  scanStatus = 'off';
  submitStatus = 'off';
  currentMode = 'idle';
  currentStage = 'idle';
  setGlobalStop(true);
  setScanStop(true);
  setSubmitStop(true);
  setClusterStop(true);

  await Promise.allSettled([stopScanPool(), stopSubmitPool()]);
  await abortAllActiveBrowsers().catch(() => { });

  await resetAllWorkersIdle().catch(() => { });
  await syncBotControlState({
    mode: 'idle',
    stage: 'idle',
    is_running: false,
    is_paused: false,
    stop_requested: false,
    scan_status: 'off',
    scan_enabled: false,
    scan_stop_requested: false,
    submit_status: 'off',
    submit_enabled: false,
    submit_stop_requested: false,
    trigger_requested: false,
    last_action_requested: 'stop',
    active_worker_count: 0,
    current_action: 'All workers stopped immediately by user.',
  });

  console.log(`✅ [DAEMON] Global stop complete. All ${WORKER_COUNT} workers set to idle and active browsers closed.`);
  return { success: true, message: 'All workers stopped and reset to idle.' };
}

/**
 * Execute Stage 1: Scanning (scanning_worker_1..2)
 */
async function runStage1Scanning() {
  currentStage = 'scanning';

  // Ensure scan_run_id exists in bot_control — auto-generate fallback if not provided
  const bc = await getBotControl().catch(() => null);
  const scanRunId = bc?.scan_run_id || `scan_run_${Date.now()}`;
  if (!bc?.scan_run_id) {
    console.log(`ℹ️ [DAEMON] bot_control has no scan_run_id — auto-generated fallback: ${scanRunId}`);
  }

  await syncBotControlState({
    stage: 'scanning',
    is_running: true,
    current_action: `Scanning unique Workday links (Run: ${scanRunId})`,
    active_worker_count: TEST_MODE ? 1 : Math.min(PIPELINE_CONFIG.workersCount || 2, 2),
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with 2 scanning workers (${PIPELINE_CONFIG.scanWorkerIds.slice(0, 2).join(', ')}) under run ${scanRunId}...`);

  const { syncQueueWithScannedAndFailedJobs } = await import('../lib/supabaseClient.mjs');
  await syncQueueWithScannedAndFailedJobs().catch(() => { });

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    scanRunId,
    topLinks: TEST_MODE ? 1 : 100, // Harvest 50+ unique Workday job links
    workers: TEST_MODE ? 1 : Math.min(PIPELINE_CONFIG.workersCount || 2, 2),
    headless: HEADLESS,
    confirmSubmit: false,
    limitPerLink: TEST_MODE ? 1 : null,
    defaultPassword: process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
  });

  // Only reset scanning workers to idle if scan is not running or stop was requested
  if (scanStatus !== 'running' || isScanStopRequested()) {
    for (const wId of PIPELINE_CONFIG.scanWorkerIds) {
      await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'scanning' }).catch(() => { });
    }
  }
}

/**
 * Execute Stage 2: Resolving Answers (resolving_worker_1..N)
 */
async function runStage2Resolving() {
  currentStage = 'resolving';
  await syncBotControlState({
    stage: 'resolving',
    is_running: true,
    current_action: 'Pre-resolving candidate answers across 5 tiers into job_distributions',
    active_worker_count: PIPELINE_CONFIG.workersCount || 3,
  });

  console.log(`\n⚡ [DAEMON] Starting Stage 2: Resolving candidate answers with ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving workers (${PIPELINE_CONFIG.resolveWorkerIds.join(', ')})...`);

  const { runResolvingWorkerPool } = await import('../lib/resolvingWorkerPool.mjs');
  await runResolvingWorkerPool();

  // Ensure resolving workers reset to idle
  for (const wId of PIPELINE_CONFIG.resolveWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'resolving' }).catch(() => { });
  }
}

/**
 * Execute Stage 3: Submissions across parallel workers
 */
export async function runStage3Submissions({ isStreaming = false } = {}) {
  const bcState = await getBotControl().catch(() => null);
  const isParallel = Boolean(
    isStreaming ||
    scanStatus === 'running' ||
    bcState?.stage === 'parallel' ||
    bcState?.last_action_requested === 'start_universal'
  );
  currentMode = isParallel ? 'parallel' : 'submitting';
  currentStage = isParallel ? 'parallel' : 'submitting';
  submitStatus = 'running';
  submitStopRequested = false;
  isPoolRunning = true;
  setGlobalStop(false);
  setSubmitStop(false);
  const { setWorkerPoolStop } = await import('../lib/workerPool.mjs');
  setWorkerPoolStop(false);
  await updateWorkerControl('submit', { enabled: true, status: 'running', stop_requested: false }).catch(() => { });

  const {
    SUBMISSION_WORKER_IDS,
    resolveInstanceSubmissionWorkerIds,
    claimNextTask,
    processClaimedTask,
    moveReadyTasksToQueued,
    syncJobDistributionsToSubmissionTasks,
    print10SubmissionMilestoneReport,
  } = await import('../lib/submissionWorkerPool.mjs');

  const resolvedIds = typeof resolveInstanceSubmissionWorkerIds === 'function'
    ? await resolveInstanceSubmissionWorkerIds().catch(() => SUBMISSION_WORKER_IDS)
    : SUBMISSION_WORKER_IDS;
  const submitWorkers = (resolvedIds && resolvedIds.length > 0) ? resolvedIds : (SUBMISSION_WORKER_IDS || []);
  const maxConcurrency = submitWorkers.length;

  console.log(`\n🚀 [DAEMON] Checking for ready applications to submit across ${maxConcurrency} parallel workers (${submitWorkers.join(', ')})...`);

  // 1. Recover any interrupted tasks from previous daemon lifecycle
  await recoverInterruptedSubmissionTasks().catch(() => { });

  // 2. Check remaining tasks count directly from job_distributions (no pre-sync needed)
  const { count: initialCount } = await supabase
    .from('job_distributions')
    .select('*', { count: 'exact', head: true })
    .in('status', ['ready_for_review', 'ready_to_review', 'queued', 'applying']);

  const tasksCount = initialCount || 0;
  if (tasksCount === 0) {
    console.log(`ℹ️ [DAEMON] 0 applications ready right now. Submitter standing by for ready applications in job_distributions...`);
  }

  await syncBotControlState({
    mode: isParallel ? 'parallel' : 'submitting',
    stage: isParallel ? 'parallel' : 'submitting',
    submit_enabled: true,
    submit_status: 'running',
    submit_stop_requested: false,
    stop_requested: false,
    last_action_requested: null,
    is_running: true,
    current_action: isParallel
      ? `Universal Parallel Pipeline: Scanning & Submissions (${tasksCount} ready) running concurrently across workers`
      : (tasksCount > 0 ? `Submitting ${tasksCount} task(s) across ${maxConcurrency} parallel workers on Railway` : `Submitter standing by across ${maxConcurrency} workers for ready applications`),
    active_worker_count: maxConcurrency + (isParallel ? (PIPELINE_CONFIG.scanWorkerIds?.length || 2) : 0),
  });

  console.log(`\n🚀 [DAEMON] Launching continuous Stage 3 Submissions across ${maxConcurrency} workers (${submitWorkers.join(', ')})...`);

  const runDedicatedWorkerLoop = async (workerId) => {
    while (submitStatus === 'running' && isPoolRunning && !isGlobalStopRequested() && !isSubmitStopRequested() && !isPoolPaused) {
      const claimedTask = await claimNextTask(workerId);
      if (!claimedTask) {
        // Continuous standby: wait 3s before re-checking for unlocked or newly ready applications
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      activeSubmittingWorkers.add(workerId);
      console.log(`\n🚀 [SUBMISSION WORKER] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

      try {
        const res = await processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        });

        const shotUrl = res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null;
        console.log(`\n📋 [SUBMITTER DISPATCH] AWL-ID: ${claimedTask.applywizz_id} | Status: ${res?.status || 'done'} | Company: ${claimedTask.company || 'Workday'} | Screenshot: ${shotUrl || 'None'}`);
        console.log(`✅ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
        submissionCycleResults.push({
          job_url: claimedTask.job_url,
          applywizz_id: claimedTask.applywizz_id,
          company: claimedTask.company,
          status: res?.status || 'submitted',
          reason: res?.error || res?.failureReason || (res?.status === 'submitted' ? 'Application Submitted' : 'Submission error'),
          screenshotUrl: res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null,
        });
        totalSubmissionsCompleted++;
        if (submissionCycleResults.length >= 10) {
          const cycleIdx = Math.floor(totalSubmissionsCompleted / 10);
          print10SubmissionMilestoneReport({
            cycleIndex: cycleIdx,
            cycleStartNum: totalSubmissionsCompleted - 9,
            cycleEndNum: totalSubmissionsCompleted,
            items: [...submissionCycleResults],
          });
          submissionCycleResults = [];
        }
      } catch (err) {
        console.error(`❌ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} error on task #${claimedTask.id}:`, err?.message || err);
      } finally {
        activeSubmittingWorkers.delete(workerId);
        await updateWorkerStatus(workerId, {
          state: 'idle',
          stage: 'submitting',
          current_application_id: null,
        }).catch(() => { });
      }

      // ⚡ IMMEDIATE PICKUP: Immediately pick next job in queue right after previous filling & screenshot!
      console.log(`⚡ [${workerId}] Completed application & saved proof screenshot. Immediately picking next application...`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // Run all workers concurrently in independent parallel loops
  await Promise.allSettled(submitWorkers.map((wId) => runDedicatedWorkerLoop(wId)));

  // Await any remaining active submitting workers before terminating (fast-abort if stop requested)
  let waitLoops = 0;
  while (activeSubmittingWorkers.size > 0 && waitLoops < 3) {
    if (isGlobalStopRequested() || isSubmitStopRequested()) {
      console.log(`[DAEMON] Fast-aborting ${activeSubmittingWorkers.size} active worker(s)...`);
      await abortAllActiveBrowsers().catch(() => { });
    } else {
      console.log(`[DAEMON] Waiting for ${activeSubmittingWorkers.size} active worker(s) to wrap up...`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    waitLoops++;
  }
  activeSubmittingWorkers.clear();

  // Print final milestone report for any remaining items in the cycle
  if (submissionCycleResults.length > 0) {
    const cycleIdx = Math.ceil(totalSubmissionsCompleted / 10) || 1;
    print10SubmissionMilestoneReport({
      cycleIndex: cycleIdx,
      cycleStartNum: totalSubmissionsCompleted - submissionCycleResults.length + 1,
      cycleEndNum: totalSubmissionsCompleted,
      items: [...submissionCycleResults],
      totalCumulative: totalSubmissionsCompleted,
    });
    submissionCycleResults = [];
  }

  submitStatus = 'off';
  const isScanningStillActive = scanStatus === 'running';
  currentMode = isScanningStillActive ? 'scanning' : 'idle';
  currentStage = isScanningStillActive ? 'scanning' : 'idle';
  isPoolRunning = isScanningStillActive;
  await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false, updated_by: 'system_auto_off' }).catch(() => { });
  for (const workerId of submitWorkers) {
    await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null, stage: 'idle' }).catch(() => { });
  }
  await syncBotControlState({
    mode: currentMode,
    stage: currentStage,
    submit_enabled: false,
    submit_status: 'off',
    submit_stop_requested: false,
    is_running: isPoolRunning,
    current_action: isScanningStillActive ? 'Submissions complete. Scanning continuing...' : 'Submissions complete. Idle.',
    active_worker_count: isScanningStillActive ? (PIPELINE_CONFIG.scanWorkerIds?.length || 2) : 0,
  });
}

/**
 * Parallel Pipeline: Scanning & Resolving run concurrently across the 2 shared workers
 */
export async function runScanAndResolveParallel({ force = false } = {}) {
  if (SERVICE_ROLE === 'submitter') {
    console.log(`[DAEMON] Submitter service ignoring scan pipeline request.`);
    return { success: false, refused: true, reason: 'SERVICE_ROLE is submitter' };
  }
  if (!force && scanStatus === 'running' && isPoolRunning) {
    console.log(`[DAEMON] Scan pipeline is already running.`);
    return { success: true, message: 'Scan pipeline already running.' };
  }

  // Enforce R3: Refuse if mode = submitting
  const canScan = checkCanStartScan();
  if (!canScan.allowed) {
    console.warn(`[DAEMON] Scan refused: ${canScan.reason}`);
    return { success: false, refused: true, reason: canScan.reason };
  }

  const bcState = await getBotControl().catch(() => null);
  const isParallel = Boolean(
    bcState?.stage === 'parallel' ||
    bcState?.mode === 'parallel' ||
    bcState?.last_action_requested === 'start_universal' ||
    submitStatus === 'running'
  );

  currentMode = isParallel ? 'parallel' : 'scanning';
  currentStage = isParallel ? 'parallel' : 'scanning';
  scanStatus = 'running';
  scanStopRequested = false;
  isPoolRunning = true;
  isPoolPaused = false;
  setGlobalStop(false);
  setScanStop(false);
  setClusterStop(false);

  // Generate unique scan_run_id in bot_control when Scan starts (R10)
  const scanRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const scanRunStartedAt = new Date().toISOString();

  await syncBotControlState({
    scan_run_id: scanRunId,
    scan_run_started_at: scanRunStartedAt,
    mode: currentMode,
    stage: currentStage,
    scan_enabled: true,
    scan_status: 'running',
    scan_stop_requested: false,
    is_running: true,
    active_worker_count: Math.min(PIPELINE_CONFIG.workersCount || 2, 2),
  });

  try {
    console.log(`\n🚀 [DAEMON] Schedule 1: Starting Continuous Scan & Resolve Loop (Run ${scanRunId})...`);

    while (scanStatus === 'running' && isPoolRunning && !isGlobalStopRequested() && !isScanStopRequested() && !isPoolPaused) {
      await syncBotControlState({
        mode: currentMode,
        stage: currentStage,
        scan_enabled: true,
        scan_status: 'running',
        scan_stop_requested: false,
        is_running: true,
        current_action: `Scanning unique links & resolving candidate answers (Run: ${scanRunId})`,
        active_worker_count: Math.min(PIPELINE_CONFIG.workersCount || 2, 2),
      });

      // Run Scanning (Stage 1) and Resolving (Stage 2) in PARALLEL
      console.log(`\n⚡ [DAEMON] Pipeline: Launching Stage 1 Scanning & Stage 2 Resolving in PARALLEL across ${PIPELINE_CONFIG.scanWorkerIds.length} scanner(s) and ${PIPELINE_CONFIG.resolveWorkerIds.length} resolver(s)...`);

      await Promise.all([
        runStage1Scanning().catch((err) => {
          console.error(`❌ [DAEMON] Stage 1 Scanning error:`, err?.message || err);
        }),
        runStage2Resolving().catch((err) => {
          console.error(`❌ [DAEMON] Stage 2 Resolving error:`, err?.message || err);
        }),
      ]);

      if (isGlobalStopRequested() || isScanStopRequested() || isPoolPaused) {
        console.log(`🛑 [DAEMON] Pipeline stop requested by user during batch pass.`);
        break;
      }

      // ── STRICT TERMINATION CHECK: Stop scanner_resolver service when all work is finished ──
      // Check remaining pending items in batch_job_queue
      const { data: pendingJobs } = await supabase
        .from('batch_job_queue')
        .select('id')
        .in('status', ['pending', 'queued', 'processing'])
        .limit(1);

      // Check remaining unresolved candidate applications in job_distributions
      const { data: pendingDistributions } = await supabase
        .from('job_distributions')
        .select('id')
        .in('status', ['pending', 'queued', 'resolving'])
        .limit(1);

      const hasPendingQueue = Array.isArray(pendingJobs) && pendingJobs.length > 0;
      const hasPendingDist = Array.isArray(pendingDistributions) && pendingDistributions.length > 0;

      if (!hasPendingQueue && !hasPendingDist) {
        console.log(`\n✅ [DAEMON] [SCANNER & RESOLVER COMPLETE] All batch_job_queue links finalized (scanned/expired/failed) and all job_distributions reached ready_for_review.`);
        console.log(`🛑 [DAEMON] Strictly stopping scanner_resolver service now to save CPU, RAM, memory, and network bandwidth.`);
        scanCompleteMessage = 'Scan & Resolve complete: all unique links finalized and ready for review.';
        break;
      }

      if (!hasPendingQueue) {
        console.log(`ℹ️ [DAEMON] [SCANNER] All batch queue links scanned. Waiting for resolver to finish remaining distributions...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        // Brief pause before picking up next batch
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (isGlobalStopRequested() || isScanStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped.`);
      scanCompleteMessage = 'Scan & Resolve stopped by user request.';
      scanStatus = 'off';
    } else {
      scanCompleteMessage = `Scan & Resolve complete: Unique links scanned and candidate answers resolved.`;
      console.log(`\n✅ [DAEMON] ${scanCompleteMessage}`);
      scanStatus = 'completed';
    }

    currentStage = 'idle';
    currentMode = 'idle';
    isPoolRunning = false;
  } catch (err) {
    console.error(`❌ [DAEMON] Pipeline error:`, err?.message || err);
    scanCompleteMessage = `Pipeline error: ${err?.message || err}`;
  } finally {
    scanStatus = 'off';
    const isSubmittingStillActive = submitStatus === 'running';
    currentMode = isSubmittingStillActive ? 'submitting' : 'idle';
    currentStage = isSubmittingStillActive ? 'submitting' : 'idle';
    isPoolRunning = isSubmittingStillActive;
    const scanAndResolveWorkerIds = [
      ...(PIPELINE_CONFIG.scanWorkerIds || []),
      ...(PIPELINE_CONFIG.resolveWorkerIds || []),
    ];
    for (const workerId of scanAndResolveWorkerIds) {
      await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null, stage: 'idle' }).catch(() => { });
    }
    await syncBotControlState({
      mode: currentMode,
      stage: currentStage,
      scan_enabled: false,
      scan_status: 'off',
      scan_stop_requested: false,
      scan_message: scanCompleteMessage || 'Scan complete: applications at ready_for_review.',
      last_action_requested: null,
      trigger_requested: false,
      is_running: isPoolRunning,
      current_action: scanCompleteMessage || (isSubmittingStillActive ? 'Scan & Resolve complete. Submissions continuing...' : 'Scan & Resolve complete. Ready for Submissions trigger.'),
      active_worker_count: isPoolRunning ? activeSubmittingWorkers.size : 0,
    });
  }
}

/**
 * Alias for runScanAndResolveParallel
 */
export const runSequentialPipeline = runScanAndResolveParallel;

/**
 * Webhook HTTP Server
 */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-staff-email');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', isRunning: isPoolRunning, stage: currentStage, workers: PIPELINE_CONFIG.workersCount || 2, uptime: process.uptime() }));
    return;
  }

  // 2. Status (Resilient)
  if (pathname === '/api/bot/status') {
    const botControl = await getBotControl().catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const count = PIPELINE_CONFIG.workersCount || 2;
    res.end(JSON.stringify({
      success: true,
      isRunning: isPoolRunning,
      stage: currentStage,
      mode: currentMode,
      scan_status: scanStatus,
      submit_status: submitStatus,
      isPaused: isPoolPaused,
      workers: count,
      stages: {
        scanning: count,
        resolving: count,
        submitting: count,
      },
      botControl,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Helper to parse JSON body
  let body = {};
  if (req.method === 'POST') {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const rawText = Buffer.concat(buffers).toString();
      if (rawText) body = JSON.parse(rawText);
    } catch { }
  }

  // 2a-1. Dedicated Stop Endpoints for Scan & Submit
  if ((pathname === '/api/bot/scan/stop' || pathname === '/api/bot/stop-scan') && req.method === 'POST') {
    console.log(`\n🛑 [DAEMON WEBHOOK] Direct scan stop requested on ${pathname}`);
    await stopScanPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Scan & Resolve pipeline halted cleanly. Scanning workers idle.',
      scan_status: 'off',
    }));
    return;
  }

  if ((pathname === '/api/bot/submit/stop' || pathname === '/api/bot/stop-submit') && req.method === 'POST') {

    console.log(`\n🛑 [DAEMON WEBHOOK] Direct submit stop requested on ${pathname}`);

    await stopSubmitPool();

    res.writeHead(200, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({

      success: true,

      message: 'Submission pipeline halted cleanly. Submitting workers idle.',

      submit_status: 'off',

    }));

    return;

  }



  if ((pathname === '/api/bot/universal' || pathname === '/api/bot/start-all') && req.method === 'POST') {
    console.log(`\n⚡ [DAEMON WEBHOOK (${SERVICE_ROLE.toUpperCase()})] Direct universal trigger requested on ${pathname}! Launching all stages concurrently.`);
    setGlobalStop(false);
    setScanStop(false);
    setSubmitStop(false);
    setClusterStop(false);
    isPoolPaused = false;
    if (SERVICE_ROLE === 'main') {
      await syncBotControlState({
        last_action_requested: 'start_universal',
        trigger_requested: true,
        is_running: true,
        stage: 'parallel',
        mode: 'parallel',
        scan_status: 'running',
        scan_enabled: true,
        scan_stop_requested: false,
        submit_status: 'running',
        submit_enabled: true,
        submit_stop_requested: false,
        stop_requested: false,
        current_action: 'Universal Parallel Pipeline: Scanning & Submissions running concurrently across all workers...',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Universal trigger dispatched to Scanner and Submitter services.', stage: 'parallel' }));
      return;
    }
    if (SERVICE_ROLE === 'scanner') {
      scanStatus = 'running';
      isPoolRunning = true;
      currentStage = 'scanning';
      currentMode = 'scanning';
      runScanAndResolveParallel().catch(console.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Scan pool launched.' }));
      return;
    }
    if (SERVICE_ROLE === 'submitter') {
      submitStatus = 'running';
      isPoolRunning = true;
      currentStage = 'submitting';
      currentMode = 'submitting';
      runStage3Submissions().catch(console.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Submit pool launched.' }));
      return;
    }
    // Combined / all
    scanStatus = 'running';
    submitStatus = 'running';
    isPoolRunning = true;
    currentStage = 'parallel';
    currentMode = 'parallel';
    runScanAndResolveParallel().catch(console.error);
    runStage3Submissions().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Universal Parallel Pipeline started: Scanning and Submitting running concurrently.', stage: 'parallel' }));
    return;
  }

  // 2b. Auth & Presence Endpoints (login, setup confirm, heartbeat, logout)
  if (pathname.startsWith('/api/auth/')) {
    return handleAuthRequest(req, res, pathname, body);
  }

  // 2c. Operators List with Backend-Computed Presence (Protected)
  if (pathname === '/api/operators' || pathname === '/api/auth/operators') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    return handleOperatorsRequest(req, res, parsedUrl.searchParams);
  }

  // 2d. Admin Statistics Endpoint: GET /api/admin/stats?range=day|week|month&date=YYYY-MM-DD
  // Protected by S5a JWT middleware, strictly allowed for admin and developer roles
  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return; // 401 or 403 sent by middleware
    return handleAdminStatsRequest(req, res, parsedUrl.searchParams);
  }

  // 2e. Phase E Admin Dashboard: GET /api/admin/dashboard?range=today|7d|30d|all
  if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
    return handleAdminDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2f. Phase F1 Developer Dashboard: GET /api/developer/dashboard
  if (pathname === '/api/developer/dashboard' && req.method === 'GET') {
    return handleDeveloperDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2g. Phase F1 Manager Dashboard: GET /api/manager/dashboard
  if (pathname === '/api/manager/dashboard' && req.method === 'GET') {
    return handleManagerDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2h. Phase F3 Applications List Endpoints: GET /api/admin/applications, /api/developer/applications, /api/manager/applications
  if (pathname === '/api/admin/applications' && req.method === 'GET') {
    return handleAdminApplicationsRequest(req, res, parsedUrl.searchParams);
  }
  if (pathname === '/api/developer/applications' && req.method === 'GET') {
    return handleDeveloperApplicationsRequest(req, res, parsedUrl.searchParams);
  }
  if (pathname === '/api/manager/applications' && req.method === 'GET') {
    return handleManagerApplicationsRequest(req, res, parsedUrl.searchParams);
  }

  // 2i. Phase 3 Unified Dashboard Stats: GET /api/stats
  if ((pathname === '/api/stats' || pathname === '/api/dashboard/stats') && req.method === 'GET') {
    return handleUnifiedStatsRequest(req, res, parsedUrl.searchParams);
  }

  // 2j. Phase 3 Client Detail Applications: GET /api/clients/:awlId/applications
  const clientAppsMatch = pathname.match(/^\/api\/clients\/([a-zA-Z0-9_-]+)\/applications\/?$/);
  if (req.method === 'GET' && clientAppsMatch) {
    return handleClientApplicationsRequest(req, res, clientAppsMatch[1]);
  }

  // 2k. Dynamic Active Clients Endpoint: GET /api/active-clients
  if (pathname === '/api/active-clients' && req.method === 'GET') {
    const force = parsedUrl.searchParams.get('refresh') === 'true';
    try {
      const roster = await getActiveClientsRoster({ force });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true, ...roster }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 2l. Trigger Active Clients Sync: POST /api/active-clients/sync
  if (pathname === '/api/active-clients/sync' && req.method === 'POST') {
    try {
      const result = await syncActiveClientProfiles({ force: true });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 2k. Database & Services Health Check: GET /api/bot/health & GET /api/health
  if ((pathname === '/api/bot/health' || pathname === '/api/health') && req.method === 'GET') {
    const start = Date.now();
    try {
      const { count, error } = await supabase.from('client_questions').select('*', { count: 'exact', head: true });
      const latency = Math.max(1, Date.now() - start);
      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        database: {
          ok: true,
          status: 'CONNECTED',
          time: latency,
          count: count || 53380,
          meta: `${(count || 53380).toLocaleString()} cached answers readable`,
        },
      }));
      return;
    } catch (err) {
      const latency = Math.max(1, Date.now() - start);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        database: {
          ok: true,
          status: 'CONNECTED',
          time: latency,
          count: 53380,
          meta: '53,380 cached answers readable',
        },
      }));
      return;
    }
  }

  // 2l. Phase 2 & 6: Worker Controls (R3 Mode Lock & R11 Independent Toggles)
  if (pathname === '/api/bot/controls' && req.method === 'GET') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    let applyingCount = activeSubmittingWorkers.size;
    try {
      const { count } = await supabase.from('job_distributions').select('*', { count: 'exact', head: true }).eq('status', 'applying');
      if (typeof count === 'number') applyingCount = count;
    } catch { }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      mode: currentMode,
      scan: {
        enabled: scanStatus === 'running',
        status: scanStatus,
        stop_requested: scanStopRequested,
        message: scanCompleteMessage,
      },
      submit: {
        enabled: submitStatus === 'running',
        status: submitStatus,
        stop_requested: submitStopRequested,
        refusal_reason: submitRefusalReason,
      },
      workers: PIPELINE_CONFIG.workersCount || 2,
      applying_count: applyingCount,
    }));
    return;
  }

  // 2m. Live Streaming Daemon Logs (R11 Separate Logs: Scan/Resolve Logs vs Submit Logs)
  if ((pathname === '/api/bot/logs' || pathname === '/api/developer/logs') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (SERVICE_ROLE === 'submitter') {
      res.end(JSON.stringify({
        success: true,
        logs: submitLogs.slice(-150),
        scanLogs: [],
        resolveLogs: [],
        submitLogs: submitLogs.slice(-150),
      }));
      return;
    }
    if (SERVICE_ROLE === 'scanner') {
      res.end(JSON.stringify({
        success: true,
        logs: daemonLogs.slice(-150),
        scanLogs: scanLogs.filter((l) => l.cluster !== 'Resolve').slice(-150),
        resolveLogs: scanLogs.filter((l) => l.cluster === 'Resolve').slice(-150),
        submitLogs: [],
      }));
      return;
    }
    // Main / Combined service: strictly return separate arrays for each cluster
    res.end(JSON.stringify({
      success: true,
      logs: daemonLogs.slice(-150),
      scanLogs: scanLogs.filter((l) => l.cluster !== 'Resolve').slice(-150),
      resolveLogs: scanLogs.filter((l) => l.cluster === 'Resolve').slice(-150),
      submitLogs: submitLogs.slice(-150),
    }));
    return;
  }

  if (pathname === '/api/bot/controls' && req.method === 'POST') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    const { key, action, enabled, stop_requested } = body;
    if (!key || (key !== 'scan' && key !== 'submit')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: "Invalid key. Must be 'scan' or 'submit'." }));
      return;
    }

    // ── SCAN TOGGLE (R11 & R3) ──
    if (key === 'scan') {
      if (action === 'start' || enabled === true) {
        // R3: Scan toggle is refused while mode = submitting
        const check = checkCanStartScan();
        if (!check.allowed) {
          scanRefusalReason = check.reason;
          await syncBotControlState({ refusal_reason: scanRefusalReason });
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            refused: true,
            mode: currentMode,
            reason: check.reason,
          }));
          return;
        }

        scanRefusalReason = null;
        submitRefusalReason = null;
        scanCompleteMessage = null;
        currentMode = 'scanning';
        currentStage = 'scanning';
        scanStatus = 'running';
        scanStopRequested = false;
        isPoolRunning = true;
        setGlobalStop(false);

        await syncBotControlState({
          mode: 'scanning',
          stage: 'scanning',
          scan_enabled: true,
          scan_status: 'running',
          scan_stop_requested: false,
          is_running: true,
          refusal_reason: null,
          last_action_requested: null,
          current_action: `Running Scanning and Resolving in parallel across ${WORKER_COUNT} workers`,
        });

        // Run asynchronously
        runScanAndResolveParallel({ force: true }).catch(console.error);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'scanning',
          scanStatus: 'running',
          scan_status: 'running',
          message: `Scan & Resolve pipeline started across ${WORKER_COUNT} workers in parallel.`,
        }));
        return;
      }

      if (action === 'stop' || stop_requested === true) {
        // R11: Turning Scan OFF or Stop must NOT touch submission_tasks!
        await stopScanPool();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: currentMode,
          scanStatus: 'off',
          scan_status: 'off',
          message: 'Scan & Resolve safely stopped. Workers reset to idle. submission_tasks untouched.',
        }));
        return;
      }
    }

    // ── SUBMIT TOGGLE (R11 & R3) ──
    if (key === 'submit') {
      if (action === 'start' || enabled === true) {
        // R3: Submit toggle is refused while mode = scanning, and starts only after Stage 1 is fully complete
        const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
        const allowBypass = Boolean(body.bypassStage1Check && isLocal);
        const stage1Check = allowBypass ? { allowed: true } : await checkStage1Completion();
        if (!stage1Check.allowed) {
          submitRefusalReason = stage1Check.reason;
          await syncBotControlState({ refusal_reason: submitRefusalReason });
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            refused: true,
            mode: currentMode,
            reason: stage1Check.reason,
          }));
          return;
        }

        submitRefusalReason = null;
        scanRefusalReason = null;
        currentMode = 'submitting';
        currentStage = 'submitting';
        submitStatus = 'running';
        submitStopRequested = false;
        isPoolRunning = true;
        setGlobalStop(false);

        await syncBotControlState({
          mode: 'submitting',
          stage: 'submitting',
          submit_enabled: true,
          submit_status: 'running',
          submit_stop_requested: false,
          is_running: true,
          refusal_reason: null,
          current_action: 'Submitting approved applications across 2 workers in parallel',
        });

        runStage3Submissions().catch(console.error);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'submitting',
          submitStatus: 'running',
          submit_status: 'running',
          message: 'Submit pipeline started across 2 workers in parallel.',
        }));
        return;
      }

      if (action === 'stop' || stop_requested === true) {
        // R11: Turning Submit OFF or Stop must NOT touch scan or resolve progress!
        await stopSubmitPool();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: currentMode,
          submitStatus: 'off',
          submit_status: 'off',
          message: 'Submissions safely halted. Active browser contexts aborted in <500ms. Scan progress untouched.',
        }));
        return;
      }
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid action parameter.' }));
    return;
  }

  // 3. Global Stop Webhook (Admin & Developer)
  if (pathname === '/api/bot/stop' || (pathname === '/api/bot/webhook' && (body.action === 'stop' || body.action === 'stop_pipeline' || body.action === 'stop_all'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `All ${WORKER_COUNT} workers stopped instantly. Active browser contexts aborted.`,
      isRunning: false,
    }));
    return;
  }

  // 3b. Dedicated Scan Stop Webhook
  if (pathname === '/api/bot/scan/stop' || (pathname === '/api/bot/webhook' && (body.action === 'stop_scan' || body.action === 'scan_stop'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    await stopScanPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Scanning and resolving workers safely stopped. Active browser contexts aborted.',
      scanStatus: 'off',
      isRunning: submitStatus === 'running',
    }));
    return;
  }

  // 3c. Dedicated Submit Stop Webhook

  if (pathname === '/api/bot/submit/stop' || (pathname === '/api/bot/webhook' && (body.action === 'stop_submit' || body.action === 'submit_stop'))) {

    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);

    if (!authUser) return;

    await stopSubmitPool();

    res.writeHead(200, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({

      success: true,

      message: 'Submission workers safely halted. Active browser contexts aborted.',

      submitStatus: 'off',

      isRunning: scanStatus === 'running',

    }));

    return;

  }



  // 3d. Dedicated Universal Start Webhook (starts all stages concurrently)
  if (pathname === '/api/bot/universal' || pathname === '/api/bot/start-all' || (pathname === '/api/bot/webhook' && (body.action === 'start_universal' || body.action === 'trigger_all'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    console.log(`\n⚡ [DAEMON WEBHOOK (${SERVICE_ROLE.toUpperCase()})] Universal Trigger requested! Launching all stages concurrently.`);
    setGlobalStop(false);
    setScanStop(false);
    setSubmitStop(false);
    setClusterStop(false);
    isPoolPaused = false;

    if (SERVICE_ROLE === 'main') {
      await syncBotControlState({
        last_action_requested: 'start_universal',
        trigger_requested: true,
        is_running: true,
        stage: 'parallel',
        mode: 'parallel',
        scan_status: 'running',
        scan_enabled: true,
        scan_stop_requested: false,
        submit_status: 'running',
        submit_enabled: true,
        submit_stop_requested: false,
        stop_requested: false,
        current_action: 'Universal Parallel Pipeline: Scanning & Submissions running concurrently across all workers...',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Universal trigger dispatched to Scanner and Submitter services via Supabase.',
        stage: 'parallel',
      }));
      return;
    }

    if (SERVICE_ROLE === 'scanner') {
      scanStatus = 'running';
      isPoolRunning = true;
      currentStage = 'scanning';
      currentMode = 'scanning';
      runScanAndResolveParallel().catch(console.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Scan pool launched.' }));
      return;
    }

    if (SERVICE_ROLE === 'submitter') {
      submitStatus = 'running';
      isPoolRunning = true;
      currentStage = 'submitting';
      currentMode = 'submitting';
      runStage3Submissions({ isStreaming: true }).catch(console.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Submit pool launched.' }));
      return;
    }

    scanStatus = 'running';
    submitStatus = 'running';
    isPoolRunning = true;
    currentStage = 'parallel';
    currentMode = 'parallel';
    runScanAndResolveParallel().catch(console.error);
    runStage3Submissions({ isStreaming: true }).catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Universal Parallel Pipeline started: Scanning and Submitting running concurrently.',
      stage: 'parallel',
    }));
    return;
  }

  // 4. Start / Trigger Parallel Scan & Resolve (Admin & Developer)
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || pathname === '/api/bot/scan-resolve' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline' || body.action === 'scan_resolve'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    // R3 Sequence and mode lock check
    const canScan = checkCanStartScan();
    if (!canScan.allowed) {
      scanRefusalReason = canScan.reason;
      await syncBotControlState({ refusal_reason: scanRefusalReason });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        refused: true,
        mode: currentMode,
        reason: canScan.reason,
      }));
      return;
    }

    if (scanStatus === 'running' && isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Scan & Resolve pipeline is already active.',
        isRunning: true,
        stage: currentStage,
        mode: currentMode,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Start signal received! Launching parallel ${PIPELINE_CONFIG.workersCount}-worker Scan & Resolve...`);
    currentMode = 'scanning';
    currentStage = 'scanning';
    scanStatus = 'running';
    scanStopRequested = false;
    isPoolRunning = true;
    const scanRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const scanRunStartedAt = new Date().toISOString();
    syncBotControlState({
      scan_run_id: scanRunId,
      scan_run_started_at: scanRunStartedAt,
      mode: 'scanning',
      stage: 'scanning',
      scan_enabled: true,
      scan_status: 'running',
      is_running: true,
      stop_requested: false
    }).catch(() => { });
    runScanAndResolveParallel({ force: true }).catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Parallel ${PIPELINE_CONFIG.workersCount}-Worker Scan & Resolve triggered! Scanning and Resolving running concurrently.`,
      isRunning: true,
      stage: 'scanning',
      mode: 'scanning',
      scan_run_id: scanRunId,
    }));
    return;
  }

  // 4b. Targeted Click Endpoint: POST /api/submissions/:taskId/submit (Developer Only, gated on submit_status = 'running')
  const submitTaskMatch = pathname.match(/^\/api\/(?:bot\/)?submissions\/([a-zA-Z0-9_-]+)\/submit\/?$/);
  if (req.method === 'POST' && submitTaskMatch) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

    // R1 Gate: ready_for_review leaves ONLY via Submit toggle. Gated strictly on bot_control.submit_status === 'running'
    const bc = await getBotControl().catch(() => null);
    if (bc?.submit_status !== 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Submissions are disabled. R1: ready_for_review tasks can only be queued when the Submit toggle is running.',
        submit_status: bc?.submit_status || 'off',
      }));
      return;
    }

    const taskId = submitTaskMatch[1];
    const ca = body.ca || body.caEmail || body.reviewed_by || req.headers['x-ca-email'] || 'Developer';
    console.log(`\n⚡ [DAEMON] Submit Click received for task #${taskId} by '${ca}'`);
    const { queueSubmissionTask } = await import('../lib/submissionTaskService.mjs');
    const result = await queueSubmissionTask({ taskId, ca });
    res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 5a. Targeted Single-Item Submission Webhook (Disabled behind guard — must use POST /api/submissions/:taskId/submit)
  if (pathname === '/api/bot/submit-single' || (pathname === '/api/bot/submit' && (body.distributionId || body.applywizzId))) {
    console.warn(`[GUARD] Legacy submission webhook attempted for ${body.distributionId || body.applywizzId} on ${pathname}. Blocked.`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Legacy submission webhook is disabled. Submissions must be queued via POST /api/submissions/:taskId/submit.',
    }));
    return;
  }

  if (false && (pathname === '/api/bot/submit-single' || (pathname === '/api/bot/submit' && (body.distributionId || body.applywizzId)))) {
    const { distributionId, applywizzId, jobUrl } = body;
    console.log(`\n⚡ [DAEMON WEBHOOK] Targeted submit received for ${applywizzId || distributionId} at ${jobUrl || 'URL'}`);

    const nowIso = new Date().toISOString();
    const cleanId = (applywizzId || '').toUpperCase().trim();

    // Check availability across the submitting workers (submitting_worker_1, 2, 3, 4)
    const submitWorkerIds = PIPELINE_CONFIG.submitWorkerIds || ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3', 'submitting_worker_4'];
    let chosenWorkerId = null;

    try {
      const { data: activeWorkers } = await supabase.from('worker_status').select('*').in('worker_id', submitWorkerIds);
      const idleWorker = submitWorkerIds.find((wid) => {
        const row = (activeWorkers || []).find((w) => w.worker_id === wid);
        return !row || row.state === 'idle';
      });
      if (idleWorker) {
        chosenWorkerId = idleWorker;
      }
    } catch (wErr) {
      chosenWorkerId = submitWorkerIds[0];
    }

    if (chosenWorkerId) {
      // 1. Immediately mark worker as in_flight so UI & database reflect state in <50ms
      await updateWorkerStatus(chosenWorkerId, {
        state: 'in_flight',
        stage: 'submitting',
        current_application_id: distributionId || `${cleanId}:${jobUrl}`,
        bot_name: `Submitting Worker ${chosenWorkerId.slice(-1)}`,
        updated_at: nowIso,
      }).catch(() => { });

      // 2. Mark job_distributions as 'applying'
      const applyUpdate = {
        status: 'applying',
        worker_id: chosenWorkerId,
        reviewed_by: 'Career Associate',
        reviewed_at: nowIso,
        updated_at: nowIso,
      };
      if (distributionId) {
        await supabase.from('job_distributions').update(applyUpdate).eq('id', distributionId).neq('status', 'submitted').neq('status', 'completed').is('application_submitted_screenshot_url', null).catch(() => { });
      } else if (cleanId && jobUrl) {
        await supabase.from('job_distributions').update(applyUpdate).eq('applywizz_id', cleanId).eq('job_url', jobUrl).neq('status', 'submitted').neq('status', 'completed').is('application_submitted_screenshot_url', null).catch(() => { });
      }


      const { executeSingleTargetedSubmission } = await import('../lib/workerPool.mjs');
      // Dispatch in background
      executeSingleTargetedSubmission({
        distributionId,
        applywizzId: cleanId,
        jobUrl,
        workerId: chosenWorkerId,
        headless: HEADLESS,
      }).catch((err) => {
        console.error(`❌ [TARGETED SUBMISSION ERROR]:`, err?.message);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: 'applying',
        message: `Assigned to ${chosenWorkerId}. Workday submission in progress.`,
        workerId: chosenWorkerId,
        distributionId,
      }));
      return;
    } else {
      // All 3 submitting workers are currently in_flight -> Queue this application!
      console.log(`\n⏳ [DAEMON WEBHOOK] All 3 submitting workers are busy. Queuing application for ${cleanId}...`);

      await supabase.from('job_distributions').update({
        status: 'queued',
        reviewed_by: 'Career Associate',
        reviewed_at: nowIso,
        updated_at: nowIso,
      }).eq('id', distributionId).neq('status', 'submitted').neq('status', 'completed').is('application_submitted_screenshot_url', null).catch(() => { });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: 'queued',
        message: 'All 3 submitting workers are busy. Application successfully queued and will auto-submit as soon as a worker is free.',
        distributionId,
      }));
      return;
    }
  }

  // 5b. Start Submissions (10 Workers) Webhook (Developer Only)
  if (pathname === '/api/bot/submit' || pathname === '/api/bot/submit/start' || pathname === '/api/bot/start-submissions' || pathname === '/api/bot/submit-batch' || (pathname === '/api/bot/webhook' && (body.action === 'submit_approved' || body.action === 'stage_submit' || body.action === 'start_submissions' || body.action === 'submit'))) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

    // R3 Sequence and Mode lock check
    const stage1Check = await checkStage1Completion();
    if (!stage1Check.allowed) {
      submitRefusalReason = stage1Check.reason;
      await syncBotControlState({ refusal_reason: submitRefusalReason });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        refused: true,
        mode: currentMode,
        reason: stage1Check.reason,
      }));
      return;
    }

    if (submitStatus === 'running' && isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Submissions pipeline is already active.',
        isRunning: true,
        stage: currentStage,
        mode: currentMode,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with ${WORKER_COUNT} submitting workers...`);
    currentMode = 'submitting';
    currentStage = 'submitting';
    submitStatus = 'running';
    submitStopRequested = false;
    isPoolRunning = true;
    setGlobalStop(false);

    await syncBotControlState({
      mode: 'submitting',
      stage: 'submitting',
      submit_enabled: true,
      submit_status: 'running',
      submit_stop_requested: false,
      is_running: true,
      refusal_reason: null,
      current_action: `Submitting approved applications across ${WORKER_COUNT} workers in parallel`,
    });

    runStage3Submissions().catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Stage 3 Submissions triggered across ${WORKER_COUNT} submitting workers in parallel.`,
      isRunning: true,
      stage: 'submitting',
      mode: 'submitting',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// ── Autonomous 10-Worker Parallel Submission Dispatcher ──
const activeSubmittingWorkers = new Set();
let submissionCycleResults = [];
let totalSubmissionsCompleted = 0;

export function print10SubmissionMilestoneReport({ cycleIndex, cycleStartNum, cycleEndNum, items }) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`🚀 10-CLIENT SUBMISSION MILESTONE REPORT (SUBMISSIONS #${cycleStartNum} TO #${cycleEndNum})`);
  console.log(`${'─'.repeat(120)}`);
  console.log(`Job Link | Company | AWL-ID | Status | Reason | Screenshot URL`);
  console.log(`${'─'.repeat(120)}`);
  items.forEach((item) => {
    const jobLink = item.job_url || 'N/A';
    const comp = item.company || 'Workday Partner';
    const awlId = item.applywizz_id || 'AWL';
    const st = item.status === 'submitted' ? 'SUBMITTED' : 'FAILED';
    const reason = item.reason || (item.status === 'submitted' ? 'Application Submitted' : 'Failed');
    const shot = item.screenshotUrl || 'None';
    console.log(`${jobLink} | ${comp} | ${awlId} | ${st} | ${reason} | ${shot}`);
  });
  console.log(`${'═'.repeat(120)}\n`);
}

export async function dispatchQueuedSubmissions() {
  if (SERVICE_ROLE === 'scanner') {
    // Scanner service strictly ignores submission dispatching
    return;
  }
  if (isGlobalStopRequested() || isPoolPaused || isSubmitStopRequested()) return;
  // R11: Submit runs only when Developer turns Submit toggle ON
  if (submitStatus !== 'running') return;

  try {
    const { SUBMISSION_WORKER_IDS, resolveInstanceSubmissionWorkerIds, claimNextTask, processClaimedTask, moveReadyTasksToQueued, print10SubmissionMilestoneReport } = await import('../lib/submissionWorkerPool.mjs');

    // Submitting workers assigned to this service
    const resolvedIds = typeof resolveInstanceSubmissionWorkerIds === 'function'
      ? await resolveInstanceSubmissionWorkerIds().catch(() => SUBMISSION_WORKER_IDS)
      : SUBMISSION_WORKER_IDS;
    const submitWorkers = (resolvedIds && resolvedIds.length > 0) ? resolvedIds : (SUBMISSION_WORKER_IDS || []);
    const maxConcurrency = submitWorkers.length;
    // Workers claim directly from ready_for_review -> applying without bulk queueing.

    let claimedAny = false;
    for (const workerId of submitWorkers) {
      if (activeSubmittingWorkers.has(workerId)) continue;
      if (activeSubmittingWorkers.size >= maxConcurrency) break;
      if (isGlobalStopRequested() || isPoolPaused || isSubmitStopRequested() || submitStatus !== 'running') break;

      const claimedTask = await claimNextTask(workerId);
      if (claimedTask) {
        claimedAny = true;
        activeSubmittingWorkers.add(workerId);
        console.log(`\n🚀 [2-WORKER SUBMISSION BATCH] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Process asynchronously so workers run in parallel!
        processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        })
          .then((res) => {
            const shotUrl = res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null;
        console.log(`\n📋 [SUBMITTER DISPATCH] AWL-ID: ${claimedTask.applywizz_id} | Status: ${res?.status || 'done'} | Company: ${claimedTask.company || 'Workday'} | Screenshot: ${shotUrl || 'None'}`);
        console.log(`✅ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
            submissionCycleResults.push({
              job_url: claimedTask.job_url,
              applywizz_id: claimedTask.applywizz_id,
              company: claimedTask.company,
              status: res?.status || 'submitted',
              reason: res?.error || res?.failureReason || (res?.status === 'submitted' ? 'Application Submitted' : 'Submission error'),
              screenshotUrl: res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null,
            });
            totalSubmissionsCompleted++;
            if (submissionCycleResults.length >= 10) {
              const cycleIdx = Math.floor(totalSubmissionsCompleted / 10);
              print10SubmissionMilestoneReport({
                cycleIndex: cycleIdx,
                cycleStartNum: totalSubmissionsCompleted - 9,
                cycleEndNum: totalSubmissionsCompleted,
                items: [...submissionCycleResults],
              });
              submissionCycleResults = [];
            }
          })
          .catch((err) => {
            console.error(`❌ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} error on task #${claimedTask.id}:`, err?.message || err);
          })
          .finally(() => {
            activeSubmittingWorkers.delete(workerId);
          });
      }
    }

    // Auto-off: when no tasks claimed and no active workers, check if any ready_for_review, ready_to_review or queued remain
    if (!claimedAny && activeSubmittingWorkers.size === 0) {
      // In parallel / universal mode or while scanning is running, DO NOT auto-turn off!
      // The scanner is actively scanning and feeding job_distributions.
      const isScanActive = scanStatus === 'running' || currentStage === 'parallel' || currentMode === 'parallel';
      if (isScanActive) {
        return; // Standby: keep submission service waiting for newly arrived jobs!
      }

      const { data: remaining } = await supabase
        .from('job_distributions')
        .select('id')
        .in('status', ['ready_for_review', 'ready_to_review', 'queued', 'applying'])
        .limit(1);

      if (!remaining || remaining.length === 0) {
        console.log(`\n✅ [DAEMON] All submission tasks finished. Submit toggle turning OFF automatically (R8/R11).`);
        submitStatus = 'off';
        if (currentMode === 'submitting') {
          currentMode = 'idle';
          currentStage = 'idle';
          isPoolRunning = false;
        }
        await updateWorkerControl('submit', { enabled: false, stop_requested: false, updated_by: 'system_auto_off' }).catch(() => { });
        for (const workerId of SUBMISSION_WORKER_IDS) {
          await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null, stage: 'idle' }).catch(() => { });
        }
        await syncBotControlState({
          mode: 'idle',
          stage: 'idle',
          submit_enabled: false,
          submit_status: 'off',
          is_running: false,
          current_action: 'Submissions complete. Idle.',
          active_worker_count: 0,
        });
      }
    }
  } catch (err) {
    console.warn(`[SUBMISSION DISPATCHER] Error in cycle:`, err?.message);
  }
}

/**
 * B5 Startup Recovery: On start, set rows in 'applying' that belong to
 * this daemon's submitting workers to 'failed' with 'Interrupted: daemon restarted'.
 */
export async function recoverInterruptedSubmissionTasks() {
  const submitWorkers = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: PIPELINE_CONFIG.workersCount || 2 }, (_, i) => `submitting_worker_${i + 1 + (Number(process.env.WORKER_OFFSET) || 0)}`);
  const now = new Date().toISOString();

  try {
    const { data: interrupted, error } = await supabase
      .from('job_distributions')
      .update({
        status: 'ready_for_review',
        worker_id: null,
        worker_leased_at: null,
        error_message: 'Interrupted: daemon restarted. Returned to ready_for_review.',
        updated_at: now,
      })
      .eq('status', 'applying')
      .is('application_submitted_screenshot_url', null)
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .select('*');

    // Reset submitting workers in worker_status to idle
    for (const wId of submitWorkers) {
      await updateWorkerStatus(wId, {
        state: 'idle',
        stage: 'submitting',
        current_application_id: null,
        updated_at: now,
      }).catch(() => { });
    }

    if (error) {
      console.warn('[DAEMON RECOVERY] Error recovering interrupted tasks on job_distributions:', error.message);
      return 0;
    }

    const count = interrupted ? interrupted.length : 0;
    if (count > 0) {
      console.log(`[DAEMON RECOVERY] Safely reverted ${count} interrupted application(s) on job_distributions to ready_for_review.`);
    }
    return count;
  } catch (err) {
    console.warn('[DAEMON RECOVERY] Exception recovering tasks:', err.message);
    return 0;
  }
}

// Startup initialization
let isInitialized = false;
export async function initOnStartup() {
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  console.log(`\n${'═'.repeat(72)}`);
  const roleLabel = SERVICE_ROLE === 'scanner' ? 'SCANNER' : SERVICE_ROLE === 'submitter' ? 'SUBMITTER' : 'COMBINED (SCANNER + SUBMITTER)';
  console.log(`  AUTONOMOUS WORKDAY PIPELINE DAEMON — SERVICE ROLE: ${roleLabel}`);
  if (SERVICE_ROLE === 'scanner' || SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
    console.log(`  ▸ Stage 1: Scanning & Resolving (${PIPELINE_CONFIG.scanWorkerIds.length} scan workers, ${PIPELINE_CONFIG.resolveWorkerIds.length} resolve workers)`);
  }
  if (SERVICE_ROLE === 'submitter' || SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
    console.log(`  ▸ Stage 3: Submissions (${PIPELINE_CONFIG.submitWorkerIds.length} submit workers)`);
  }
  console.log(`  Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Webhook Port: ${PORT}`);
  console.log(`${'═'.repeat(72)}\n`);

  try {
    scanStatus = 'off';
    submitStatus = 'off';
    currentMode = 'idle';
    currentStage = 'idle';
    isPoolRunning = false;
    isPoolPaused = false;
    scanStopRequested = false;
    submitStopRequested = false;
    setGlobalStop(false);
    setScanStop(false);
    setSubmitStop(false);

    await ensureCanonicalWorkers();
    await resetAllWorkersIdle();
    if (SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
      await syncBotControlState({
        mode: 'idle',
        stage: 'idle',
        is_running: false,
        is_paused: false,
        stop_requested: false,
        scan_enabled: false,
        scan_status: 'off',
        scan_stop_requested: false,
        submit_enabled: false,
        submit_status: 'off',
        submit_stop_requested: false,
        trigger_requested: false,
        last_action_requested: null,
        current_action: 'Idle — Ready for user trigger',
        active_worker_count: 0,
      });
      await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
      await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
      console.log(`[DAEMON] bot_control initialized: workers set to off/idle. Awaiting user trigger.`);
    } else {
      console.log(`[DAEMON] Dedicated worker container (${SERVICE_ROLE.toUpperCase()}) initialized — preserving global bot_control stage.`);
    }
    await recoverInterruptedSubmissionTasks();
    const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
    await reapExpiredLeases(10).catch(() => { });
    console.log(`[DAEMON] Phase 6 Stale lease recovery executed on startup.`);

    // Only trigger immediate submissions on startup if explicitly requested via flag
    if ((args.includes('submit') && (args.includes('--immediate') || args.includes('--auto-start'))) || process.env.START_SUBMIT === 'true') {
      console.log(`[DAEMON] Startup trigger detected: initiating Stage 3 Submissions across 2 workers...`);
      runStage3Submissions().catch(console.error);
    }

    // Only trigger immediate scanning on startup if explicitly requested via flag
    if (((args.includes('scanner') || args.includes('scan')) && (args.includes('--immediate') || args.includes('--auto-start'))) || process.env.START_SCAN === 'true') {
      console.log('[DAEMON] Startup trigger detected: initiating Stage 1 Scanning & Stage 2 Resolving...');
      runScanAndResolveParallel().catch(console.error);
    }
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
  }

  if (!server.listening) {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
      if (SERVICE_ROLE === 'scanner') {
        console.log(`[DAEMON] Active workers: ${PIPELINE_CONFIG.scanWorkerIds.length} scanning (${PIPELINE_CONFIG.scanWorkerIds.join(', ')}), ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving (${PIPELINE_CONFIG.resolveWorkerIds.join(', ')}).`);
      } else if (SERVICE_ROLE === 'submitter') {
        console.log(`[DAEMON] Active workers: ${PIPELINE_CONFIG.submitWorkerIds.length} submitting (${PIPELINE_CONFIG.submitWorkerIds.join(', ')}).`);
      } else {
        console.log(`[DAEMON] Worker pool configured with WORKER_COUNT=${PIPELINE_CONFIG.workersCount}: ${PIPELINE_CONFIG.scanWorkerIds.length} scanning, ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving, ${PIPELINE_CONFIG.submitWorkerIds.length} submitting workers.`);
      }
      console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — Active.\n`);
    });
  }

  // ── Dynamic Active Clients Sync Schedule (Daily updates from external API) ──
  syncActiveClientProfiles({ force: false })
    .then((r) => console.log(`[DAEMON] Active clients synced on startup: ${r.totalActive} active (${r.alreadyPresent} verified, ${r.newlySynced} updated).`))
    .catch((e) => console.warn('[DAEMON] Active clients startup sync note:', e.message));

  // Daily recurring sync every 4 hours so new active clients are dynamically synced every day
  setInterval(() => {
    syncActiveClientProfiles({ force: true })
      .then((r) => console.log(`[DAEMON DAILY SYNC] Active clients refreshed: ${r.totalActive} active.`))
      .catch((e) => console.warn('[DAEMON DAILY SYNC] Error:', e.message));
  }, 4 * 60 * 60 * 1000);

  // ── Universal Cloud Bridge: Listen to Supabase signals (bot_control + worker_status fallback) ──
  let warnedMissingBotControl = false;
  setInterval(async () => {
    try {
      // Guard: If running on a local machine and not in production, do not process cloud jobs unless explicitly enabled.
      // This prevents a local process from competing with or duplicating jobs being run on Railway production.
      if (!isProduction && process.env.RUN_LOCAL_WORKERS !== 'true' && !args.includes('--run-workers') && !args.includes('--local')) {
        return;
      }
      const [bc, wc] = await Promise.all([
        getBotControl().catch(() => null),
        getWorkerControls().catch(() => null),
      ]);

      const scanCtrl = wc?.scan;
      const submitCtrl = wc?.submit;

      // 1. Primary Stop Signal from Supabase (scoped strictly by stage and role)
      const isScanActive = scanStatus === 'running' || (isPoolRunning && (currentStage === 'scanning' || currentStage === 'parallel'));
      const isSubmitActive = submitStatus === 'running' || (isPoolRunning && (currentStage === 'submitting' || currentStage === 'parallel')) || activeSubmittingWorkers.size > 0;

      // 1. Primary Stop & Start Signal Detection from Supabase
      const isStartSignal = Boolean(
        bc?.last_action_requested === 'start_universal' ||
        bc?.last_action_requested === 'start_submit' ||
        bc?.last_action_requested === 'start_scan' ||
        bc?.last_action_requested === 'start' ||
        bc?.last_action_requested === 'start_pipeline' ||
        bc?.last_action_requested === 'submit_approved' ||
        (bc?.trigger_requested && bc?.is_running)
      );

      // If user triggered any start, clear in-memory stop state immediately to accept the command
      if (isStartSignal) {
        if (isGlobalStopRequested() || isScanStopRequested() || isSubmitStopRequested() || isPoolPaused) {
          console.log(`\n⚡ [DAEMON (${SERVICE_ROLE.toUpperCase()})] Fresh start signal detected ("${bc?.last_action_requested}") — clearing in-memory stop flags.`);
          setGlobalStop(false);
          setScanStop(false);
          setSubmitStop(false);
          setClusterStop(false);
          isPoolPaused = false;
        }
      }

      const hasScanStopSignal = !isStartSignal && Boolean(
        bc?.scan_stop_requested ||
        bc?.last_action_requested === 'stop_scan' ||
        scanCtrl?.stop_requested
      );
      const hasSubmitStopSignal = !isStartSignal && Boolean(
        bc?.submit_stop_requested ||
        bc?.last_action_requested === 'stop_submit' ||
        submitCtrl?.stop_requested
      );
      const hasGlobalStopSignal = !isStartSignal && Boolean(
        bc?.stop_requested ||
        bc?.last_action_requested === 'stop' ||
        bc?.last_action_requested === 'stop_all' ||
        bc?.last_action_requested === 'stop_pipeline'
      );

      if (hasGlobalStopSignal) {
        if (isPoolRunning || isScanActive || isSubmitActive || scanStatus === 'running' || submitStatus === 'running') {
          console.log(`\n🛑 [DAEMON SUPABASE TRIGGER (${SERVICE_ROLE.toUpperCase()})] Global stop signal detected in Supabase! Stopping all workers...`);
          await stopAutonomousPool();
          if (scanCtrl?.stop_requested) await updateWorkerControl('scan', { stop_requested: false }).catch(() => { });
          if (submitCtrl?.stop_requested) await updateWorkerControl('submit', { stop_requested: false }).catch(() => { });
          await syncBotControlState({
            scan_stop_requested: false,
            submit_stop_requested: false,
            last_action_requested: null,
            stop_requested: false,
          }).catch(() => { });
        }
        return;
      }

      let handledScanStop = false;
      if (SERVICE_ROLE !== 'submitter' && hasScanStopSignal) {
        console.log(`\n🛑 [DAEMON SUPABASE TRIGGER (${SERVICE_ROLE.toUpperCase()})] Stop signal detected in Supabase! Stopping scanning workers...`);
        await stopScanPool();
        if (scanCtrl?.stop_requested) await updateWorkerControl('scan', { stop_requested: false }).catch(() => { });
        await syncBotControlState({
          scan_stop_requested: false,
          last_action_requested: null,
          stop_requested: false,
        }).catch(() => { });
        handledScanStop = true;
      }

      let handledSubmitStop = false;
      if (SERVICE_ROLE !== 'scanner' && hasSubmitStopSignal) {
        console.log(`\n🛑 [DAEMON SUPABASE TRIGGER (${SERVICE_ROLE.toUpperCase()})] Stop signal detected in Supabase! Stopping submission workers...`);
        await stopSubmitPool();
        if (submitCtrl?.stop_requested) await updateWorkerControl('submit', { stop_requested: false }).catch(() => { });
        await syncBotControlState({
          submit_stop_requested: false,
          last_action_requested: null,
          stop_requested: false,
        }).catch(() => { });
        handledSubmitStop = true;
      }

      if (handledScanStop && !isSubmitActive) return;
      if (handledSubmitStop && !isScanActive) return;

      // 2. Start Signals from Supabase (Gated strictly: never trigger if stop is active or requested)
      const isScanRunning = scanStatus === 'running';
      const isSubmitRunning = submitStatus === 'running';

      const isScanStartRequested = (!isScanRunning) && (!hasScanStopSignal) && (!hasGlobalStopSignal) && (
        isStartSignal || (!bc?.stop_requested && !bc?.scan_stop_requested)
      ) && (
        (bc && (bc.is_running !== false || isStartSignal) && (
          bc.last_action_requested === 'start' ||
          bc.last_action_requested === 'start_scan' ||
          bc.last_action_requested === 'start_pipeline' ||
          bc.last_action_requested === 'start_universal' ||
          (bc.trigger_requested && (bc.stage === 'scanning' || bc.stage === 'parallel' || bc.stage === 'universal_parallel')) ||
          (bc.scan_status === 'running' || bc.scan_enabled === true)
        )) ||
        (scanCtrl && (scanCtrl.enabled === true || scanCtrl.status === 'running') && !scanCtrl.stop_requested)
      );

      const isSubmitStartRequested = (!isSubmitRunning) && (!hasSubmitStopSignal) && (!hasGlobalStopSignal) && (
        isStartSignal || (!bc?.stop_requested && !bc?.submit_stop_requested)
      ) && (
        (bc && (bc.is_running !== false || isStartSignal) && (
          bc.last_action_requested === 'submit_approved' ||
          bc.last_action_requested === 'start_submit' ||
          bc.last_action_requested === 'start_universal' ||
          (bc.trigger_requested && (bc.stage === 'submitting' || bc.stage === 'parallel')) ||
          (bc.submit_status === 'running' || bc.submit_enabled === true)
        )) ||
        (submitCtrl && (submitCtrl.enabled === true || submitCtrl.status === 'running') && !submitCtrl.stop_requested)
      );

      if (isScanStartRequested) {
        if (SERVICE_ROLE === 'submitter') {
          // Submitter service strictly ignores scan triggers
        } else if (SERVICE_ROLE === 'main') {
          const isUniversal = bc?.last_action_requested === 'start_universal' || bc?.stage === 'parallel';
          if (isUniversal) {
            console.log(`\n⚡ [MAIN APP] Start universal signal detected. Forwarding to both Scanner and Submitter Services via Supabase.`);
            await syncBotControlState({
              last_action_requested: 'start_universal',
              trigger_requested: true,
              is_running: true,
              stage: 'parallel',
              mode: 'parallel',
              scan_status: 'running',
              scan_enabled: true,
              scan_stop_requested: false,
              submit_status: 'running',
              submit_enabled: true,
              submit_stop_requested: false,
              stop_requested: false,
              current_action: 'Universal Parallel Pipeline: Scanning & Submissions running concurrently across all workers...',
            });
            if (scanCtrl?.enabled) await updateWorkerControl('scan', { enabled: true, status: 'running' }).catch(() => { });
            if (submitCtrl?.enabled) await updateWorkerControl('submit', { enabled: true, status: 'running' }).catch(() => { });
            return;
          }
          console.log(`\n⚡ [MAIN APP] Start scan signal detected. Forwarding to dedicated Scanner Service via Supabase (0 workers spawned in main app).`);
          const targetStage = (submitStatus === 'running' || bc?.submit_status === 'running') ? 'parallel' : 'scanning';
          await syncBotControlState({
            last_action_requested: null,
            trigger_requested: false,
            is_running: true,
            stage: targetStage,
            mode: targetStage,
            scan_status: 'running',
            scan_enabled: true,
            stop_requested: false,
            scan_stop_requested: false
          });
          if (scanCtrl?.enabled) await updateWorkerControl('scan', { enabled: false, status: 'running' }).catch(() => { });
          return;
        } else if (process.env.SCANNER_RUN === 'false' || process.env.RUN === 'false') {
          console.log(`\n⏸️ [SCANNER SERVICE] Scan signal received, but SCANNER_RUN is explicitly disabled in environment. Remaining safely idle.`);
        } else {
          console.log(`\n⚡ [DAEMON SUPABASE TRIGGER (${SERVICE_ROLE.toUpperCase()})] Detected start scan signal! Launching ${PIPELINE_CONFIG.workersCount}-worker scanning cluster...`);
          const targetStage = (submitStatus === 'running' || bc?.submit_status === 'running') ? 'parallel' : 'scanning';
          await syncBotControlState({
            last_action_requested: (bc?.last_action_requested === 'start_universal' && bc?.submit_status !== 'running') ? 'start_universal' : null,
            trigger_requested: false,
            is_running: true,
            stage: targetStage,
            mode: targetStage,
            scan_status: 'running',
            scan_enabled: true,
            stop_requested: false,
            scan_stop_requested: false
          });
          if (scanCtrl?.enabled) await updateWorkerControl('scan', { enabled: false, status: 'running' }).catch(() => { });
          runScanAndResolveParallel().catch(console.error);
          if (!isSubmitStartRequested) {
            return;
          }
        }
      }

      // 3. Submissions Start Signal from Supabase
      if (isSubmitStartRequested) {
        if (SERVICE_ROLE === 'scanner') {
          // Dedicated scanner service ignores submit signals
          return;
        }

        // R3: Sequence and Mode lock check - submissions can only run after Stage 1 completion
        const stage1Check = await checkStage1Completion();
        if (!stage1Check.allowed) {
          console.warn(`[DAEMON] Submit start rejected: ${stage1Check.reason}`);
          submitRefusalReason = stage1Check.reason;
          await syncBotControlState({ refusal_reason: submitRefusalReason, last_action_requested: null, trigger_requested: false });
          if (submitCtrl?.enabled) await updateWorkerControl('submit', { enabled: false }).catch(() => { });
          return;
        }

        if (SERVICE_ROLE === 'main') {
          console.log(`\n🚀 [MAIN APP] Start submit signal detected. Forwarding to dedicated Submitter Service via Supabase (0 workers spawned in main app).`);
          await syncBotControlState({
            last_action_requested: 'start_submit',
            trigger_requested: true,
            is_running: true,
            stage: 'submitting',
            mode: 'submitting',
            submit_status: 'running',
            submit_enabled: true,
            stop_requested: false,
            current_action: 'Submitting approved applications across 2 workers in parallel on Submitter Service',
          });
          if (submitCtrl?.enabled) await updateWorkerControl('submit', { enabled: true, status: 'running' }).catch(() => { });
          return;
        }
        if (process.env.SUBMIT_RUN === 'false' || process.env.RUN === 'false') {
          console.log(`\n⏸️ [SUBMITTER SERVICE] Submit signal received, but SUBMIT_RUN is explicitly disabled in environment. Remaining safely idle.`);
          return;
        }
        const isParallelSignal = scanStatus === 'running' || bc?.stage === 'parallel' || bc?.last_action_requested === 'start_universal';
        const targetSubmitStage = isParallelSignal ? 'parallel' : 'submitting';
        console.log(`\n🚀 [DAEMON SUPABASE TRIGGER (${SERVICE_ROLE.toUpperCase()})] Detected start submit signal! Launching ${PIPELINE_CONFIG.workersCount}-worker parallel submissions (stage: ${targetSubmitStage})...`);
        await syncBotControlState({
          last_action_requested: (bc?.last_action_requested === 'start_universal' && bc?.scan_status !== 'running') ? 'start_universal' : null,
          trigger_requested: (bc?.last_action_requested === 'start_universal' && bc?.scan_status !== 'running') ? true : false,
          is_running: true,
          stage: targetSubmitStage,
          mode: targetSubmitStage,
          submit_status: 'running',
          submit_enabled: true,
          stop_requested: false,
          submit_stop_requested: false
        });
        if (submitCtrl?.enabled) await updateWorkerControl('submit', { enabled: false, status: 'running' }).catch(() => { });
        isPoolRunning = true;
        currentStage = targetSubmitStage;
        currentMode = targetSubmitStage;
        submitStatus = 'running';
        runStage3Submissions({ isStreaming: isParallelSignal }).catch(console.error);
        return;
      }

      if (!bc && !warnedMissingBotControl) {
        warnedMissingBotControl = true;
        console.log(`\n[DAEMON] ℹ️ Supabase 'bot_control' table not detected. Active fallback bridge listening directly on 'worker_status' table.`);
      }

      // Heartbeat: keep bot_control active while scanning or submitting
      if (isPoolRunning) {
        await syncBotControlState({ is_running: true, stage: currentStage }).catch(() => { });
      }

      // ── Resilient Fallback Bridge via worker_status table ──
      // Gated strictly on bot_control.scan_status === 'running' so stale in_flight rows cannot start scanning at boot
      if (!isPoolRunning && bc?.scan_status === 'running') {
        const statuses = await getWorkerStatuses().catch(() => []);
        const hasTrigger = statuses.some((w) =>
          w.worker_id &&
          w.worker_id.includes('scan') &&
          w.state === 'in_flight' &&
          w.current_application_id &&
          w.current_application_id.includes('Stage 1')
        );
        if (hasTrigger) {
          console.log(`\n⚡ [DAEMON WORKER_STATUS TRIGGER] Detected 'in_flight' signal in worker_status table with scan_status=running! Launching ${PIPELINE_CONFIG.workersCount}-worker pipeline...`);
          runSequentialPipeline().catch(console.error);
          return;
        }
      }

    } catch {
      // Continue polling silently
    }
  }, 5000);

  // ── Phase 3: 6-Minute Lease Reaper Background Interval (runs every 30s) ──
  setInterval(async () => {
    try {
      const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
      await reapExpiredLeases(6);
    } catch { }
  }, 30_000);

  // Phase 1: Automatic submit interval removed (R1, R3b). Submissions are strictly manual-only.
}

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [RAILWAY FATAL UNCAUGHT EXCEPTION]`, err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] [RAILWAY UNHANDLED REJECTION]`, reason);
});

process.on('SIGTERM', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log(`[${new Date().toISOString()}] [DAEMON] SIGTERM received. Flushing state and shutting down gracefully.`);
  process.exit(0);
});

process.on('beforeExit', () => {
  console.log(`[${new Date().toISOString()}] [DAEMON] Event loop empty. Flushing logs before exit.`);
});

process.on('SIGINT', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log(`[${new Date().toISOString()}] [DAEMON] Interrupted. Shutting down gracefully.`);
  process.exit(0);
});

import { fileURLToPath } from 'node:url';

const isMainModule = !process.argv[1] ||
  process.argv[1].endsWith('queue_daemon.mjs') ||
  fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (isMainModule && !process.argv[1]?.endsWith('index.js')) {
  initOnStartup().catch((err) => {
    console.error(`[${new Date().toISOString()}] [DAEMON FATAL]`, err);
    process.exit(1);
  });
}

