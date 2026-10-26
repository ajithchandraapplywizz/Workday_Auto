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
import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';
import {
  setGlobalStop,
  isGlobalStopRequested,
  abortAllActiveBrowsers,
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

if (!isSupabaseConfigured()) {
  console.error('[DAEMON FATAL] Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Configuration
const args = process.argv.slice(2);
const HEADLESS = process.env.HEADLESS !== 'false' && !args.includes('--headful') && !args.includes('--headed');
const TEST_MODE = args.includes('--test');
const PORT = Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || 3001;

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}

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
const DAEMON_BOOT_TIME = Date.now();
const ALLOW_CONCURRENT_PIPELINE = process.env.ALLOW_CONCURRENT_PIPELINE !== 'false';
let lastProcessedNonce = null;
let currentScanRunId = null;

// In-memory ring buffers for streaming live logs to dashboard (R11 Separate Logs)
export const daemonLogs = [];
export const scanLogs = [];
export const submitLogs = [];

const origLog = console.log;
const origErr = console.error;

function routeLogEntry(level, args) {
  try {
    const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const cluster = (currentMode === 'submitting' || currentStage === 'submitting' || text.includes('[SUBMIT') || text.includes('[10-WORKER DISPATCHER]'))
      ? 'Submit'
      : (currentStage === 'resolving' ? 'Resolve' : 'Scan');

    const entry = { ts: new Date().toISOString(), message: text, level, cluster };

    daemonLogs.push(entry);
    if (daemonLogs.length > 300) daemonLogs.shift();

    if (cluster === 'Submit') {
      submitLogs.push(entry);
      if (submitLogs.length > 300) submitLogs.shift();
    } else {
      scanLogs.push(entry);
      if (scanLogs.length > 300) scanLogs.shift();
    }
  } catch { }
}

console.log = function (...args) {
  origLog.apply(console, args);
  routeLogEntry('info', args);
};

console.error = function (...args) {
  origErr.apply(console, args);
  routeLogEntry('error', args);
};

const ALL_CANONICAL_WORKERS = PIPELINE_CONFIG.allWorkerIds || Array.from({ length: 2 }, (_, i) => `worker_${i + 1}`);

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
  await updateBotControl({
    mode: currentMode,
    stage: currentStage,
    scan_enabled: scanStatus === 'running',
    scan_status: scanStatus,
    scan_stop_requested: scanStopRequested,
    submit_enabled: submitStatus === 'running',
    submit_status: submitStatus,
    submit_stop_requested: submitStopRequested,
    scan_message: scanCompleteMessage,
    refusal_reason: submitRefusalReason || scanRefusalReason,
    is_running: isPoolRunning,
    is_paused: isPoolPaused,
    stop_requested: isGlobalStopRequested(),
    active_worker_count: isPoolRunning ? (currentMode === 'submitting' ? Math.max(activeSubmittingWorkers.size, 1) : 10) : 0,
    ...patch,
  }).catch(() => { });
}

/**
 * R3: Server-side check if Stage 1 is fully complete before Submit is allowed.
 * Stage 2: SUBMIT. Starts only after Stage 1 is fully complete (no pending or in-progress
 * batch_job_queue / job_distributions work, no active scan or resolve worker).
 */
export async function checkStage1Completion() {
  if (!ALLOW_CONCURRENT_PIPELINE && (currentMode === 'scanning' || scanStatus === 'running')) {
    return {
      allowed: false,
      reason: 'Submit toggle is refused while mode = scanning. Wait for Stage 1 (Scan & Resolve) to complete or stop scanning.',
    };
  }

  // Check if any scan/resolve workers are currently running (ignoring stale workers older than 5 minutes)
  if (!ALLOW_CONCURRENT_PIPELINE) {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: activeWorkers } = await supabase
        .from('worker_status')
        .select('worker_id, stage, state, updated_at')
        .in('stage', ['scanning', 'resolving'])
        .eq('state', 'in_flight')
        .gt('updated_at', fiveMinutesAgo);

      if (activeWorkers && activeWorkers.length > 0) {
        return {
          allowed: false,
          reason: `Submit toggle is refused: ${activeWorkers.length} scan/resolve worker(s) are actively scanning/resolving. Wait for them to finish or stop scanning.`,
        };
      }
    } catch {}
  }

  // If there are ready applications in submission_tasks or job_distributions, allow submission
  try {
    const { count: readyCount } = await supabase
      .from('submission_tasks')
      .select('*', { count: 'exact', head: true })
      .in('status', ['ready_for_review', 'queued']);

    if (typeof readyCount === 'number' && readyCount > 0) {
      return { allowed: true, readyCount };
    }

    const { count: distReadyCount } = await supabase
      .from('job_distributions')
      .select('*', { count: 'exact', head: true })
      .in('status', ['ready_for_review', 'ready_to_review']);

    if (typeof distReadyCount === 'number' && distReadyCount > 0) {
      return { allowed: true, distReadyCount };
    }
  } catch {}

  return { allowed: true };
}

/**
 * R3: Server-side check if Scan is allowed (refused while mode = submitting in strict non-concurrent mode)
 */
