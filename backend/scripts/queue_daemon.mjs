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
} from '../lib/supabaseClient.mjs';
import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';
import { setGlobalStop, isGlobalStopRequested, abortAllActiveBrowsers } from '../lib/browserLifecycle.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('[DAEMON FATAL] Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

// Configuration
const args = process.argv.slice(2);
const HEADLESS = !args.includes('--headful') && !args.includes('--headed');
const TEST_MODE = args.includes('--test');
const PORT = process.env.DAEMON_PORT || process.env.PORT || 3001;

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}

let isPoolRunning = false;
let isPoolPaused = false;
let currentStage = 'idle';

const ALL_9_WORKERS = PIPELINE_CONFIG.allWorkerIds || [
  'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
  'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3',
  'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3',
];

/**
 * Reset all 9 workers in worker_status to idle
 */
async function resetAllWorkersIdle() {
  for (const wId of ALL_9_WORKERS) {
    const meta = PIPELINE_CONFIG.workerNames[wId] || wId;
    let stage = 'idle';
    if (wId.includes('scan')) stage = 'scanning';
    else if (wId.includes('resolve')) stage = 'resolving';
    else if (wId.includes('submit')) stage = 'submitting';

    await updateWorkerStatus(wId, {
      state: 'idle',
      current_application_id: null,
      stage,
      bot_name: meta,
    }).catch(() => {});
  }
}

/**
 * Synchronize global bot_control table state
 */
async function syncBotControlState(patch = {}) {
  await updateBotControl({
    stage: currentStage,
    is_running: isPoolRunning,
    is_paused: isPoolPaused,
    stop_requested: isGlobalStopRequested(),
    active_worker_count: isPoolRunning ? 3 : 0,
    ...patch,
  }).catch(() => {});
}

/**
 * Instantly stop all 9 workers and abort open browsers in <500ms
 */
export async function stopAutonomousPool() {
  console.log(`\n🛑 [DAEMON] STOP SIGNAL RECEIVED: Immediately halting 9-worker pipeline...`);
  isPoolRunning = false;
  isPoolPaused = true;
  currentStage = 'idle';

  setGlobalStop(true);

  // Terminate any active Playwright browser windows in <500ms
  await abortAllActiveBrowsers().catch(() => {});

  // Set all 9 workers to idle in worker_status
  await resetAllWorkersIdle().catch(() => {});

  // Update bot_control state
  await syncBotControlState({
    stage: 'idle',
    is_running: false,
    is_paused: true,
    stop_requested: true,
    active_worker_count: 0,
    current_action: 'Stopped by user',
  });

  await updateDaemonCaState('_daemon_', {
    caName: 'Autonomous 9-Worker Pipeline',
    state: 'idle',
    syncedDate: new Date().toISOString().slice(0, 10),
    workersAssigned: 9,
  }).catch(() => {});

  console.log(`✅ [DAEMON] Stop complete. All 9 workers set to idle and active browsers closed.`);
  return { success: true, message: 'All 9 workers stopped and reset to idle.' };
}

/**
 * Execute Stage 1: Scanning (scanning_worker_1, scanning_worker_2, scanning_worker_3)
 */
async function runStage1Scanning() {
  currentStage = 'scanning';
  await syncBotControlState({
    stage: 'scanning',
    is_running: true,
    current_action: 'Scanning unique Workday links and harvesting question schemas',
    active_worker_count: TEST_MODE ? 1 : 3,
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with 3 scanning workers (scanning_worker_1..3)...`);

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    topLinks: TEST_MODE ? 1 : 50,
    workers: TEST_MODE ? 1 : 3,
    headless: HEADLESS,
    confirmSubmit: false,
    limitPerLink: TEST_MODE ? 1 : null,
    defaultPassword: process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
  });

  // Ensure scanning workers reset to idle
  for (const wId of PIPELINE_CONFIG.scanWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'scanning' }).catch(() => {});
  }
}

/**
 * Execute Stage 2: Resolving Answers (resolving_worker_1, resolving_worker_2, resolving_worker_3)
 */
async function runStage2Resolving() {
  currentStage = 'resolving';
  await syncBotControlState({
    stage: 'resolving',
    is_running: true,
    current_action: 'Pre-resolving candidate answers across 4 tiers into job_distributions',
    active_worker_count: 3,
  });

  console.log(`\n⚡ [DAEMON] Starting Stage 2: Resolving candidate answers with 3 resolving workers (resolving_worker_1..3)...`);

  const { runResolvingWorkerPool } = await import('../lib/resolvingWorkerPool.mjs');
  await runResolvingWorkerPool();

  // Ensure resolving workers reset to idle
  for (const wId of PIPELINE_CONFIG.resolveWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'resolving' }).catch(() => {});
  }
}

/**
 * Execute Stage 3: Submissions (submitting_worker_1, submitting_worker_2, submitting_worker_3)
 */
async function runStage3Submissions() {
  currentStage = 'submitting';
  await syncBotControlState({
    stage: 'submitting',
    is_running: true,
    current_action: 'Submitting approved applications with Playwright verification',
    active_worker_count: 3,
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 3: Submitting approved applications with 3 submitting workers (submitting_worker_1..3)...`);

  const { runQueueWorkerPool } = await import('../lib/workerPool.mjs');
  await runQueueWorkerPool({
    concurrency: 3,
    headless: HEADLESS,
    confirmSubmit: true,
    dryRun: false,
    defaultPassword: process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
    activeCaOnly: false,
  });

  // Ensure submitting workers reset to idle
  for (const wId of PIPELINE_CONFIG.submitWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'submitting' }).catch(() => {});
  }
}

