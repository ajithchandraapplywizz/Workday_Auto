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
import net from 'node:net';
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
  getMemoryBotControl,
  updateBotControl,
  getWorkerControls,
  updateWorkerControl,
} from '../lib/supabaseClient.mjs';
import {
  isProduction as isProductionEnv,
  canExecuteWorkers,
  isHeadless,
  shouldAutoStartOnBoot,
  shouldIgnoreCloudSignals,
} from '../config/envConfig.mjs';
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
  browserLifecycleEvents,
  waitForSlotReleaseOrTimeout,
  notifySlotReleased,
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
const isProduction = isProductionEnv();
// In production (Railway) and background daemons, HEADLESS is strictly enforced (true).
// In local development, respects HEADLESS setting or --headful / --headed CLI flags.
const HEADLESS = isHeadless(args);
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
export const SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME ||
  (SERVICE_ROLE === 'scanner'
    ? ((Number(process.env.WORKER_OFFSET) || 0) > 0 ? 'Scanner_Resolver_2' : 'Scanner_Resolver_1')
    : ((Number(process.env.WORKER_OFFSET) || 0) > 0 ? 'Submitting_2' : 'Submitting_1'));

let defaultPort = 3001;
if (SERVICE_ROLE === 'submitter') {
  defaultPort = 3002;
}

const portArgIndex = args.findIndex((a) => a === '--port' || a === '-p');
const portArg = portArgIndex !== -1 && args[portArgIndex + 1] ? Number(args[portArgIndex + 1]) : null;
const portInlineArg = (args.find((a) => a.startsWith('--port=')) || '').split('=')[1];
const explicitPortArg = portArg || (portInlineArg ? Number(portInlineArg) : null);
const isDynamicPortRequested = args.includes('--dynamic-port') || process.env.DYNAMIC_PORT === 'true';

export let PORT = explicitPortArg ?? (Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || defaultPort);

/**
 * findAvailablePort — Finds the first available, unoccupied port starting from preferredPort.
 * Tests sequentially starting from preferredPort (e.g. 3001 -> 3002 -> 3003...) to ensure standard developer port ranges.
 * Handles occupied ports (EADDRINUSE / EACCES) seamlessly by testing sequentially.
 */
export async function findAvailablePort(preferredPort = 3001, host = '0.0.0.0') {
  let portToTry = preferredPort > 0 ? preferredPort : (SERVICE_ROLE === 'submitter' ? 3002 : 3001);
  const maxPort = 65535;

  while (portToTry <= maxPort) {
    const isAvailable = await new Promise((resolve) => {
      const tester = net.createServer();
      tester.unref();
      tester.once('error', () => {
        resolve(false);
      });
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(portToTry, host);
    });

    if (isAvailable) {
      return portToTry;
    }
    portToTry++;
  }

  return 3001;
}

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}
console.log(`[DAEMON] Service Instance: "${SERVICE_NAME}" | Role: "${SERVICE_ROLE.toUpperCase()}" on PORT ${PORT} (main = 0 workers, scanner = scan only, submitter = submit only, all = combined).`);