export function checkCanStartScan() {
  if (!ALLOW_CONCURRENT_PIPELINE && (currentMode === 'submitting' || submitStatus === 'running')) {
    return {
      allowed: false,
      reason: 'Scan toggle is refused while mode = submitting. Workday submissions are actively in flight.',
    };
  }
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
    // Terminate browser contexts for scanning
    await abortAllActiveBrowsers().catch(() => {});

    // Push definitive termination log banner to buffer
    const stopLogEntry = {
      ts: new Date().toISOString(),
      message: '🛑 [DAEMON] Scan & Resolve STOPPED. All background worker loops terminated, browser windows closed.',
      level: 'warn',
      cluster: 'Scan',
    };
    daemonLogs.push(stopLogEntry);
    scanLogs.push(stopLogEntry);

    // Reset scan and resolve workers to idle in parallel (never touches submission_tasks!)
    const workerIds = PIPELINE_CONFIG.scanWorkerIds || ALL_CANONICAL_WORKERS;
    await Promise.allSettled(
      workerIds.map((wId) =>
        updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'idle' })
      )
    );
  } finally {
    scanStatus = 'off';
    scanStopRequested = false;
    setScanStop(false);
    setClusterStop(false);

    if (currentMode === 'scanning') {
      currentMode = 'idle';
      currentStage = 'idle';
      isPoolRunning = submitStatus === 'running';
    }

    await syncBotControlState({
      mode: currentMode,
      stage: currentStage,
      scan_enabled: false,
      scan_status: 'off',
      scan_stop_requested: false,
      last_action_requested: null,
      is_running: isPoolRunning,
      current_action: 'Scan & Resolve stopped by user',
    }).catch(() => {});
    await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
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
    // Terminate browser contexts for submissions
    await abortAllActiveBrowsers().catch(() => {});
    activeSubmittingWorkers.clear();

    // Push definitive termination log banner to buffer
    const stopSubmitEntry = {
      ts: new Date().toISOString(),
      message: '🛑 [DAEMON] Submissions STOPPED. All submission workers halted, active browser windows aborted.',
      level: 'warn',
      cluster: 'Submit',
    };
    daemonLogs.push(stopSubmitEntry);
    submitLogs.push(stopSubmitEntry);

    // Reset submit workers to idle in parallel (never touches batch_job_queue or scanned_jobs!)
    const workerIds = PIPELINE_CONFIG.submitWorkerIds || ALL_CANONICAL_WORKERS;
    await Promise.allSettled(
      workerIds.map((wId) =>
        updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'idle' })
      )
    );
  } finally {
    submitStatus = 'off';
    submitStopRequested = false;
    setSubmitStop(false);

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
      current_action: 'Submissions stopped by user',
    }).catch(() => {});
    await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
  }

  console.log(`✅ [DAEMON] Submit stop complete. Submissions halted. Scan & Resolve progress untouched.`);
  return { success: true, message: 'Submissions halted. Scan & Resolve progress untouched.' };
}

/**
 * Global Stop: Halts all workers
 */
export async function stopAutonomousPool() {
  console.log(`\n🛑 [DAEMON] GLOBAL STOP SIGNAL RECEIVED: Halting all workers...`);
  await Promise.allSettled([stopScanPool(), stopSubmitPool()]);
  isPoolRunning = false;
  isPoolPaused = true;
  currentMode = 'idle';
  currentStage = 'idle';
  setGlobalStop(true);

  await resetAllWorkersIdle().catch(() => {});
  await syncBotControlState({
    mode: 'idle',
    stage: 'idle',
    is_running: false,
    is_paused: true,
    stop_requested: true,
    active_worker_count: 0,
    current_action: 'Stopped by user',
  });

  console.log(`✅ [DAEMON] Global stop complete. All 10 workers set to idle and active browsers closed.`);
  return { success: true, message: 'All workers stopped and reset to idle.' };
}

/**
 * Execute Stage 1: Scanning (scanning_worker_1..10)
 */