/**
 * Run the Sequential Pipeline: Stage 1 -> Stage 2 -> wait for CA review -> Stage 3
 */
export async function runSequentialPipeline() {
  if (isPoolRunning) {
    console.log(`[DAEMON] Pipeline is already running.`);
    return { success: true, message: 'Pipeline already running.' };
  }

  isPoolRunning = true;
  isPoolPaused = false;
  setGlobalStop(false);

  try {
    // ── STAGE 1: SCANNING (scanning_worker_1..3) ───────────────────────
    await runStage1Scanning();

    if (isGlobalStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped during/after Stage 1.`);
      return { success: true, stopped: true };
    }

    // ── STAGE 2: RESOLVING (resolving_worker_1..3) ─────────────────────
    await runStage2Resolving();

    if (isGlobalStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped during/after Stage 2.`);
      return { success: true, stopped: true };
    }

    currentStage = 'ready_for_review';
    await syncBotControlState({
      stage: 'ready_for_review',
      is_running: false,
      current_action: 'Awaiting Career Associate review in the Dashboard',
      active_worker_count: 0,
    });

    console.log(`\n✅ [DAEMON] Stages 1 & 2 complete! Job schemas harvested and answers pre-resolved.`);
    console.log(`   Waiting for Career Associate review in the Dashboard before submitting.\n`);
  } catch (err) {
    console.error(`❌ [DAEMON] Pipeline error:`, err?.message || err);
  } finally {
    isPoolRunning = false;
    currentStage = 'idle';
    await resetAllWorkersIdle().catch(() => {});
    await syncBotControlState({
      stage: 'idle',
      is_running: false,
      current_action: 'Idle',
      active_worker_count: 0,
    });
  }
}

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
    res.end(JSON.stringify({ status: 'healthy', isRunning: isPoolRunning, stage: currentStage, workers: 9 }));
    return;
  }

  // 2. Status
  if (pathname === '/api/bot/status') {
    const botControl = await getBotControl().catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isRunning: isPoolRunning,
      stage: currentStage,
      isPaused: isPoolPaused,
      workers: 9,
      stages: {
        scanning: 3,
        resolving: 3,
        submitting: 3,
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
    } catch {}
  }

  // 3. Stop Webhook
  if (pathname === '/api/bot/stop' || (pathname === '/api/bot/webhook' && body.action === 'stop')) {
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'All 9 workers stopped instantly. Active browser contexts aborted.',
      isRunning: false,
    }));
    return;
  }

  // 4. Start / Trigger Pipeline Webhook
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline'))) {
    if (isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Pipeline is already active.',
        isRunning: true,
        stage: currentStage,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Start signal received! Launching sequential 9-worker pipeline...`);
    // Run asynchronously so webhook response is instant (<100ms)
    runSequentialPipeline().catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Sequential 9-Worker Pipeline triggered! Scanning (3) -> Resolving (3).',
      isRunning: true,
      stage: 'scanning',
    }));
    return;
  }

  // 5a. Targeted Single-Item Submission Webhook (Zero Batch Log Pollution)
  if (pathname === '/api/bot/submit-single' || (pathname === '/api/bot/submit' && (body.distributionId || body.applywizzId))) {
    const { distributionId, applywizzId, jobUrl } = body;
    console.log(`\n⚡ [DAEMON WEBHOOK] Targeted submit received for ${applywizzId || distributionId} at ${jobUrl || 'URL'}`);

    // Pick an available submitting worker (1, 2, or 3)
    let chosenWorkerId = PIPELINE_CONFIG.submitWorkerIds[0] || 'submitting_worker_1';
    try {
      const { getWorkerStatuses } = await import('../lib/supabaseClient.mjs');
      const activeWorkers = await getWorkerStatuses().catch(() => []);
      const idleSubmitter = PIPELINE_CONFIG.submitWorkerIds.find((wid) => {
        const found = activeWorkers.find((w) => w.worker_id === wid);
        return !found || found.state === 'idle';
      });
      if (idleSubmitter) chosenWorkerId = idleSubmitter;
    } catch {}

    const { executeSingleTargetedSubmission } = await import('../lib/workerPool.mjs');
    // Dispatch in background so HTTP response returns in <100ms
    executeSingleTargetedSubmission({
      distributionId,
      applywizzId,
      jobUrl,
      workerId: chosenWorkerId,
      headless: HEADLESS,
    }).catch((err) => {
      console.error(`❌ [TARGETED SUBMISSION ERROR]:`, err?.message);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Targeted submission launched for ${applywizzId || 'candidate'} on ${chosenWorkerId}`,
      workerId: chosenWorkerId,
      distributionId,
    }));
    return;
  }

  // 5b. Batch Submit Approved Applications Webhook (Stage 3 Pool)
  if (pathname === '/api/bot/submit' || (pathname === '/api/bot/webhook' && (body.action === 'submit_approved' || body.action === 'stage_submit'))) {
    if (isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Pipeline is busy with another stage.',
        isRunning: true,
        stage: currentStage,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with 3 submitting workers...`);
    isPoolRunning = true;
    setGlobalStop(false);
    runStage3Submissions().finally(() => {
      isPoolRunning = false;
      currentStage = 'idle';
      resetAllWorkersIdle().catch(() => {});
      syncBotControlState({
        stage: 'idle',
        is_running: false,
        active_worker_count: 0,
      });
    }).catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Stage 3 Submissions triggered for approved applications across 3 submitting workers.',
      isRunning: true,
      stage: 'submitting',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// Startup initialization
async function initOnStartup() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  AUTONOMOUS WORKDAY PIPELINE DAEMON — 9-WORKER WEBHOOK ENGINE`);
  console.log(`  Scanning (3):   scanning_worker_1, scanning_worker_2, scanning_worker_3`);
  console.log(`  Resolving (3):  resolving_worker_1, resolving_worker_2, resolving_worker_3`);
  console.log(`  Submitting (3): submitting_worker_1, submitting_worker_2, submitting_worker_3`);
  console.log(`  Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Webhook Port: ${PORT}`);
  console.log(`${'═'.repeat(72)}\n`);

  try {
    await ensureCanonicalWorkers();
    await resetAllWorkersIdle();
    await syncBotControlState({ stage: 'idle', is_running: false, active_worker_count: 0 });
    console.log(`[DAEMON] worker_status table initialized: strictly 9 canonical rows set to idle.`);
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — 9-Worker Pipeline Active.\n`);
  });

  // ── Universal Cloud Bridge: Listen to Supabase signals (bot_control + worker_status fallback) ──
  let warnedMissingBotControl = false;
  setInterval(async () => {
    try {
      const bc = await getBotControl();

      if (bc) {
        // 1. Primary Stop Signal
        if (bc.stop_requested && isPoolRunning) {
          console.log(`\n🛑 [DAEMON SUPABASE TRIGGER] Detected 'stop_requested' in bot_control table! Stopping workers...`);
          await stopAutonomousPool();
          return;
        }

        // 2. Primary Start / Trigger Pipeline Signal
        if (!isPoolRunning && (bc.last_action_requested === 'start' || bc.last_action_requested === 'start_pipeline')) {
          console.log(`\n⚡ [DAEMON SUPABASE TRIGGER] Detected 'start' signal in bot_control table! Launching 9-worker pipeline...`);
          await syncBotControlState({ last_action_requested: null, is_running: true });
          runSequentialPipeline().catch(console.error);
          return;
        }

        // 3. Primary Submit Approved Applications Signal
        if (!isPoolRunning && bc.last_action_requested === 'submit_approved') {
          console.log(`\n⚡ [DAEMON SUPABASE TRIGGER] Detected 'submit_approved' signal in bot_control table! Launching Stage 3 Submissions...`);
          await syncBotControlState({ last_action_requested: null, is_running: true });
          isPoolRunning = true;
          setGlobalStop(false);
          runStage3Submissions().finally(() => {
            isPoolRunning = false;
            currentStage = 'idle';
            resetAllWorkersIdle().catch(() => {});
            syncBotControlState({ stage: 'idle', is_running: false, active_worker_count: 0 });
          }).catch(console.error);
          return;
        }
      } else {
        if (!warnedMissingBotControl) {
          warnedMissingBotControl = true;
          console.log(`\n[DAEMON] ℹ️ Supabase 'bot_control' table not detected. Active fallback bridge listening directly on 'worker_status' table.`);
        }
      }

      // ── Resilient Fallback Bridge via worker_status table ──
      // Triggers if frontend writes directly to worker_status before migration 023 is applied
      const statuses = await getWorkerStatuses().catch(() => []);
      if (!isPoolRunning) {
        const hasTrigger = statuses.some((w) =>
          w.worker_id &&
          w.worker_id.includes('scan') &&
          w.state === 'in_flight' &&
          w.current_application_id &&
          w.current_application_id.includes('Stage 1')
        );
        if (hasTrigger) {
          console.log(`\n⚡ [DAEMON WORKER_STATUS TRIGGER] Detected 'in_flight' signal in worker_status table! Launching 9-worker pipeline...`);
          runSequentialPipeline().catch(console.error);
          return;
        }
      }
    } catch {
      // Continue polling silently
    }
  }, 2000);
}

process.on('SIGTERM', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log('[DAEMON] SIGTERM received. Shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log('[DAEMON] Interrupted. Shutting down.');
  process.exit(0);
});

initOnStartup().catch((err) => {
  console.error('[DAEMON FATAL]', err);
  process.exit(1);
});