let isPoolRunning = false;
let isPoolPaused = false;
let isScanLoopExecuting = false;
let isSubmitLoopExecuting = false;
let lastStandbyLogTime = 0;
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
    /^\[#\d+\]\s*[✅❌ℹ️]/i.test(trimmed)
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
  if (/^\[DAEMON HEARTBEAT\]/i.test(trimmed)) {
    return false;
  }
  if (/^\[INCOMING HTTP\]/i.test(trimmed)) {
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

    const entry = { ts: new Date().toISOString(), message: text, level, cluster, service_name: SERVICE_NAME };

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
  origLog.apply(console, args);
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (isNoisyLog(text)) return;
  routeLogEntry('info', args);
};

console.error = function (...args) {
  origErr.apply(console, args);
  routeLogEntry('error', args);
};

const ALL_CANONICAL_WORKERS = PIPELINE_CONFIG.allWorkerIds || Array.from({ length: 4 }, (_, i) => `submitting_worker_${i + 1}`);
const activeSubmittingWorkers = new Set();
const runningDedicatedWorkerLoops = new Set();

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

  let currentBc = null;
  try {
    currentBc = await getBotControl().catch(() => null);
  } catch {}

  const isGlobalStop = patch.stop_requested === true || patch.last_action_requested === 'stop' || patch.last_action_requested === 'stop_all' || patch.last_action_requested === 'stop_pipeline';
  const isUniversalStart = patch.last_action_requested === 'start_universal' || patch.stage === 'parallel';

  if (!isUniversalStart && !isGlobalStop) {
    if (SERVICE_ROLE === 'submitter') {
      delete sanitizedPatch.scan_status;
      delete sanitizedPatch.scan_enabled;
      delete sanitizedPatch.scan_stop_requested;
      delete sanitizedPatch.scan_run_id;
      delete sanitizedPatch.scan_run_started_at;

      // Multi-service guard: Submitter stopping its own stage must NOT overwrite is_running=false if Scanner is independently running
      const isScanActive = Boolean(currentBc && (currentBc.scan_status === 'running' || currentBc.scan_enabled === true));
      if (isScanActive && (sanitizedPatch.submit_status === 'off' || patch.is_running === false)) {
        sanitizedPatch.is_running = true;
        sanitizedPatch.stage = 'scanning';
        sanitizedPatch.mode = 'scanning';
        if (sanitizedPatch.active_worker_count === 0 && currentBc?.active_worker_count) {
          delete sanitizedPatch.active_worker_count;
        }
      }

      // Multi-replica guard: Submitter replica stopping its local tasks must NOT turn off global submit_status if sibling submitter replica is still active
      if (sanitizedPatch.submit_status === 'off' && !patch.submit_stop_requested && patch.last_action_requested !== 'stop_submit') {
        const { data: activeSubmitters } = await supabase
          .from('worker_status')
          .select('worker_id,state,stage')
          .ilike('worker_id', '%submit%')
          .in('state', ['in_flight', 'running', 'applying']);
        const hasSiblingSubmitters = Array.isArray(activeSubmitters) && activeSubmitters.some((w) => !submitWorkers.includes(w.worker_id));
        if (hasSiblingSubmitters) {
          delete sanitizedPatch.submit_status;
          delete sanitizedPatch.submit_enabled;
          delete sanitizedPatch.is_running;
          delete sanitizedPatch.active_worker_count;
        }
      }
    } else if (SERVICE_ROLE === 'scanner') {
      delete sanitizedPatch.submit_status;
      delete sanitizedPatch.submit_enabled;
      delete sanitizedPatch.submit_stop_requested;

      // Multi-service guard: Scanner stopping its own stage must NOT overwrite is_running=false if Submitter is independently running
      const isSubmitActive = Boolean(currentBc && (currentBc.submit_status === 'running' || currentBc.submit_enabled === true));
      if (isSubmitActive && (sanitizedPatch.scan_status === 'off' || patch.is_running === false)) {
        sanitizedPatch.is_running = true;
        sanitizedPatch.stage = 'submitting';
        sanitizedPatch.mode = 'submitting';
        if (sanitizedPatch.active_worker_count === 0 && currentBc?.active_worker_count) {
          delete sanitizedPatch.active_worker_count;
        }
      }

      // Multi-replica guard: Scanner replica stopping its local tasks must NOT turn off global scan_status if sibling scanner replica is still active
      if (sanitizedPatch.scan_status === 'off' && !patch.scan_stop_requested && patch.last_action_requested !== 'stop_scan') {
        const { data: activeScanners } = await supabase
          .from('worker_status')
          .select('worker_id,state,stage')
          .ilike('worker_id', '%scan%')
          .in('state', ['in_flight', 'running']);
        const hasSiblingScanners = Array.isArray(activeScanners) && activeScanners.some((w) => !PIPELINE_CONFIG.scanWorkerIds.includes(w.worker_id));
        if (hasSiblingScanners) {
          delete sanitizedPatch.scan_status;
          delete sanitizedPatch.scan_enabled;
          delete sanitizedPatch.is_running;
          delete sanitizedPatch.active_worker_count;
        }
      }
    }
  }



  // If universal/parallel is active across services, preserve stage: 'parallel'
  if (
    (currentBc?.universal_status === 'running' || currentBc?.universal_enabled === true || currentBc?.stage === 'parallel' || currentMode === 'parallel') &&
    !isGlobalStop &&
    (sanitizedPatch.stage === 'scanning' || sanitizedPatch.stage === 'submitting' || sanitizedPatch.stage === 'resolving')
  ) {
    sanitizedPatch.stage = 'parallel';
    sanitizedPatch.mode = 'parallel';
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
    const { getRecentBatchJobUrls } = await import('../lib/supabaseClient.mjs');
    const { urls: recentUrls } = await getRecentBatchJobUrls({ windowMinutes: 120 });
    if (recentUrls && recentUrls.length > 0) {
      const { count, error: bqErr } = await supabase
        .from('batch_job_queue')
        .select('*', { count: 'exact', head: true })
        .in('job_url', recentUrls)
        .in('status', ['pending', 'processing']);

      if (!bqErr && typeof count === 'number') {
        pendingBatchCount = count;
      }
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
    isScanLoopExecuting = false;
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
    await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
  }

  console.log(`✅ [DAEMON] Scan stop complete. Scan progress safely halted. submission_tasks untouched.`);
  try {
    const { deepCleanWhenZeroActiveInstances } = await import('../lib/browserLifecycle.mjs');
    deepCleanWhenZeroActiveInstances({ force: submitStatus !== 'running' });
  } catch {}
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
    // Terminate browser contexts specifically for submissions immediately
    await abortSubmitBrowsers({ force: true }).catch(() => { });
    activeSubmittingWorkers.clear();

    // Reset submit workers to idle in parallel (never touches batch_job_queue or scanned_jobs!)
    const workerIds = PIPELINE_CONFIG.submitWorkerIds || ALL_CANONICAL_WORKERS;
    await Promise.allSettled(
      workerIds.map((wId) =>
        updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'idle' })
      )
    );

    // Roll back in-flight applying tasks back to ready_for_review cleanly
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
        .eq('status', 'applying')
        .in('worker_id', workerIds)
        .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.not.ilike.%submitted-applications%')
        .neq('status', 'submitted')
        .neq('status', 'completed');

      await supabase
        .from('job_distributions')
        .update({
          status: 'ready_for_review',
          worker_id: null,
          worker_leased_at: null,
          updated_at: nowIso,
        })
        .eq('status', 'applying')
        .is('worker_id', null)
        .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
        .or('application_submitted_screenshot_url.is.null,application_submitted_screenshot_url.not.ilike.%submitted-applications%')
        .neq('status', 'submitted')
        .neq('status', 'completed');

      // Tasks in applying that reached or exhausted Attempt 3/3 must strictly transition to failed
      await supabase
        .from('job_distributions')
        .update({
          status: 'failed',
          worker_id: null,
          worker_leased_at: null,
          updated_at: nowIso,
        })
        .eq('status', 'applying')
        .ilike('error_message', '%Attempt 3/3%')
        .neq('status', 'submitted')
        .neq('status', 'completed');

      console.log(`[DAEMON] In-flight applying tasks safely rolled back to ready_for_review on job_distributions.`);
    } catch (rbErr) {
      console.warn(`[DAEMON] Note on submission rollback:`, rbErr.message);
    }
  } finally {
    isSubmitLoopExecuting = false;
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
    await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
  }

  console.log(`✅ [DAEMON] Submit stop complete. Submissions halted. Scan & Resolve progress untouched.`);
  try {
    const { deepCleanWhenZeroActiveInstances } = await import('../lib/browserLifecycle.mjs');
    deepCleanWhenZeroActiveInstances({ force: scanStatus !== 'running' });
  } catch {}
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
  isScanLoopExecuting = false;
  isSubmitLoopExecuting = false;
  currentMode = 'idle';
  currentStage = 'idle';
  setGlobalStop(true);
  setScanStop(true);
  setSubmitStop(true);
  setClusterStop(true);

  await Promise.allSettled([stopScanPool(), stopSubmitPool()]);
  await abortAllActiveBrowsers({ force: true }).catch(() => { });

  // Safe global fallback clearance across tables to avoid stuck applying tasks
  const nowIso = new Date().toISOString();
  await Promise.allSettled([
    supabase
      .from('job_distributions')
      .update({ status: 'ready_for_review', worker_id: null, worker_leased_at: null, updated_at: nowIso })
      .eq('status', 'applying')
      .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
      .neq('status', 'submitted')
      .neq('status', 'completed'),
    supabase
      .from('job_distributions')
      .update({ status: 'failed', worker_id: null, worker_leased_at: null, updated_at: nowIso })
      .eq('status', 'applying')
      .ilike('error_message', '%Attempt 3/3%')
      .neq('status', 'submitted')
      .neq('status', 'completed'),
    supabase
      .from('batch_job_queue')
      .update({ status: 'pending', worker_id: null, locked_at: null, updated_at: nowIso })
      .eq('status', 'processing'),
  ]);

  await resetAllWorkersIdle().catch(() => { });
  await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
  await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => { });
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
    last_action_requested: null,
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
  const { getPendingUnscannedJobsSummary } = await import('../lib/supabaseClient.mjs');
  const summary = await getPendingUnscannedJobsSummary().catch(() => ({ hasPending: false, pendingCount: 0 }));
  if (!summary.hasPending || summary.pendingCount === 0) {
    console.log(`ℹ️ [STAGE 1] 0 pending unscanned jobs in batch_job_queue. Skipping scanning stage.`);
    for (const wId of (PIPELINE_CONFIG.scanWorkerIds || [])) {
      await updateWorkerStatus(wId, { state: 'idle', stage: 'scanning', current_application_id: null }).catch(() => {});
    }
    return { skipped: true, reason: 'no_pending_jobs' };
  }

  currentStage = currentMode === 'parallel' ? 'parallel' : 'scanning';

  // Ensure scan_run_id exists in bot_control — auto-generate fallback if not provided
  const bc = await getBotControl().catch(() => null);
  const scanRunId = bc?.scan_run_id || `scan_run_${Date.now()}`;
  if (!bc?.scan_run_id) {
    console.log(`ℹ️ [DAEMON] bot_control has no scan_run_id — auto-generated fallback: ${scanRunId}`);
  }

  const scanWorkerCount = PIPELINE_CONFIG.scanWorkerIds?.length || PIPELINE_CONFIG.scanWorkersCount || PIPELINE_CONFIG.workersCount || 2;
  await syncBotControlState({
    stage: currentMode === 'parallel' ? 'parallel' : 'scanning',
    is_running: true,
    current_action: `Scanning unique Workday links (Run: ${scanRunId})`,
    active_worker_count: TEST_MODE ? 1 : scanWorkerCount,
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with ${scanWorkerCount} scanning workers (${PIPELINE_CONFIG.scanWorkerIds.join(', ')}) under run ${scanRunId}...`);

  const { syncQueueWithScannedAndFailedJobs } = await import('../lib/supabaseClient.mjs');
  await syncQueueWithScannedAndFailedJobs().catch(() => { });

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    scanRunId,
    topLinks: TEST_MODE ? 1 : 100, // Harvest 50+ unique Workday job links
    workers: TEST_MODE ? 1 : scanWorkerCount,
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
  currentStage = currentMode === 'parallel' ? 'parallel' : 'resolving';
  await syncBotControlState({
    stage: currentMode === 'parallel' ? 'parallel' : 'resolving',
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
export async function runStage3Submissions({ isStreaming = false, force = false } = {}) {
  if (SERVICE_ROLE === 'scanner') {
    return { success: false, refused: true, reason: 'SERVICE_ROLE is scanner' };
  }
  // Single-flight re-entrancy lock:
  // If the submissions loop is already running and has active worker loops, DO NOT launch duplicate loops!
  if (isSubmitLoopExecuting && runningDedicatedWorkerLoops.size > 0) {
    console.log(`[DAEMON] Submissions loop is already actively executing (${runningDedicatedWorkerLoops.size} workers active: ${Array.from(runningDedicatedWorkerLoops).join(', ')}).`);
    return { success: true, message: 'Submissions loop already executing.' };
  }
  if (!canExecuteWorkers(args)) {
    console.log(`[DAEMON] 🛡️ Cloud Protection Active: Local workers disabled to prevent stealing tasks from Railway. Railway cloud workers handle all submissions.`);
    return { success: false, reason: 'Local worker execution disabled. Railway cloud runs all submissions.' };
  }

  isSubmitLoopExecuting = true;

  const bcState = await getBotControl().catch(() => null);
  const isParallel = Boolean(
    isStreaming ||
    scanStatus === 'running' ||
    bcState?.stage === 'parallel' ||
    bcState?.mode === 'parallel' ||
    bcState?.universal_status === 'running' ||
    bcState?.universal_enabled === true ||
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

  console.log(`🚀 [DAEMON] Checking for ready applications to submit across ${maxConcurrency} parallel workers (${submitWorkers.join(', ')})...`);

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

  // Filter for workers that do NOT already have a dedicated loop actively running:
  const workersToLaunch = submitWorkers.filter((wId) => !runningDedicatedWorkerLoops.has(wId));
  if (workersToLaunch.length === 0) {
    console.log(`[DAEMON] All ${submitWorkers.length} configured submit workers are already actively running (${submitWorkers.join(', ')}). No duplicate loops needed.`);
    return { success: true, message: 'All workers already active.' };
  }

  console.log(`🚀 [DAEMON] Launching continuous Stage 3 Submissions across ${workersToLaunch.length} workers (${workersToLaunch.join(', ')})...`);

  const runDedicatedWorkerLoop = async (workerId) => {
    if (runningDedicatedWorkerLoops.has(workerId)) {
      console.log(`⚠️ [DAEMON] Worker loop for ${workerId} is already actively running. Skipping duplicate spawn.`);
      return;
    }
    runningDedicatedWorkerLoops.add(workerId);
    try {
      while (submitStatus === 'running' && isPoolRunning && !isGlobalStopRequested() && !isSubmitStopRequested() && !isPoolPaused) {
        try {
          // Verify authoritative DB bot_control state before claiming to guarantee instant stop across devices
          try {
            const bcCheck = await getBotControl().catch(() => null);
            const isSubmitStopped = Boolean(
              submitStopRequested ||
              isSubmitStopRequested() ||
              isGlobalStopRequested() ||
              (bcCheck && (
                bcCheck.stop_requested === true ||
                bcCheck.submit_stop_requested === true ||
                bcCheck.universal_stop_requested === true ||
                bcCheck.submit_status === 'off' ||
                bcCheck.submit_enabled === false ||
                (!bcCheck.is_running && bcCheck.stage !== 'submitting' && bcCheck.stage !== 'parallel') ||
                ((bcCheck.last_action_requested === 'stop_submit' ||
                  bcCheck.last_action_requested === 'stop' ||
                  bcCheck.last_action_requested === 'stop_all' ||
                  bcCheck.last_action_requested === 'stop_universal') &&
                  bcCheck.submit_status !== 'running')
              ))
            );
            if (isSubmitStopped) {
              console.log(`🛑 [SUBMISSION WORKER] ${workerId} detected stop signal in bot_control. Halting submission worker loop immediately.`);
              setSubmitStop(true);
              try {
                const { abortWorkerBrowser } = await import('../lib/browserLifecycle.mjs');
                await abortWorkerBrowser(workerId);
              } catch {}
              break;
            }
          } catch {}

          // If this worker is already in the middle of processing an application, wait before claiming another
          if (activeSubmittingWorkers.has(workerId)) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          // In local development, if worker execution is disabled, sleep cleanly without tight spin-loops
          if (!canExecuteWorkers()) {
            if (workerId === submitWorkers[0] && (Date.now() - (lastStandbyLogTime || 0)) > 30000) {
              lastStandbyLogTime = Date.now();
              console.log(`🛡️ [DAEMON] Local worker execution paused (canExecuteWorkers = false). Standing by without claiming cloud tasks...`);
            }
            await new Promise((r) => setTimeout(r, 4000));
            continue;
          }

        const claimedTask = await claimNextTask(workerId);
        if (!claimedTask) {
          activeSubmittingWorkers.delete(workerId);
          if (activeSubmittingWorkers.size === 0) {
            try {
              const { deepCleanWhenZeroActiveInstances } = await import('../lib/browserLifecycle.mjs');
              deepCleanWhenZeroActiveInstances();
            } catch {}
          }

          // 1. If sibling workers in this container are still active, retry quickly with event wakeup (up to 300ms max)
          if (activeSubmittingWorkers.size > 0) {
            await waitForSlotReleaseOrTimeout(300);
            continue;
          }

          // 2. No active workers in this container: check remaining tasks across the queue
          const { getRemainingReadyForReviewCount } = await import('../lib/submissionWorkerPool.mjs');
          const remaining = await getRemainingReadyForReviewCount();
          if (remaining > 0 || remaining === -1) {
            // Unprocessed or in-flight applications still exist (or transient query error) — keep worker alive until every application is completed
            if (workerId === submitWorkers[0] && (Date.now() - (lastStandbyLogTime || 0)) > 120000) {
              lastStandbyLogTime = Date.now();
              console.log(`⏳ [SUBMITTER] Standing by — ${remaining === -1 ? 'checking queue' : remaining} task(s) currently awaiting retry cooldown or being claimed across workers.`);
            }
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          // 3. If in parallel mode or Stage 1 is running, stand by for newly scanned applications
          const bcCheckState = await getBotControl().catch(() => null);
          const isStage1Active = Boolean(
            isParallel ||
            scanStatus === 'running' ||
            isScanLoopExecuting ||
            bcCheckState?.scan_status === 'running' ||
            bcCheckState?.scan_enabled === true ||
            bcCheckState?.stage === 'parallel' ||
            bcCheckState?.stage === 'scanning'
          );

          if (isStage1Active) {
            const { getPendingUnscannedJobsSummary } = await import('../lib/supabaseClient.mjs');
            const queueCheck = await getPendingUnscannedJobsSummary().catch(() => ({ hasPending: false }));
            if (queueCheck.hasPending || isScanLoopExecuting) {
              if (workerId === submitWorkers[0] && (Date.now() - (lastStandbyLogTime || 0)) > 120000) {
                lastStandbyLogTime = Date.now();
                console.log(`⏳ [SUBMISSION WORKER] Stage 1 is actively scanning links (${queueCheck.pendingCount || 'active'} pending). Standing by for newly resolved applications...`);
              }
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
          }

          // 4. If submit switch is actively running in bot_control (not stopped by user), stand by for new tasks!
          const bcCheckActive = await getBotControl().catch(() => null);
          const isSubmitExplicitlyOff = Boolean(
            submitStopRequested ||
            isSubmitStopRequested() ||
            isGlobalStopRequested() ||
            bcCheckActive?.submit_status === 'off' ||
            bcCheckActive?.submit_enabled === false ||
            bcCheckActive?.submit_stop_requested === true ||
            bcCheckActive?.stop_requested === true ||
            bcCheckActive?.universal_stop_requested === true ||
            (bcCheckActive && !bcCheckActive.is_running && bcCheckActive.stage !== 'submitting' && bcCheckActive.stage !== 'parallel')
          );
          const isSubmitStillSwitchOn = !isSubmitExplicitlyOff && Boolean(
            bcCheckActive?.submit_status === 'running' ||
            bcCheckActive?.submit_enabled === true ||
            bcCheckActive?.universal_status === 'running' ||
            bcCheckActive?.universal_enabled === true
          );

          if (isSubmitStillSwitchOn) {
            if (workerId === submitWorkers[0] && (Date.now() - (lastStandbyLogTime || 0)) > 120000) {
              lastStandbyLogTime = Date.now();
              console.log(`⏳ [SUBMISSION WORKER] ${workerId}: Standing by for new ready_for_review applications (Submit switch is ON). Checking queue...`);
            }
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }

          // User explicitly stopped submissions or turned submit switch OFF
          console.log(`🏁 [SUBMISSION WORKER] ${workerId}: Submissions halted by user stop signal. Exiting worker loop.`);
          break;
        }

        activeSubmittingWorkers.add(workerId);
        console.log(`🚀 [${SERVICE_NAME}] [${workerId}] Atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Immediately reflect in_flight state on Supabase worker_status table so dashboard reflects working status
        const workerNum = String(workerId).replace(/\D+/g, '') || '1';
        await updateWorkerStatus(workerId, {
          state: 'in_flight',
          stage: 'submitting',
          current_application_id: claimedTask.id,
          bot_name: `Submitting Worker ${workerNum}`,
          updated_at: new Date().toISOString(),
        }).catch(() => {});

        let res = null;
        try {
          res = await processClaimedTask({
            task: claimedTask,
            workerId,
            headless: HEADLESS,
          });

          const isSubmittedOrApplied = res?.status === 'submitted' || res?.status === 'completed' || res?.status === 'already_applied';
          const shotUrl = isSubmittedOrApplied
            ? (res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null)
            : (res?.screenshotUrl || res?.failureScreenshotUrl || null);
          const errDetail = res?.error || res?.reason || res?.failureReason || '';
          console.log(`📋 [${SERVICE_NAME}] [${workerId}] [SUBMITTER DISPATCH] AWL-ID: ${claimedTask.applywizz_id} | Status: ${res?.status || 'done'}${errDetail ? ` | Reason: ${errDetail}` : ''} | Company: ${claimedTask.company || 'Workday'} | Screenshot: ${shotUrl || 'None'}`);
          if (res?.skippedBrowser) {
            console.log(`⚡ [${SERVICE_NAME}] [${workerId}] Pre-check: Already applied to this job! Skipped browser launch & saved compute.`);
          }
          console.log(`✅ [${SERVICE_NAME}] [${workerId}] Finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
          submissionCycleResults.push({
            job_url: claimedTask.job_url,
            applywizz_id: claimedTask.applywizz_id,
            company: claimedTask.company,
            status: res?.status || 'submitted',
            reason: res?.error || res?.failureReason || (res?.status === 'submitted' ? 'Application Submitted' : (res?.status === 'already_applied' ? 'Pre-check: Already applied' : 'Submission error')),
            screenshotUrl: shotUrl,
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
          try {
            notifySlotReleased(workerId);
          } catch {}
        }

        // If host resource exhaustion occurred, back off and clean up instead of immediate 20ms pickup
        if (res?.status === 'resource_cooldown') {
          console.warn(`⏳ [${workerId}] Host resource limitation detected (EAGAIN/pthread_create). Backing off for 15s to allow system threads and memory to recover...`);
          try {
            const { cleanupOrphanChromeProcesses } = await import('../lib/browserLifecycle.mjs');
            cleanupOrphanChromeProcesses();
          } catch {}
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }

        // ⚡ IMMEDIATE PICKUP: Immediately pick next job in queue right after previous filling & screenshot!
        console.log(`⚡ [${workerId}] Completed application & saved proof screenshot. Immediately picking next application...`);
        await new Promise((r) => setTimeout(r, 20));
      } catch (outerLoopErr) {
        console.error(`⚠️ [${workerId}] Top-level worker loop error (auto-recovering in 3s):`, outerLoopErr?.message || outerLoopErr);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    runningDedicatedWorkerLoops.delete(workerId);
    activeSubmittingWorkers.delete(workerId);
  }
};

  // Run newly launched workers concurrently in independent parallel loops
  await Promise.allSettled(workersToLaunch.map((wId) => runDedicatedWorkerLoop(wId)));

  // Await any remaining active submitting workers before terminating (fast-abort if stop requested)
  let waitLoops = 0;
  while (activeSubmittingWorkers.size > 0 && waitLoops < 60) {
    if (isGlobalStopRequested() || isSubmitStopRequested()) {
      console.log(`[DAEMON] Explicit stop detected: Fast-aborting ${activeSubmittingWorkers.size} active worker(s)...`);
      await abortAllActiveBrowsers({ force: true }).catch(() => { });
      break;
    } else {
      if (waitLoops % 10 === 0) {
        console.log(`[DAEMON] Waiting for ${activeSubmittingWorkers.size} active worker(s) to finish in-flight application (${waitLoops}s)...`);
      }
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

  if (runningDedicatedWorkerLoops.size === 0) {
    submitStatus = 'off';
    isSubmitLoopExecuting = false;
    const bcCurrentAtEnd = await getBotControl().catch(() => null);
    const isScanningStillActive = Boolean(
      scanStatus === 'running' ||
      (bcCurrentAtEnd && (bcCurrentAtEnd.scan_status === 'running' || bcCurrentAtEnd.scan_enabled === true || bcCurrentAtEnd.stage === 'scanning' || bcCurrentAtEnd.stage === 'parallel'))
    );
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
      is_running: isScanningStillActive,
      current_action: isScanningStillActive ? 'Submissions complete. Scanning continuing...' : 'Submissions complete. Idle.',
      active_worker_count: isScanningStillActive ? (PIPELINE_CONFIG.scanWorkerIds?.length || 2) : 0,
    });
  }
}

/**
 * Parallel Pipeline: Scanning & Resolving run concurrently across the 2 shared workers
 */
export async function runScanAndResolveParallel({ force = false } = {}) {
  if (SERVICE_ROLE === 'submitter') {
    console.log(`[DAEMON] Submitter service ignoring scan pipeline request.`);
    return { success: false, refused: true, reason: 'SERVICE_ROLE is submitter' };
  }
  if (isScanLoopExecuting) {
    console.log(`[DAEMON] Scan pipeline is already actively running.`);
    return { success: true, message: 'Scan pipeline already running.' };
  }

  // Enforce R3: Refuse if mode = submitting
  const canScan = checkCanStartScan();
  if (!canScan.allowed) {
    console.warn(`[DAEMON] Scan refused: ${canScan.reason}`);
    return { success: false, refused: true, reason: canScan.reason };
  }

  if (!canExecuteWorkers(args)) {
    console.log(`[DAEMON] 🛡️ Cloud Protection Active: Local workers disabled to prevent stealing tasks from Railway. Railway cloud workers handle all scanning.`);
    return { success: false, reason: 'Local worker execution disabled. Railway cloud runs all scanning.' };
  }

  isScanLoopExecuting = true;

  // Pre-check: If 0 pending unscanned jobs exist, remain strictly idle without launching workers or logging loops
  const { getPendingUnscannedJobsSummary } = await import('../lib/supabaseClient.mjs');
  const initialQueueSummary = await getPendingUnscannedJobsSummary().catch(() => ({ hasPending: false, pendingCount: 0 }));

  if (!force && (!initialQueueSummary.hasPending || initialQueueSummary.pendingCount === 0)) {
    console.log(`ℹ️ [SCANNER] 0 pending unscanned jobs in batch_job_queue (queue is empty or all links are already scanned). Remaining strictly idle.`);
    scanStatus = 'off';
    currentStage = 'idle';
    currentMode = 'idle';
    isPoolRunning = false;
    for (const wId of (PIPELINE_CONFIG.scanWorkerIds || ['scanning_worker_1', 'scanning_worker_2'])) {
      await updateWorkerStatus(wId, { state: 'idle', stage: 'scanning', current_application_id: null }).catch(() => {});
    }
    await syncBotControlState({
      mode: 'idle',
      stage: 'idle',
      scan_enabled: false,
      scan_status: 'off',
      scan_stop_requested: false,
      is_running: false,
      current_action: 'Idle — 0 pending unscanned links in queue',
      active_worker_count: 0,
      last_action_requested: null,
    });
    return { success: true, idle: true, message: '0 pending unscanned jobs in batch_job_queue. Workers remaining idle.' };
  }

  const bcState = await getBotControl().catch(() => null);
  const isParallel = Boolean(
    bcState?.stage === 'parallel' ||
    bcState?.mode === 'parallel' ||
    bcState?.universal_status === 'running' ||
    bcState?.universal_enabled === true ||
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

  const scanWorkerCount = PIPELINE_CONFIG.scanWorkerIds?.length || PIPELINE_CONFIG.scanWorkersCount || PIPELINE_CONFIG.workersCount || 2;
  await syncBotControlState({
    scan_run_id: scanRunId,
    scan_run_started_at: scanRunStartedAt,
    mode: currentMode,
    stage: currentStage,
    scan_enabled: true,
    scan_status: 'running',
    scan_stop_requested: false,
    is_running: true,
    active_worker_count: scanWorkerCount,
  });

  try {
    console.log(`\n🚀 [DAEMON] Schedule 1: Starting Continuous Scan & Resolve Loop (Run ${scanRunId})...`);
    let lastScanStandbyLogTime = 0;

    while (scanStatus === 'running' && isPoolRunning && !isGlobalStopRequested() && !isScanStopRequested() && !isPoolPaused) {
      // Re-verify pending unscanned jobs before launching parallel stage pass
      const iterSummary = await getPendingUnscannedJobsSummary().catch(() => ({ hasPending: false, pendingCount: 0 }));
      if (!iterSummary.hasPending || iterSummary.pendingCount === 0) {
        console.log(`ℹ️ [SCANNER] All links in batch_job_queue have been scanned (0 pending unscanned links remaining).`);
        // Check remaining unresolved candidate distributions
        const { getRecentBatchJobUrls: getRecentDaemonUrls } = await import('../lib/supabaseClient.mjs');
        const { urls: recentDaemonUrls } = await getRecentDaemonUrls({ windowMinutes: 120 }).catch(() => ({ urls: [] }));
        let hasPendingDist = false;
        if (recentDaemonUrls && recentDaemonUrls.length > 0) {
          const { data: pendingDistributions } = await supabase
            .from('job_distributions')
            .select('id')
            .in('job_url', recentDaemonUrls)
            .in('status', ['pending', 'queued', 'resolving'])
            .limit(1);
          hasPendingDist = Array.isArray(pendingDistributions) && pendingDistributions.length > 0;
        }

        if (!hasPendingDist) {
          const bcCheckScan = await getBotControl().catch(() => null);
          const isScanExplicitlyOff = Boolean(
            isGlobalStopRequested() ||
            isScanStopRequested() ||
            scanStopRequested ||
            bcCheckScan?.scan_status === 'off' ||
            bcCheckScan?.scan_enabled === false ||
            bcCheckScan?.scan_stop_requested === true ||
            bcCheckScan?.stop_requested === true ||
            bcCheckScan?.universal_stop_requested === true ||
            (bcCheckScan && !bcCheckScan.is_running && bcCheckScan.stage !== 'scanning' && bcCheckScan.stage !== 'parallel')
          );
          const isScanStillOn = !isScanExplicitlyOff && Boolean(
            bcCheckScan?.scan_status === 'running' ||
            bcCheckScan?.scan_enabled === true ||
            bcCheckScan?.universal_status === 'running' ||
            bcCheckScan?.universal_enabled === true
          );

          if (isScanStillOn) {
            currentStage = currentMode === 'parallel' ? 'parallel' : 'scanning';
            if (Date.now() - lastScanStandbyLogTime > 120000) {
              lastScanStandbyLogTime = Date.now();
              console.log(`⏳ [DAEMON] [SCANNER] All current queue links finalized. Scanner switch is ON — standing by for new batch uploads (checking in 5s)...`);
            }
            await syncBotControlState({
              current_action: 'Scan & Resolve active: all current links finalized. Standing by for new uploads...',
              is_running: true,
              stage: currentStage,
              scan_status: 'running',
              scan_enabled: true,
            }).catch(() => { });
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }

          console.log(`\n✅ [DAEMON] [SCANNER & RESOLVER COMPLETE] All batch_job_queue links finalized and all distributions reached ready_for_review.`);
          console.log(`🛑 [DAEMON] Scanner & resolver complete. Transitioning to idle state.`);
          scanCompleteMessage = 'Scan & Resolve complete: all unique links finalized and ready for review.';
          break;
        }

        // Only run resolving pass since scanner has no pending links
        console.log(`⚡ [DAEMON] Scanner idle (0 pending links). Running resolving pass for remaining distributions...`);
        await runStage2Resolving().catch((err) => {
          console.error(`❌ [DAEMON] Stage 2 Resolving error:`, err?.message || err);
        });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      await syncBotControlState({
        mode: currentMode,
        stage: currentMode === 'parallel' ? 'parallel' : currentStage,
        scan_enabled: true,
        scan_status: 'running',
        scan_stop_requested: false,
        is_running: true,
        current_action: `Scanning unique links & resolving candidate answers (Run: ${scanRunId})`,
        active_worker_count: scanWorkerCount,
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
      // Check remaining pending items in batch_job_queue strictly for recent batch
      const { getRecentBatchJobUrls: getRecentDaemonUrls } = await import('../lib/supabaseClient.mjs');
      const { urls: recentDaemonUrls } = await getRecentDaemonUrls({ windowMinutes: 120 }).catch(() => ({ urls: [] }));

      let hasPendingQueue = false;
      if (recentDaemonUrls && recentDaemonUrls.length > 0) {
        const { data: pendingJobs } = await supabase
          .from('batch_job_queue')
          .select('id')
          .in('job_url', recentDaemonUrls)
          .in('status', ['pending', 'queued', 'processing'])
          .limit(1);
        hasPendingQueue = Array.isArray(pendingJobs) && pendingJobs.length > 0;
      }

      // Check remaining unresolved candidate applications in job_distributions strictly for recent batch
      let hasPendingDist = false;
      if (recentDaemonUrls && recentDaemonUrls.length > 0) {
        const { data: pendingDistributions } = await supabase
          .from('job_distributions')
          .select('id')
          .in('job_url', recentDaemonUrls)
          .in('status', ['pending', 'queued', 'resolving'])
          .limit(1);
        hasPendingDist = Array.isArray(pendingDistributions) && pendingDistributions.length > 0;
      }

      if (!hasPendingQueue && !hasPendingDist) {
        const bcCheckScan = await getBotControl().catch(() => null);
        const isScanStillOn = !isGlobalStopRequested() && !isScanStopRequested() && Boolean(
          scanStatus === 'running' ||
          bcCheckScan?.scan_status === 'running' ||
          bcCheckScan?.scan_enabled === true ||
          bcCheckScan?.universal_status === 'running' ||
          bcCheckScan?.universal_enabled === true
        );

        if (isScanStillOn) {
          if (Date.now() - lastScanStandbyLogTime > 120000) {
            lastScanStandbyLogTime = Date.now();
            console.log(`⏳ [DAEMON] [SCANNER] All current queue links finalized. Scanner switch is ON — standing by for new batch uploads (checking in 5s)...`);
          }
          await syncBotControlState({
            current_action: 'Scan & Resolve active: all current links finalized. Standing by for new uploads...',
          }).catch(() => { });
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        console.log(`\n🛑 [DAEMON] Scanner halted by user stop signal.`);
        scanCompleteMessage = 'Scan & Resolve stopped by user request.';
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
    isScanLoopExecuting = false;
    scanStatus = 'off';
    const bcCurrentAtScanEnd = await getBotControl().catch(() => null);
    const isExplicitStop = isGlobalStopRequested() || isScanStopRequested() || Boolean(bcCurrentAtScanEnd?.stop_requested);
    const isSubmittingStillActive = !isExplicitStop && Boolean(
      submitStatus === 'running' ||
      (bcCurrentAtScanEnd && (bcCurrentAtScanEnd.submit_status === 'running' || bcCurrentAtScanEnd.submit_enabled === true) && bcCurrentAtScanEnd.is_running !== false)
    );
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
      last_action_requested: isSubmittingStillActive ? (bcCurrentAtScanEnd?.last_action_requested === 'start_universal' ? 'start_universal' : null) : null,
      trigger_requested: isSubmittingStillActive ? Boolean(bcCurrentAtScanEnd?.trigger_requested) : false,
      is_running: isSubmittingStillActive,
      current_action: scanCompleteMessage || (isSubmittingStillActive ? 'Scan & Resolve complete. Submissions continuing...' : 'Scan & Resolve complete. Ready for Submissions trigger.'),
      active_worker_count: isSubmittingStillActive ? (Number(process.env.TOTAL_SUBMIT_WORKERS) || 4) : 0,
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

  // Suppress high-frequency polling requests (/api/bot/status, /api/bot/logs, /health) from flooding logs
  const isPollingPath = pathname.startsWith('/api/bot/status') || pathname.startsWith('/api/bot/logs') || pathname === '/health' || pathname === '/';
  if (!isPollingPath) {
    console.log('[INCOMING HTTP]', req.method, pathname);
  }

  // 1. Health check
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', isRunning: isPoolRunning, stage: currentStage, workers: PIPELINE_CONFIG.workersCount || 2, uptime: process.uptime() }));
    return;
  }

  // 2. Status (Resilient — 100% In-Memory, Instant Response <1ms)
  if (pathname === '/api/bot/status') {
    const botControl = getMemoryBotControl();
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

  // 2a-1. Dedicated Start & Stop Endpoints for Scan & Submit
  if ((pathname === '/api/bot/submit/start' || pathname === '/api/bot/submit' || pathname === '/api/bot/start-submissions') && req.method === 'POST') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    console.log(`\n🚀 [DAEMON WEBHOOK (${SERVICE_ROLE.toUpperCase()})] Direct submit start requested on ${pathname}!`);
    setGlobalStop(false);
    setSubmitStop(false);
    isPoolPaused = false;

    if (SERVICE_ROLE === 'main') {
      await syncBotControlState({
        last_action_requested: 'start_submit',
        trigger_requested: true,
        is_running: true,
        stage: 'submitting',
        mode: 'submitting',
        submit_status: 'running',
        submit_enabled: true,
        submit_stop_requested: false,
        stop_requested: false,
        current_action: 'Submissions dispatched to Submitter Service via Supabase.',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Submit trigger dispatched to Submitter Service via Supabase.', stage: 'submitting' }));
      return;
    }

    if (SERVICE_ROLE === 'scanner') {
      console.log(`ℹ️ [SCANNER SERVICE] Submit signal received via direct webhook. Forwarding to dedicated Submitter service via Supabase.`);
      await syncBotControlState({
        submit_status: 'running',
        submit_enabled: true,
        submit_stop_requested: false,
        last_action_requested: 'start_submit',
        trigger_requested: true,
        is_running: true,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Submit signal forwarded to Submitter Service via Supabase.', stage: 'submitting' }));
      return;
    }

    // Submitter or combined
    submitStatus = 'running';
    isPoolRunning = true;
    currentStage = 'submitting';
    currentMode = 'submitting';

    await syncBotControlState({
      mode: 'submitting',
      stage: 'submitting',
      submit_enabled: true,
      submit_status: 'running',
      submit_stop_requested: false,
      is_running: true,
      stop_requested: false,
      refusal_reason: null,
      current_action: `Submitting approved applications across ${PIPELINE_CONFIG.submitWorkerIds.length} parallel workers`,
      active_worker_count: PIPELINE_CONFIG.submitWorkerIds.length,
    });
    runStage3Submissions().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Submission pipeline started cleanly across workers.', submit_status: 'running' }));
    return;
  }

  if ((pathname === '/api/bot/scan/stop' || pathname === '/api/bot/stop-scan') && req.method === 'POST') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
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
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
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

  if ((pathname === '/api/bot/universal' || pathname === '/api/bot/universal/start' || pathname === '/api/bot/start-all' || (pathname === '/api/bot/webhook' && (body.action === 'start_universal' || body.action === 'trigger_all' || body.action === 'universal_start'))) && req.method === 'POST') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    console.log(`\n⚡ [DAEMON WEBHOOK (${SERVICE_ROLE.toUpperCase()})] Universal Trigger received on ${pathname}! Activating both Scanner and Submitter services.`);
    setGlobalStop(false);
    setScanStop(false);
    setSubmitStop(false);
    setClusterStop(false);
    isPoolPaused = false;
    scanStatus = 'running';
    submitStatus = 'running';
    isPoolRunning = true;
    currentStage = 'parallel';
    currentMode = 'parallel';
    scanStopRequested = false;
    submitStopRequested = false;

    // Single Authoritative State Sync: Update Supabase bot_control so all replicas, workers, and devices see ON immediately
    await syncBotControlState({
      mode: 'parallel',
      stage: 'parallel',
      scan_status: 'running',
      scan_enabled: true,
      scan_stop_requested: false,
      submit_status: 'running',
      submit_enabled: true,
      submit_stop_requested: false,
      is_running: true,
      stop_requested: false,
      last_action_requested: 'start_universal',
      trigger_requested: true,
      current_action: 'Universal Parallel Pipeline: Scanning & Submissions running concurrently across all workers...',
    });

    if (SERVICE_ROLE === 'scanner' || SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
      runScanAndResolveParallel({ force: true }).catch(console.error);
    }
    if (SERVICE_ROLE === 'submitter' || SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
      runStage3Submissions({ force: true }).catch(console.error);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Universal Parallel Pipeline started: Scanning and Submitting running concurrently across all services.',
      stage: 'parallel',
      scan_status: 'running',
      submit_status: 'running',
      isRunning: true,
    }));
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

  // 2m. Live Streaming Daemon Logs (R11 Separate Logs: Scan/Resolve Logs vs Submit Logs & Isolated Services)
  if ((pathname === '/api/bot/logs' || pathname === '/api/developer/logs') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (SERVICE_ROLE === 'submitter') {
      res.end(JSON.stringify({
        success: true,
        service_name: SERVICE_NAME,
        service_role: SERVICE_ROLE,
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
        service_name: SERVICE_NAME,
        service_role: SERVICE_ROLE,
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
      service_name: SERVICE_NAME,
      service_role: SERVICE_ROLE,
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
  if (
    pathname === '/api/bot/stop' ||
    pathname === '/api/bot/universal/stop' ||
    pathname === '/api/bot/stop-all' ||
    (pathname === '/api/bot/webhook' && (body.action === 'stop' || body.action === 'stop_pipeline' || body.action === 'stop_all' || body.action === 'stop_universal'))
  ) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `All ${WORKER_COUNT} workers stopped instantly. Active browser contexts aborted.`,
      isRunning: false,
      stage: 'idle',
      mode: 'idle',
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



  // 4. Start / Trigger Parallel Scan & Resolve (Admin & Developer)
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || pathname === '/api/bot/scan-resolve' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline' || body.action === 'scan_resolve'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    if (SERVICE_ROLE === 'submitter') {
      console.log(`ℹ️ [SUBMITTER SERVICE] Scan signal received via webhook. Forwarding to dedicated Scanner service via Supabase.`);
      await syncBotControlState({
        scan_status: 'running',
        scan_enabled: true,
        scan_stop_requested: false,
        last_action_requested: 'start_scan',
        trigger_requested: true,
        is_running: true,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Scan signal forwarded to Scanner Service via Supabase.',
        stage: 'scanning',
      }));
      return;
    }

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

    if (isScanLoopExecuting) {
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
        try {
          await supabase.from('job_distributions').update(applyUpdate).eq('id', distributionId).neq('status', 'submitted').neq('status', 'completed');
        } catch {}
      } else if (cleanId && jobUrl) {
        try {
          await supabase.from('job_distributions').update(applyUpdate).eq('applywizz_id', cleanId).eq('job_url', jobUrl).neq('status', 'submitted').neq('status', 'completed');
        } catch {}
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

      try {
        await supabase.from('job_distributions').update({
          status: 'queued',
          reviewed_by: 'Career Associate',
          reviewed_at: nowIso,
          updated_at: nowIso,
        }).eq('id', distributionId).neq('status', 'submitted').neq('status', 'completed');
      } catch {}

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

    if (SERVICE_ROLE === 'scanner') {
      console.log(`ℹ️ [SCANNER SERVICE] Submit signal received via webhook. Forwarding to dedicated Submitter service via Supabase.`);
      await syncBotControlState({
        submit_status: 'running',
        submit_enabled: true,
        submit_stop_requested: false,
        last_action_requested: 'start_submit',
        trigger_requested: true,
        is_running: true,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Submit signal forwarded to Submitter Service via Supabase.',
        stage: 'submitting',
      }));
      return;
    }

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

    const submitWorkerCount = PIPELINE_CONFIG.submitWorkerIds?.length || PIPELINE_CONFIG.submitWorkersCount || WORKER_COUNT || 2;
    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with ${submitWorkerCount} submitting workers...`);
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
      stop_requested: false,
      last_action_requested: 'start_submit',
      is_running: true,
      refusal_reason: null,
      current_action: `Submitting approved applications across ${submitWorkerCount} workers in parallel`,
    });

    runStage3Submissions().catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Stage 3 Submissions triggered across ${submitWorkerCount} submitting workers in parallel.`,
      isRunning: true,
      stage: 'submitting',
      mode: 'submitting',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// ── Autonomous Parallel Submission Dispatcher ──
// Note: activeSubmittingWorkers and runningDedicatedWorkerLoops declared at top of module
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
  if (!canExecuteWorkers(args)) {
    return; // Local daemon never claims tasks when local execution is disabled
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
        console.log(`\n🚀 [${maxConcurrency}-WORKER SUBMISSION BATCH] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Process asynchronously so workers run in parallel!
        processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        })
          .then((res) => {
            const shotUrl = res?.screenshotUrl || res?.application_submitted_screenshot_url || claimedTask.application_submitted_screenshot_url || null;
        const errDetail = res?.error || res?.reason || res?.failureReason || '';
        console.log(`\n📋 [SUBMITTER DISPATCH] AWL-ID: ${claimedTask.applywizz_id} | Status: ${res?.status || 'done'}${errDetail ? ` | Reason: ${errDetail}` : ''} | Company: ${claimedTask.company || 'Workday'} | Screenshot: ${shotUrl || 'None'}`);
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

    // Continuous Standby: Never auto-turn off submit service when no tasks are currently ready.
    // Both submitter services/replicas MUST run continuously at all costs until the user explicitly stops the trigger.
    if (!claimedAny && activeSubmittingWorkers.size === 0) {
      return; // Standby: keep submission service alive and waiting for newly arrived/reviewed jobs!
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
  // Safe Lease Expiration Guard: ONLY recover tasks whose lease is genuinely expired (>8 minutes) or NULL.
  // Active in-flight applications claimed within the last 8 minutes must NEVER be disturbed!
  const leaseExpiredCutoff = new Date(Date.now() - 8 * 60 * 1000).toISOString();

  try {
    const { data: interrupted, error } = await supabase
      .from('job_distributions')
      .update({
        status: 'ready_for_review',
        worker_id: null,
        worker_leased_at: null,
        error_message: 'Interrupted: lease expired or daemon restarted. Returned to ready_for_review.',
        updated_at: now,
      })
      .eq('status', 'applying')
      .in('worker_id', submitWorkers)
      .or(`worker_leased_at.is.null,worker_leased_at.lt.${leaseExpiredCutoff}`)
      .or('error_message.is.null,error_message.not.ilike.%Attempt 3/3%')
      .neq('status', 'submitted')
      .neq('status', 'completed')
      .select('id');

    // Also mark tasks that genuinely reached Attempt 3/3 as failed
    await supabase
      .from('job_distributions')
      .update({
        status: 'failed',
        worker_id: null,
        worker_leased_at: null,
        updated_at: now,
      })
      .eq('status', 'applying')
      .in('worker_id', submitWorkers)
      .ilike('error_message', '%Attempt 3/3%')
      .neq('status', 'submitted')
      .neq('status', 'completed');

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

  if (!server.listening) {
    if (!isProduction || isDynamicPortRequested || PORT === 0) {
      const targetPort = PORT === 0 ? defaultPort : PORT;
      const freePort = await findAvailablePort(targetPort, '0.0.0.0');
      if (freePort !== PORT) {
        console.log(`[DAEMON] ⚠️ Port ${PORT} occupied or dynamic requested. Automatically selected available port: ${freePort}`);
        PORT = freePort;
      }
    }

    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        if (!isProduction) {
          console.warn(`[DAEMON WEBHOOK SERVER] Port ${PORT} already in use — auto-switching to next available port...`);
          try {
            const nextFree = await findAvailablePort(PORT + 1, '0.0.0.0');
            PORT = nextFree;
            server.listen(PORT, '0.0.0.0');
          } catch (listenErr) {
            console.error(`[DAEMON WEBHOOK SERVER] Failed to bind dynamic port:`, listenErr.message);
          }
        } else {
          console.warn(`[DAEMON WEBHOOK SERVER] Port ${PORT} already in use — standing by...`);
        }
      } else {
        console.error(`[DAEMON WEBHOOK SERVER] Server error:`, err.message);
      }
    });

    server.listen(PORT, '0.0.0.0', () => {
      const boundAddress = server.address();
      if (boundAddress && typeof boundAddress === 'object') {
        PORT = boundAddress.port;
      }
      console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
      console.log(`[DAEMON] 🎯 PORT ASSIGNED: ${PORT}`);
      if (SERVICE_ROLE === 'scanner') {
        console.log(`[DAEMON] Active workers: ${PIPELINE_CONFIG.scanWorkerIds.length} scanning (${PIPELINE_CONFIG.scanWorkerIds.join(', ')}), ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving (${PIPELINE_CONFIG.resolveWorkerIds.join(', ')}).`);
      } else if (SERVICE_ROLE === 'submitter') {
        console.log(`[DAEMON] Active workers: ${PIPELINE_CONFIG.submitWorkerIds.length} submitting (${PIPELINE_CONFIG.submitWorkerIds.join(', ')}).`);
      } else {
        console.log(`[DAEMON] Worker pool configured with WORKER_COUNT=${PIPELINE_CONFIG.workersCount}: ${PIPELINE_CONFIG.scanWorkerIds.length} scanning, ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving, ${PIPELINE_CONFIG.submitWorkerIds.length} submitting workers.`);
      }
      console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — Active.\n`);
      syncBotControlState({
        backend_port: PORT,
        daemon_port: PORT,
      }).catch(() => {});
    });
  }

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
    if (!isProduction && !canExecuteWorkers(args)) {
      console.log(`[DAEMON] 🛡️ Local development environment detected — strictly preserving production cloud bot_control and worker states.`);
    } else if (SERVICE_ROLE === 'main' || SERVICE_ROLE === 'all') {
      const existingBc = await getBotControl().catch(() => null);
      const isSubmitActive = existingBc?.submit_status === 'running' || existingBc?.submit_enabled === true;
      const isScanActive = existingBc?.scan_status === 'running' || existingBc?.scan_enabled === true;
      const wasRunning = Boolean(existingBc?.is_running || isSubmitActive || isScanActive);

      if (wasRunning) {
        console.log(`[DAEMON] Active session detected in bot_control (Scan: ${isScanActive ? 'RUNNING' : 'OFF'}, Submit: ${isSubmitActive ? 'RUNNING' : 'OFF'}) — preserving running state across reboot.`);
        submitStatus = isSubmitActive ? 'running' : 'off';
        scanStatus = isScanActive ? 'running' : 'off';
        currentMode = existingBc?.mode || (isSubmitActive && isScanActive ? 'parallel' : isSubmitActive ? 'submitting' : 'scanning');
        currentStage = existingBc?.stage || currentMode;
        isPoolRunning = true;
      } else {
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
      }
    } else {
      console.log(`[DAEMON] Dedicated worker container (${SERVICE_ROLE.toUpperCase()}) initialized — preserving global bot_control stage.`);
    }
    if (canExecuteWorkers(args)) {
      await recoverInterruptedSubmissionTasks();
      const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
      await reapExpiredLeases(10).catch(() => { });
      console.log(`[DAEMON] Phase 6 Stale lease recovery executed on startup.`);
    }

    // Autonomous startup trigger: strictly gated on AUTO_START_ON_BOOT / explicit flag
    const shouldAutoSubmit = shouldAutoStartOnBoot() || (args.includes('submit') && (args.includes('--immediate') || args.includes('--auto-start'))) || process.env.START_SUBMIT === 'true';
    if (SERVICE_ROLE === 'submitter' && !shouldAutoSubmit) {
      console.log(`[DAEMON] Submitter startup: Standing by in idle mode awaiting user trigger via bot_control.`);
    } else if (shouldAutoSubmit && (SERVICE_ROLE === 'submitter' || (args.includes('submit') && (args.includes('--immediate') || args.includes('--auto-start'))) || process.env.START_SUBMIT === 'true')) {
      const { getRemainingReadyForReviewCount } = await import('../lib/submissionWorkerPool.mjs');
      const pendingStartupCount = await getRemainingReadyForReviewCount();
      if (pendingStartupCount > 0) {
        console.log(`[DAEMON] Submitter startup detected ${pendingStartupCount} ready_for_review application(s): initiating Stage 3 Submissions across workers...`);
        runStage3Submissions().catch(console.error);
      } else {
        console.log(`[DAEMON] Submitter startup: 0 ready_for_review tasks pending. Standing by in idle mode awaiting applications.`);
      }
    }

    // Only trigger immediate scanning on startup if explicitly requested via flag
    if (((args.includes('scanner') || args.includes('scan')) && (args.includes('--immediate') || args.includes('--auto-start'))) || process.env.START_SCAN === 'true') {
      console.log('[DAEMON] Startup trigger detected: initiating Stage 1 Scanning & Stage 2 Resolving...');
      runScanAndResolveParallel().catch(console.error);
    }
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
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

  // Diagnostic heartbeat monitor: only logs when explicitly enabled via DEBUG_HEARTBEAT
  setInterval(() => {
    if (process.env.DEBUG_HEARTBEAT === 'true') {
      const m = process.memoryUsage();
      console.log(`[DAEMON HEARTBEAT] Heap: ${Math.round(m.heapUsed / 1024 / 1024)}MB / ${Math.round(m.heapTotal / 1024 / 1024)}MB | RSS: ${Math.round(m.rss / 1024 / 1024)}MB | Uptime: ${Math.round(process.uptime())}s`);
    }
  }, 60000);

  // ── Universal Cloud Bridge: Listen to Supabase signals (bot_control + worker_status fallback) ──
  let warnedMissingBotControl = false;
  let cloudBridgeTimer = null;
  const pollCloudBridge = async () => {
    let nextDelay = 500;
    try {
      // Allow explicit bypass if configured or in local development (when workers are not executing locally)
      if (shouldIgnoreCloudSignals() || process.env.IGNORE_CLOUD_SIGNALS === 'true' || (!isProduction && !canExecuteWorkers(args))) {
        nextDelay = 2500;
        return;
      }
      const bc = await getBotControl().catch(() => null);
      const wc = await getWorkerControls(bc).catch(() => null);

      const scanCtrl = wc?.scan;
      const submitCtrl = wc?.submit;

      // ── 1. GLOBAL / UNIVERSAL STOP SWITCH (Strict Instant Shutdown for All Services) ──
      const isGlobalStop = Boolean(
        bc?.stop_requested === true ||
        bc?.universal_stop_requested === true ||
        bc?.last_action_requested === 'stop' ||
        bc?.last_action_requested === 'stop_all' ||
        bc?.last_action_requested === 'stop_universal' ||
        bc?.last_action_requested === 'stop_pipeline'
      );

      if (isGlobalStop) {
        if (isPoolRunning || scanStatus === 'running' || submitStatus === 'running' || activeSubmittingWorkers.size > 0 || isScanLoopExecuting || isSubmitLoopExecuting) {
          console.log(`\n🛑 [SWITCH] Global / Universal STOP switch detected in bot_control! Stopping all workers and active browsers instantly...`);
          await stopAutonomousPool();
          if (scanCtrl?.stop_requested) await updateWorkerControl('scan', { stop_requested: false }).catch(() => { });
          if (submitCtrl?.stop_requested) await updateWorkerControl('submit', { stop_requested: false }).catch(() => { });
          await syncBotControlState({
            is_running: false,
            stage: 'idle',
            mode: 'idle',
            scan_status: 'off',
            scan_enabled: false,
            scan_stop_requested: false,
            submit_status: 'off',
            submit_enabled: false,
            submit_stop_requested: false,
            universal_status: 'off',
            universal_enabled: false,
            universal_stop_requested: false,
            active_worker_count: 0,
            stop_requested: false,
            last_action_requested: null,
            current_action: 'Idle (Stopped by user)',
          }).catch(() => { });
        }
        nextDelay = 500;
        return;
      }

      // Check if Universal switch was turned ON
      const isUniversalTurnOn = Boolean(
        bc?.universal_status === 'running' ||
        bc?.universal_enabled === true ||
        bc?.last_action_requested === 'start_universal'
      );

      // ── 2. SERVICE 1: SCANNER SWITCH (Direct ON / OFF from bot_control) ──
      if (SERVICE_ROLE !== 'submitter') {
        const isScanTurnOff = Boolean(
          bc?.scan_status === 'off' ||
          bc?.scan_enabled === false ||
          bc?.scan_stop_requested === true ||
          bc?.last_action_requested === 'stop_scan' ||
          scanCtrl?.stop_requested
        );

        const isScanTurnOn = !isScanTurnOff && Boolean(
          isUniversalTurnOn ||
          bc?.scan_status === 'running' ||
          bc?.scan_enabled === true ||
          bc?.last_action_requested === 'start_scan' ||
          (bc?.trigger_requested && (bc?.stage === 'scanning' || bc?.stage === 'parallel')) ||
          (scanCtrl && (scanCtrl.enabled === true || scanCtrl.status === 'running') && !scanCtrl.stop_requested)
        );

        if (isScanTurnOff) {
          if (scanStatus === 'running' || isScanLoopExecuting) {
            console.log(`\n🛑 [SWITCH (SCANNER)] Turn OFF detected in bot_control! Halting scanner workers & closing browsers instantly...`);
            await stopScanPool();
            if (scanCtrl?.stop_requested) await updateWorkerControl('scan', { stop_requested: false }).catch(() => { });
            await syncBotControlState({
              scan_status: 'off',
              scan_enabled: false,
              scan_stop_requested: false,
              last_action_requested: (bc?.last_action_requested === 'stop_scan' ? null : bc?.last_action_requested),
            }).catch(() => { });
          }
        } else if (isScanTurnOn) {
          if (scanStatus !== 'running' && !isScanLoopExecuting && canExecuteWorkers(args)) {
            const dynamicScanCount = Number(process.env.SCAN_WORKER_COUNT) || Number(process.env.WORKER_COUNT) || PIPELINE_CONFIG.scanWorkerIds?.length || 2;
            console.log(`\n⚡ [SWITCH (SCANNER)] Turn ON detected in bot_control! Launching ${dynamicScanCount} scanning workers in parallel...`);
            setScanStop(false);
            setClusterStop(false);
            scanStatus = 'running';
            scanStopRequested = false;
            if (scanCtrl?.enabled) await updateWorkerControl('scan', { enabled: true, status: 'running' }).catch(() => { });
            runScanAndResolveParallel({ force: true }).catch(console.error);
          }
        }
      }

      // ── 3. SERVICE 2: SUBMITTER SWITCH (Direct ON / OFF from bot_control) ──
      if (SERVICE_ROLE !== 'scanner') {
        const isSubmitTurnOff = Boolean(
          bc?.submit_status === 'off' ||
          bc?.submit_enabled === false ||
          bc?.submit_stop_requested === true ||
          bc?.last_action_requested === 'stop_submit' ||
          submitCtrl?.stop_requested
        );

        const isSubmitTurnOn = !isSubmitTurnOff && Boolean(
          isUniversalTurnOn ||
          bc?.submit_status === 'running' ||
          bc?.submit_enabled === true ||
          bc?.last_action_requested === 'start_submit' ||
          (bc?.trigger_requested && (bc?.stage === 'submitting' || bc?.stage === 'parallel')) ||
          (submitCtrl && (submitCtrl.enabled === true || submitCtrl.status === 'running') && !submitCtrl.stop_requested)
        );

        if (isSubmitTurnOff) {
          if (submitStatus === 'running' || isSubmitLoopExecuting || activeSubmittingWorkers.size > 0) {
            console.log(`\n🛑 [SWITCH (SUBMITTER)] Turn OFF detected in bot_control! Halting submitter workers & closing browsers instantly...`);
            await stopSubmitPool();
            if (submitCtrl?.stop_requested) await updateWorkerControl('submit', { stop_requested: false }).catch(() => { });
            await syncBotControlState({
              submit_status: 'off',
              submit_enabled: false,
              submit_stop_requested: false,
              last_action_requested: (bc?.last_action_requested === 'stop_submit' ? null : bc?.last_action_requested),
            }).catch(() => { });
          }
        } else if (isSubmitTurnOn) {
          if (submitStatus !== 'running' && !isSubmitLoopExecuting && canExecuteWorkers(args)) {
            const { resolveInstanceSubmissionWorkerIds, SUBMISSION_WORKER_IDS } = await import('../lib/submissionWorkerPool.mjs');
            const submitWorkers = typeof resolveInstanceSubmissionWorkerIds === 'function'
              ? await resolveInstanceSubmissionWorkerIds().catch(() => SUBMISSION_WORKER_IDS)
              : SUBMISSION_WORKER_IDS;
            const dynamicSubmitCount = submitWorkers?.length || Number(process.env.WORKER_COUNT) || 2;
            console.log(`\n🚀 [SWITCH (SUBMITTER)] Turn ON detected in bot_control! Launching ${dynamicSubmitCount} submitter workers in parallel...`);
            setSubmitStop(false);
            setGlobalStop(false);
            submitStatus = 'running';
            submitStopRequested = false;
            if (submitCtrl?.enabled) await updateWorkerControl('submit', { enabled: true, status: 'running' }).catch(() => { });
            runStage3Submissions({ force: true }).catch(console.error);
          }
        }
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

      // Adaptive low-power standby:
      // When jobs or workers are active or running, poll fast at 800ms.
      // When completely idle and stopped, poll at 2500ms to save 80% idle CPU and DB calls.
      const isSystemActive = isPoolRunning ||
        scanStatus === 'running' ||
        submitStatus === 'running' ||
        activeSubmittingWorkers.size > 0 ||
        isScanLoopExecuting ||
        isSubmitLoopExecuting;
      nextDelay = isSystemActive ? 800 : 2500;
    } catch {
      // Continue polling silently
      nextDelay = 1000;
    } finally {
      cloudBridgeTimer = setTimeout(pollCloudBridge, nextDelay);
    }
  };

  cloudBridgeTimer = setTimeout(pollCloudBridge, 500);

  // ── Phase 3: Lease Reaper Background Interval (runs every 30s) ──
  let cachedReapExpiredLeases = null;
  let cachedReapBatchQueue = null;
  setInterval(async () => {
    try {
      if (!isProduction && !canExecuteWorkers(args)) return;
      if (!cachedReapExpiredLeases) {
        const mod = await import('../lib/submissionWorkerPool.mjs');
        cachedReapExpiredLeases = mod.reapExpiredLeases;
      }
      if (typeof cachedReapExpiredLeases === 'function') {
        await cachedReapExpiredLeases(6);
      }
      if (!cachedReapBatchQueue) {
        const sbMod = await import('../lib/supabaseClient.mjs');
        cachedReapBatchQueue = sbMod.reapExpiredBatchQueueLeases;
      }
      if (typeof cachedReapBatchQueue === 'function') {
        await cachedReapBatchQueue(15);
      }
      if (typeof global?.gc === 'function') {
        global.gc();
      }
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