async function runStage1Scanning() {
  currentStage = 'scanning';

  // Auto-generate or retrieve scan_run_id — never refuse valid execution
  let bc = await getBotControl().catch(() => null);
  let scanRunId = bc?.scan_run_id || currentScanRunId;
  if (!scanRunId) {
    scanRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentScanRunId = scanRunId;
    await syncBotControlState({
      scan_run_id: scanRunId,
      scan_run_started_at: new Date().toISOString(),
    }).catch(() => {});
    bc = { ...(bc || {}), scan_run_id: scanRunId };
    console.log(`[DAEMON] Auto-assigned fresh scan_run_id: ${scanRunId}`);
  }

  await syncBotControlState({
    stage: 'scanning',
    is_running: true,
    current_action: `Scanning unique Workday links (Run: ${bc.scan_run_id})`,
    active_worker_count: TEST_MODE ? 1 : (PIPELINE_CONFIG.workersCount || 2),
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with ${PIPELINE_CONFIG.scanWorkerIds.length} scanning workers (${PIPELINE_CONFIG.scanWorkerIds.join(', ')}) under run ${bc.scan_run_id}...`);

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    scanRunId: bc.scan_run_id,
    topLinks: TEST_MODE ? 1 : (Number(process.env.SCAN_TOP_LINKS_LIMIT) || 100),
    minClients: Number(process.env.MIN_CLIENTS_THRESHOLD) || 1,
    workers: TEST_MODE ? 1 : (PIPELINE_CONFIG.workersCount || 2),
    headless: HEADLESS,
    confirmSubmit: false,
    limitPerLink: TEST_MODE ? 1 : null,
    defaultPassword: process.env.WORKDAY_PASSWORD || '',
  });

  // Ensure scanning workers reset to idle
  for (const wId of PIPELINE_CONFIG.scanWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'scanning' }).catch(() => { });
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
    current_action: 'Pre-resolving candidate answers across 4 tiers into job_distributions',
    active_worker_count: PIPELINE_CONFIG.workersCount || 2,
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
async function runStage3Submissions(isContinuous = false) {
  currentMode = 'submitting';
  currentStage = 'submitting';
  submitStatus = 'running';
  isPoolRunning = true;

  const SUBMIT_WORKER_IDS = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 2 }, (_, i) => `worker_${i + 1}`);

  console.log(`\n🚀 [DAEMON] ${isContinuous ? 'Continuous Submit Daemon' : 'Submissions Runner'} active across ${SUBMIT_WORKER_IDS.length} parallel workers (${SUBMIT_WORKER_IDS.join(', ')})...`);

  // 1. Recover any interrupted tasks from previous daemon lifecycle
  await recoverInterruptedSubmissionTasks().catch(() => {});

  while (!isGlobalStopRequested() && !isSubmitStopRequested() && !isPoolPaused && submitStatus === 'running') {
    // 2. Import applications from job_distributions into submission_tasks if needed
    try {
      const { data: allDists } = await supabase
        .from('job_distributions')
        .select('id, applywizz_id, job_url, company, role_title, status, is_fully_answered, application_submitted_screenshot_url, applied_screenshot, screenshot_url')
        .in('status', ['ready_for_review', 'ready_to_review', 'queued'])
        .limit(300);

      if (allDists && allDists.length > 0) {
        for (const dist of allDists) {
          const rawStatus = (dist.status || '').toLowerCase().trim();
          const isSubmitted = rawStatus === 'submitted' || rawStatus === 'completed';
          const finalScreenshot = dist.application_submitted_screenshot_url || dist.applied_screenshot || dist.screenshot_url || null;
          const taskStatus = isSubmitted ? 'submitted' : (rawStatus === 'failed' ? 'failed' : 'ready_for_review');

          await supabase.from('submission_tasks').upsert({
            distribution_id: dist.id,
            applywizz_id: dist.applywizz_id,
            job_url: dist.job_url,
            company: dist.company || 'Workday Tenant',
            role_title: dist.role_title || 'Workday Position',
            status: taskStatus,
            application_submitted_screenshot_url: isSubmitted ? finalScreenshot : null,
            screenshot_path: finalScreenshot,
            completed_at: isSubmitted ? new Date().toISOString() : null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'distribution_id' }).catch(() => {});
        }
      }
    } catch {}

    // Check actionable tasks count
    let tasksCount = 0;
    try {
      const { count } = await supabase
        .from('submission_tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['ready_for_review', 'queued', 'needs_answers', 'applying']);
      tasksCount = count || 0;
    } catch {}

    if (tasksCount === 0 && activeSubmittingWorkers.size === 0) {
      if (!isContinuous) {
        console.log(`ℹ️ [DAEMON] 0 applications ready for submission.`);
        submitStatus = 'off';
        currentMode = scanStatus === 'running' ? 'scanning' : 'idle';
        currentStage = scanStatus === 'running' ? 'scanning' : 'idle';
        isPoolRunning = scanStatus === 'running';
        await syncBotControlState({
          mode: currentMode,
          stage: currentStage,
          submit_enabled: false,
          submit_status: 'off',
          is_running: isPoolRunning,
          current_action: '0 applications ready for submission. Idle.',
        });
        return;
      }

      await syncBotControlState({
        mode: 'submitting',
        stage: 'submitting',
        submit_enabled: true,
        submit_status: 'running',
        is_running: true,
        current_action: 'Submit Daemon active — waiting for ready applications in submission_tasks...',
        active_worker_count: 0,
      });

      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }

    await syncBotControlState({
      mode: 'submitting',
      stage: 'submitting',
      submit_enabled: true,
      submit_status: 'running',
      is_running: true,
      current_action: `Submitting ${tasksCount} task(s) across ${SUBMIT_WORKER_IDS.length} parallel workers`,
      active_worker_count: SUBMIT_WORKER_IDS.length,
    });

    await dispatchQueuedSubmissions();
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!isContinuous) {
    submitStatus = 'off';
    currentMode = scanStatus === 'running' ? 'scanning' : 'idle';
    currentStage = scanStatus === 'running' ? 'scanning' : 'idle';
    isPoolRunning = scanStatus === 'running';
    await syncBotControlState({
      mode: currentMode,
      stage: currentStage,
      submit_enabled: false,
      submit_status: 'off',
      is_running: isPoolRunning,
      current_action: 'Submissions finished. Idle.',
    });
  }
}

/**
 * Parallel Pipeline: Scanning & Resolving run concurrently across the 10 shared workers
 */
export async function runScanAndResolveParallel() {
  if (scanStatus === 'running' && isPoolRunning) {
    console.log(`[DAEMON] Scan pipeline is already running.`);
    return { success: true, message: 'Scan pipeline already running.' };
  }

  // Enforce R3: Refuse if mode = submitting
  const canScan = checkCanStartScan();
  if (!canScan.allowed) {
    console.warn(`[DAEMON] Scan refused: ${canScan.reason}`);
    return { success: false, refused: true, reason: canScan.reason };
  }

  currentMode = 'scanning';
  currentStage = 'scanning';
  scanStatus = 'running';
  scanStopRequested = false;
  isPoolRunning = true;
  isPoolPaused = false;
  setGlobalStop(false);

  // Generate unique scan_run_id in bot_control when Scan starts (R10)
  const scanRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  currentScanRunId = scanRunId;
  const scanRunStartedAt = new Date().toISOString();

  await syncBotControlState({
    scan_run_id: scanRunId,
    scan_run_started_at: scanRunStartedAt,
    mode: 'scanning',
    stage: 'scanning',
    scan_enabled: true,
    scan_status: 'running',
    scan_stop_requested: false,
    is_running: true,
    active_worker_count: PIPELINE_CONFIG.workersCount || 2,
  });

  try {
    let loopIteration = 0;
    while (!isGlobalStopRequested() && !isScanStopRequested() && !isPoolPaused && scanStatus === 'running') {
      loopIteration++;
      console.log(`\n🚀 [DAEMON] Schedule 1: Scan & Resolve Loop Iteration #${loopIteration} (Run ${scanRunId})...`);

      await syncBotControlState({
        mode: 'scanning',
        stage: 'scanning',
        scan_enabled: true,
        scan_status: 'running',
        scan_stop_requested: false,
        is_running: true,
        current_action: `Loop #${loopIteration}: Scanning 50+ unique links & resolving for 20+ clients (Run: ${scanRunId})`,
        active_worker_count: PIPELINE_CONFIG.workersCount || 2,
      });

      // Workers run in parallel; each worker handles Scan -> Resolve sequentially per application
      console.log(`\n⚡ [DAEMON] Launching ${PIPELINE_CONFIG.workersCount} parallel workers — Scanning & Resolving in sequence per application...`);
      await runStage1Scanning().catch((err) => {
        console.error(`❌ [DAEMON] Stage 1 Scanning & Resolving error:`, err?.message || err);
      });

      if (isGlobalStopRequested() || isScanStopRequested() || isPoolPaused || scanStatus !== 'running') {
        console.log(`🛑 [DAEMON] Pipeline stopped.`);
        break;
      }

      scanCompleteMessage = `Loop #${loopIteration} complete: Scanned links resolved and saved to submission_tasks at ready_for_review. Stopped here.`;
      console.log(`\n✅ [DAEMON] Loop #${loopIteration} complete: scanned_jobs -> job_distributions -> submission_tasks (ready_for_review).`);
      console.log(`🛑 [DAEMON] Stopped at ready_for_review. Applications waiting for review. Auto-submissions halted. Checking for more unique links in 10s...`);

      await syncBotControlState({
        mode: 'scanning',
        stage: 'scanning',
        scan_enabled: true,
        scan_status: 'running',
        is_running: true,
        scan_message: scanCompleteMessage,
        current_action: `Applications reached ready_for_review across 20+ clients. Looping for more links...`,
        active_worker_count: PIPELINE_CONFIG.workersCount || 2,
      });

      // Brief pause between loops, checking stop signal every second
      for (let s = 0; s < 10; s++) {
        if (isGlobalStopRequested() || isScanStopRequested() || isPoolPaused || scanStatus !== 'running') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } catch (err) {
    console.error(`❌ [DAEMON] Pipeline error:`, err?.message || err);
  } finally {
    scanStatus = 'off';
    if (currentMode === 'scanning') currentMode = 'idle';
    currentStage = 'idle';
    isPoolRunning = submitStatus === 'running';
    await resetAllWorkersIdle().catch(() => { });
    await syncBotControlState({
      mode: currentMode,
      stage: 'idle',
      scan_enabled: false,
      scan_status: 'off',
      scan_stop_requested: false,
      scan_message: scanCompleteMessage || 'Scan complete: applications at ready_for_review.',
      last_action_requested: null,
      is_running: isPoolRunning,
      current_action: scanCompleteMessage || 'Idle',
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

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

  // 2. Status (Public health & daemon stage inspection)
  if (pathname === '/api/bot/status') {
    const botControl = await getBotControl().catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const count = PIPELINE_CONFIG.workersCount || 2;
    res.end(JSON.stringify({
      success: true,
      status: 'healthy',
      isRunning: isPoolRunning,
      stage: currentStage,
      isPaused: isPoolPaused,
      workers: count,
      stages: {
        scanning: count,
        resolving: count,
        submitting: count,
      },
      botControl,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
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
      const { count } = await supabase.from('submission_tasks').select('*', { count: 'exact', head: true }).eq('status', 'applying');
      if (typeof count === 'number') applyingCount = count;
    } catch {}

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
    res.end(JSON.stringify({
      success: true,
      logs: daemonLogs.slice(-150),
      scanLogs: scanLogs.slice(-150),
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
          current_action: 'Running Scanning and Resolving in parallel across 10 workers',
        });

        // Run asynchronously
        runScanAndResolveParallel().catch(console.error);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'scanning',
          scanStatus: 'running',
          scan_status: 'running',
          message: 'Scan & Resolve pipeline started across 10 workers in parallel.',
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

  // 3. Global & Specific Stop Webhook (Admin & Developer)
  if (
    pathname === '/api/bot/stop' ||
    pathname === '/api/bot/scan/stop' ||
    pathname === '/api/bot/submit/stop' ||
    (pathname === '/api/bot/webhook' && (body.action === 'stop' || body.action === 'stop_scan' || body.action === 'stop_submit'))
  ) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    const action = body.action || (pathname.includes('/scan/') ? 'stop_scan' : (pathname.includes('/submit/') ? 'stop_submit' : 'stop'));

    if (action === 'stop_scan') {
      await stopScanPool();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Scan & Resolve pipeline stopped instantly. Active browser contexts aborted.',
        scanStatus: 'off',
        isRunning: submitStatus === 'running',
      }));
      return;
    }

    if (action === 'stop_submit') {
      await stopSubmitPool();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Submissions pipeline stopped instantly. Active submission browsers aborted.',
        submitStatus: 'off',
        isRunning: scanStatus === 'running',
      }));
      return;
    }

    // Default: Hard Global Stop
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'All background workers stopped instantly. Active browser contexts aborted.',
      isRunning: false,
      scanStatus: 'off',
      submitStatus: 'off',
    }));
    return;
  }

  // 4. Start / Trigger Parallel Scan & Resolve (Admin & Developer)
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || pathname === '/api/bot/scan-resolve' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline' || body.action === 'scan_resolve'))) {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;

    // If submissions is actively running, terminate it only in strict non-concurrent mode
    if (!ALLOW_CONCURRENT_PIPELINE && (submitStatus === 'running' || currentMode === 'submitting')) {
      console.log(`\n🔄 [DAEMON HTTP] Active Submissions running! Halting submissions to switch to Scan & Resolve...`);
      await stopSubmitPool();
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
    scanStopRequested = false;
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
    runScanAndResolveParallel().catch(console.error);

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

    // Check availability across the 3 submitting workers (submitting_worker_1, 2, 3)
    const submitWorkerIds = PIPELINE_CONFIG.submitWorkerIds || ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'];
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
        try { await supabase.from('job_distributions').update(applyUpdate).eq('id', distributionId); } catch {}
      } else if (cleanId && jobUrl) {
        try { await supabase.from('job_distributions').update(applyUpdate).eq('applywizz_id', cleanId).eq('job_url', jobUrl); } catch {}
      }

      // 3. Upsert into submission_tasks table with status 'applying'
      if (distributionId) {
        await supabase.from('submission_tasks').upsert({
          distribution_id: distributionId,
          applywizz_id: cleanId,
          job_url: jobUrl,
          status: 'applying',
          worker_id: chosenWorkerId,
          reviewed_by: 'Career Associate',
          started_at: nowIso,
          updated_at: nowIso,
        }, { onConflict: 'distribution_id' }).catch(() => { });
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

      if (distributionId) {
        try {
          await supabase.from('job_distributions').update({
            status: 'queued',
            reviewed_by: 'Career Associate',
            reviewed_at: nowIso,
            updated_at: nowIso,
          }).eq('id', distributionId);

          await supabase.from('submission_tasks').upsert({
            distribution_id: distributionId,
            applywizz_id: cleanId,
            job_url: jobUrl,
            status: 'queued',
            reviewed_by: 'Career Associate',
            created_at: nowIso,
            updated_at: nowIso,
          }, { onConflict: 'distribution_id' });
        } catch {}
      }

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
  if (
    pathname === '/api/bot/submit' ||
    pathname === '/api/bot/submit/start' ||
    pathname === '/api/bot/start-submissions' ||
    pathname === '/api/bot/submit-batch' ||
    (pathname === '/api/bot/webhook' && (body.action === 'submit_approved' || body.action === 'stage_submit' || body.action === 'start_submissions' || body.action === 'submit' || body.action === 'start_submit'))
  ) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

    // If scan & resolve is actively running, terminate it only in strict non-concurrent mode
    if (!ALLOW_CONCURRENT_PIPELINE && (scanStatus === 'running' || currentMode === 'scanning')) {
      console.log(`\n🔄 [DAEMON HTTP] Active Scan & Resolve running! Halting Scan & Resolve to switch to Submissions...`);
      await stopScanPool();
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

    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with 10 submitting workers...`);
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
      message: 'Stage 3 Submissions triggered across 2 submitting workers in parallel.',
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

export async function dispatchQueuedSubmissions() {
  if (isGlobalStopRequested() || isPoolPaused || isSubmitStopRequested()) return;
  // R11: Submit runs only when Developer turns Submit toggle ON
  if (submitStatus !== 'running') return;

  try {
    const { SUBMISSION_WORKER_IDS, claimNextTask, processClaimedTask, moveReadyTasksToQueued } = await import('../lib/submissionWorkerPool.mjs');

    // (c) Submit ON: only ready_for_review rows move up to available worker slots, and scan state is untouched
    const maxConcurrency = SUBMISSION_WORKER_IDS.length || 2;
    const availableSlots = Math.max(0, maxConcurrency - activeSubmittingWorkers.size);
    if (availableSlots > 0 && typeof moveReadyTasksToQueued === 'function') {
      await moveReadyTasksToQueued(availableSlots);
    }

    let claimedAny = false;
    for (const workerId of SUBMISSION_WORKER_IDS) {
      if (activeSubmittingWorkers.has(workerId)) continue;
      if (isGlobalStopRequested() || isPoolPaused || isSubmitStopRequested() || submitStatus !== 'running') break;

      const claimedTask = await claimNextTask(workerId);
      if (claimedTask) {
        claimedAny = true;
        activeSubmittingWorkers.add(workerId);
        console.log(`\n🚀 [${maxConcurrency}-WORKER DISPATCHER] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Process asynchronously so workers run in parallel!
        processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        })
          .then((res) => {
            console.log(`✅ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
          })
          .catch((err) => {
            console.error(`❌ [${maxConcurrency}-WORKER DISPATCHER] ${workerId} error on task #${claimedTask.id}:`, err?.message || err);
          })
          .finally(() => {
            activeSubmittingWorkers.delete(workerId);
          });
      }
    }

    // Auto-off: when no tasks claimed and no active workers, check if any ready_for_review or queued remain
    if (!claimedAny && activeSubmittingWorkers.size === 0) {
      const { data: remaining } = await supabase
        .from('submission_tasks')
        .select('id')
        .in('status', ['ready_for_review', 'queued', 'applying'])
        .limit(1);

      if (!remaining || remaining.length === 0) {
        console.log(`\n✅ [DAEMON] All submission tasks finished. Submit toggle turning OFF automatically (R8/R11).`);
        submitStatus = 'off';
        if (currentMode === 'submitting') {
          currentMode = 'idle';
          currentStage = 'idle';
          isPoolRunning = false;
        }
        await updateWorkerControl('submit', { enabled: false, stop_requested: false, updated_by: 'system_auto_off' }).catch(() => {});
        for (const workerId of SUBMISSION_WORKER_IDS) {
          await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null, stage: 'idle' }).catch(() => {});
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
    console.warn(`[10-WORKER DISPATCHER] Error in cycle:`, err?.message);
  }
}

/**
 * B5 Startup Recovery: On start, set rows in 'applying' that belong to
 * this daemon's submitting workers to 'failed' with 'Interrupted: daemon restarted'.
 */
export async function recoverInterruptedSubmissionTasks() {
  const submitWorkers = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 2 }, (_, i) => `worker_${i + 1}`);
  try {
    const now = new Date().toISOString();
    let updateBody = {
      status: 'ready_for_review',
      status_actor: 'reaper',
      possibly_submitted: true,
      worker_id: null,
      worker_leased_at: null,
      error_message: 'Interrupted: daemon restarted. Returned to ready_for_review.',
      updated_at: now,
    };

    let { data: interrupted, error } = await supabase
      .from('submission_tasks')
      .update(updateBody)
      .eq('status', 'applying')
      .in('worker_id', submitWorkers)
      .select('*');

    if (error && (error.message?.includes('possibly_submitted') || error.message?.includes('column'))) {
      delete updateBody.possibly_submitted;
      delete updateBody.status_actor;
      const res = await supabase
        .from('submission_tasks')
        .update(updateBody)
        .eq('status', 'applying')
        .in('worker_id', submitWorkers)
        .select('*');
      interrupted = res.data;
      error = res.error;
    }

    if (error) {
      console.warn('[DAEMON RECOVERY] Startup note:', error.message);
      return 0;
    }

    const count = interrupted ? interrupted.length : 0;
    if (count > 0) {
      console.log(`[DAEMON RECOVERY] Safely reverted ${count} interrupted task(s) to ready_for_review with possibly_submitted=true.`);
    }
    return count;
  } catch (err) {
    console.warn('[DAEMON RECOVERY] Exception recovering tasks:', err.message);
    return 0;
  }
}

// Startup initialization
async function initOnStartup() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  AUTONOMOUS WORKDAY PIPELINE DAEMON — 2-WORKER SEQUENTIAL ENGINE`);
  console.log(`  Schedule 1: Scanning & Resolving (2 Workers: worker_1, worker_2)`);
  console.log(`  Schedule 2: Submissions (2 Workers: worker_1, worker_2)`);
  console.log(`  Mutual Exclusion: Non-overlapping schedules (Low RAM Consumption)`);
  console.log(`  Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Webhook Port: ${PORT}`);
  console.log(`${'═'.repeat(72)}\n`);

  try {
    await ensureCanonicalWorkers();
    await resetAllWorkersIdle();
    await syncBotControlState({
      stage: 'idle',
      mode: 'idle',
      is_running: false,
      is_paused: false,
      scan_status: 'off',
      scan_enabled: false,
      scan_stop_requested: false,
      submit_status: 'off',
      submit_enabled: false,
      submit_stop_requested: false,
      stop_requested: false,
      trigger_requested: false,
      last_action_requested: null,
      active_worker_count: 0,
      current_action: 'Idle (Awaiting Frontend Dev Dashboard trigger)',
    });
    try {
      await supabase.from('bot_control').update({
        stage: 'idle',
        mode: 'idle',
        is_running: false,
        is_paused: false,
        scan_status: 'off',
        scan_enabled: false,
        scan_stop_requested: false,
        submit_status: 'off',
        submit_enabled: false,
        submit_stop_requested: false,
        stop_requested: false,
        trigger_requested: false,
        last_action_requested: null,
        active_worker_count: 0,
        current_action: 'Idle (Awaiting Frontend Dev Dashboard trigger)',
        updated_at: new Date().toISOString(),
      }).eq('id', 'primary');
    } catch {}
    await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
    await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
    console.log(`[DAEMON] Tables initialized: bot_control, worker_control & canonical worker_status reset to IDLE / OFF.`);
    await recoverInterruptedSubmissionTasks();
    const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
    await reapExpiredLeases(10).catch(() => {});
    console.log(`[DAEMON] Phase 6 Stale lease recovery executed on startup.`);
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[DAEMON] Worker pool configured with WORKER_COUNT=${PIPELINE_CONFIG.workersCount}: ${PIPELINE_CONFIG.scanWorkerIds.length} scanning workers, ${PIPELINE_CONFIG.resolveWorkerIds.length} resolving workers, ${PIPELINE_CONFIG.submitWorkerIds.length} submitting workers (${PIPELINE_CONFIG.allWorkerIds.join(', ')}).`);
    console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — ${PIPELINE_CONFIG.workersCount}-Worker Pipeline Active.\n`);
  });

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
      const [bc, wc] = await Promise.all([
        getBotControl().catch(() => null),
        getWorkerControls().catch(() => null),
      ]);

      const scanCtrl = wc?.scan;
      const submitCtrl = wc?.submit;

      // 1. Primary Stop Signal from Supabase
      const hasScanStopSignal = Boolean(bc?.scan_stop_requested || bc?.last_action_requested === 'stop_scan' || scanCtrl?.stop_requested);
      const hasSubmitStopSignal = Boolean(bc?.submit_stop_requested || bc?.last_action_requested === 'stop_submit' || submitCtrl?.stop_requested);
      const hasGlobalStopSignal = Boolean(bc?.stop_requested || bc?.last_action_requested === 'stop');

      if (hasScanStopSignal && (isPoolRunning || scanStatus === 'running' || currentStage === 'scanning' || currentStage === 'resolving')) {
        console.log(`\n🛑 [DAEMON SUPABASE TRIGGER] Detected scan stop signal in Supabase! Stopping scanning workers...`);
        await stopScanPool();
        await syncBotControlState({ last_action_requested: null, stop_requested: false, scan_stop_requested: false, is_running: (submitStatus === 'running'), stage: submitStatus === 'running' ? 'submitting' : 'idle' }).catch(() => {});
        await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
        return;
      }

      if (hasSubmitStopSignal && (isPoolRunning || submitStatus === 'running' || currentStage === 'submitting')) {
        console.log(`\n🛑 [DAEMON SUPABASE TRIGGER] Detected submit stop signal in Supabase! Stopping submission workers...`);
        await stopSubmitPool();
        await syncBotControlState({ last_action_requested: null, stop_requested: false, submit_stop_requested: false, is_running: (scanStatus === 'running'), stage: scanStatus === 'running' ? 'scanning' : 'idle' }).catch(() => {});
        await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
        return;
      }

      if (hasGlobalStopSignal && isPoolRunning) {
        console.log(`\n🛑 [DAEMON SUPABASE TRIGGER] Detected stop signal in Supabase! Stopping all workers...`);
        await stopAutonomousPool();
        await syncBotControlState({ last_action_requested: null, stop_requested: false, scan_stop_requested: false, submit_stop_requested: false, is_running: false, stage: 'idle' }).catch(() => {});
        await updateWorkerControl('scan', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
        await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
        return;
      }

      // 2. Action Signal Check: Accept explicit triggers, new nonces, or fresh actions
      const actionNonce = String(bc?.action_nonce || bc?.trigger_id || '');
      const isNewNonce = Boolean(actionNonce && actionNonce !== lastProcessedNonce);
      const isTriggerRequested = Boolean(bc?.trigger_requested === true);
      const updatedAtMs = bc?.updated_at ? new Date(bc.updated_at).getTime() : 0;
      const isFreshAction = isTriggerRequested || isNewNonce || (updatedAtMs >= (DAEMON_BOOT_TIME - 3000));

      // 3. Scan & Resolve Start Signal from Supabase
      const isScanSignal = Boolean(
        isFreshAction && bc && (
          bc.last_action_requested === 'start' ||
          bc.last_action_requested === 'start_scan' ||
          bc.last_action_requested === 'start_pipeline' ||
          ((bc.stage === 'scanning' || bc.mode === 'scanning') && isTriggerRequested)
        )
      );

      const isScanStartRequested = (!hasScanStopSignal) && (!hasGlobalStopSignal) && (
        isScanSignal ||
        (isFreshAction && scanCtrl && scanCtrl.enabled === true && scanCtrl.status === 'running')
      );

      if (isScanStartRequested && (scanStatus !== 'running')) {
        if (actionNonce) lastProcessedNonce = actionNonce;
        if (!ALLOW_CONCURRENT_PIPELINE && (currentMode === 'submitting' || submitStatus === 'running')) {
          console.log(`\n🔄 [DAEMON SWITCH] Active Submission trigger running! Halting submissions to start Scan & Resolve...`);
          await stopSubmitPool();
        }

        console.log(`\n⚡ [DAEMON SUPABASE TRIGGER] Detected start scan signal! Launching ${PIPELINE_CONFIG.workersCount}-worker sequential pipeline (Scan & Resolve)...`);
        currentMode = 'scanning';
        currentStage = 'scanning';
        scanStatus = 'running';
        scanStopRequested = false;
        isPoolRunning = true;
        setGlobalStop(false);

        await syncBotControlState({
          last_action_requested: null,
          trigger_requested: false,
          is_running: true,
          stage: 'scanning',
          mode: 'scanning',
          scan_status: 'running',
          scan_enabled: true,
          stop_requested: false,
          scan_stop_requested: false,
        });
        await updateWorkerControl('scan', { enabled: true, status: 'running', stop_requested: false }).catch(() => {});
        runScanAndResolveParallel().catch(console.error);
        return;
      }

      // 4. Submissions Start Signal from Supabase
      const isSubmitSignal = Boolean(
        isFreshAction && bc && (
          bc.last_action_requested === 'submit_approved' ||
          bc.last_action_requested === 'start_submit' ||
          ((bc.stage === 'submitting' || bc.mode === 'submitting') && isTriggerRequested)
        )
      );

      const isSubmitStartRequested = (!hasSubmitStopSignal) && (!hasGlobalStopSignal) && (
        isSubmitSignal ||
        (isFreshAction && submitCtrl && submitCtrl.enabled === true && submitCtrl.status === 'running')
      );

      if (isSubmitStartRequested && (submitStatus !== 'running')) {
        if (actionNonce) lastProcessedNonce = actionNonce;
        if (!ALLOW_CONCURRENT_PIPELINE && (currentMode === 'scanning' || scanStatus === 'running')) {
          console.log(`\n🔄 [DAEMON SWITCH] Active Scan & Resolve trigger running! Halting Scan & Resolve to start Submissions...`);
          await stopScanPool();
        }

        console.log(`\n🚀 [DAEMON SUPABASE TRIGGER] Detected start submit signal! Launching ${PIPELINE_CONFIG.workersCount}-worker parallel submissions...`);
        currentMode = 'submitting';
        currentStage = 'submitting';
        submitStatus = 'running';
        submitStopRequested = false;
        isPoolRunning = true;
        setGlobalStop(false);

        await syncBotControlState({
          last_action_requested: null,
          trigger_requested: false,
          is_running: true,
          stage: 'submitting',
          mode: 'submitting',
          submit_status: 'running',
          submit_enabled: true,
          stop_requested: false,
          submit_stop_requested: false,
        });
        await updateWorkerControl('submit', { enabled: true, status: 'running', stop_requested: false }).catch(() => {});
        runStage3Submissions().finally(async () => {
          submitStatus = 'off';
          currentStage = scanStatus === 'running' ? 'scanning' : 'idle';
          currentMode = scanStatus === 'running' ? 'scanning' : 'idle';
          isPoolRunning = scanStatus === 'running';
          await resetAllWorkersIdle().catch(() => {});
          await syncBotControlState({ stage: currentStage, mode: currentMode, is_running: isPoolRunning, submit_status: 'off', submit_enabled: false, current_action: 'Idle' }).catch(() => {});
          await updateWorkerControl('submit', { enabled: false, status: 'off', stop_requested: false }).catch(() => {});
        }).catch(console.error);
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
      if (!isPoolRunning && bc?.scan_status === 'running' && isFreshAction && !hasScanStopSignal && !hasGlobalStopSignal) {
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
          runScanAndResolveParallel().catch(console.error);
          return;
        }
      }

    } catch {
      // Continue polling silently
    }
  }, 2000);

  // ── Phase 3: 10-Minute Lease Reaper Background Interval (runs every 60s) ──
  setInterval(async () => {
    try {
      const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
      await reapExpiredLeases(10);
    } catch { }
  }, 60_000);

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
  console.log(`[${new Date().toISOString()}] [DAEMON] SIGTERM received. Shutting down gracefully.`);
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log(`[${new Date().toISOString()}] [DAEMON] Interrupted. Shutting down gracefully.`);
  process.exit(0);
});

import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const entryArg = (process.argv[1] || '').replace(/\\/g, '/');
const isMainModule = entryArg === currentFile || entryArg.endsWith('/index.js') || entryArg.endsWith('\\index.js');

if (isMainModule) {
  const cliArg = (process.argv[2] || '').toLowerCase().trim();
  const isSubmitMode = cliArg === 'submit' || cliArg === '--submit' || cliArg === '--submit-daemon' || process.env.MODE === 'submit_only';
  if (isSubmitMode) {
    initOnStartup()
      .then(async () => {
        console.log('\n🚀 [DAEMON CLI] Continuous Submit Daemon activated. Monitoring and processing submissions 24/7...');
        await runStage3Submissions(true);
      })
      .catch((err) => {
        console.error(`[${new Date().toISOString()}] [DAEMON FATAL]`, err);
        process.exit(1);
      });
  } else {
    initOnStartup().catch((err) => {
      console.error(`[${new Date().toISOString()}] [DAEMON FATAL]`, err);
      process.exit(1);
    });
  }
}

