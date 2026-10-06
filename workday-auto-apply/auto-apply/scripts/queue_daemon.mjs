/**
 * queue_daemon.mjs — Automatic Queue Watcher Daemon & Trigger Server
 * ==================================================================
 * Runs continuously in the background (Railway or local node process).
 *
 * Architecture:
 *   1. Embedded HTTP Health & Trigger Server:
 *      - GET  /health -> Returns 200 OK (Satisfies Railway health checks).
 *      - POST /api/bot/trigger -> Triggers the 3-worker autonomous pool on demand.
 *      - GET  /api/bot/status -> Returns live pool status and worker metrics.
 *   2. Dual-channel Trigger:
 *      - Instant HTTP API trigger from Developer Dashboard.
 *      - Supabase database signal listener on queue_daemon_state (state = 'trigger_requested').
 *   3. Autonomous 3-Worker Pipeline:
 *      - Clusters unique links from batch_job_queue.
 *      - Worker 1, 2, 3 visit unique links in parallel, scraping questions & review screenshot into scanned_jobs.
 *      - Pre-resolves 4-tier answers (AI/LLM, Supabase QA, profile facts) for all clients sharing each job.
 *      - Distributes records into job_distributions table with status 'ready_for_review'.
 *   4. Executes CA-approved submissions:
 *      - When CA clicks "Review & Submit", tasks marked 'approved_for_submission' are submitted.
 *      - Captures authentic confirmation screenshot and stores in applied_screenshot & original_application_screenshot_successful.
 *   5. Heartbeats to Supabase every 60 seconds.
 *
 * Usage:
 *   node backend/scripts/queue_daemon.mjs [--workers 3] [--dry-run] [--headful]
 */

import http from 'node:http';
import '../lib/polyfills.mjs';
import {
  loadLocalEnvOnce,
  isSupabaseConfigured,
  getActiveOperators,
  getActiveCaCandidateIds,
  getTotalApplicationCountForCandidates,
  updateDaemonCaState,
  fetchPendingTasksForActiveCAs,
} from '../lib/supabaseClient.mjs';
import { runQueueWorkerPool } from '../lib/workerPool.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('[DAEMON FATAL] Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

// CLI Args
const args = process.argv.slice(2);
const workersIdx = args.indexOf('--workers');
const CONCURRENCY = workersIdx !== -1 && args[workersIdx + 1] ? Number(args[workersIdx + 1]) || 3 : 3;
const DRY_RUN = args.includes('--dry-run');
const HEADLESS = !args.includes('--headful');
const FORCE_DISPATCH = args.includes('--force');
const targetCaIdx = args.indexOf('--ca');
const TARGET_CA = targetCaIdx !== -1 && args[targetCaIdx + 1] ? args[targetCaIdx + 1].trim().toLowerCase() : null;
const POLL_INTERVAL_MS = 8_000;
const HEARTBEAT_MS = 60_000;
const PORT = process.env.PORT || 3001;

// In-Memory Dispatch Tracking
const dispatchedToday = new Map();
let daemonDate = new Date().toISOString().slice(0, 10);
let isPoolRunning = false;
let lastTriggerTime = null;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = todayStr();
  if (today !== daemonDate) {
    console.log(`\n[DAEMON] New day (${today}). Resetting dispatch memory.`);
    dispatchedToday.clear();
    daemonDate = today;
  }
}

// Heartbeat
let heartbeatTimer = setInterval(async () => {
  resetIfNewDay();
  try {
    await updateDaemonCaState('_daemon_', {
      caName: 'Autonomous 3-Worker Pool',
      state: isPoolRunning ? 'running' : 'idle',
      syncedDate: todayStr(),
      workersAssigned: CONCURRENCY,
    });
    console.log(`[DAEMON] Heartbeat @ ${new Date().toISOString()} (pool: ${isPoolRunning ? 'RUNNING' : 'IDLE'})`);
  } catch {}
}, HEARTBEAT_MS);

// Autonomous Background Worker Pool Dispatch
export async function checkAndTriggerAutonomousPool(force = false) {
  if (isPoolRunning) {
    console.log('[DAEMON] Pool is already running. Skipping duplicate trigger.');
    return;
  }

  try {
    const pendingTasks = await fetchPendingTasksForActiveCAs(null);
    if (!force && (!pendingTasks || pendingTasks.length === 0)) {
      return;
    }

    const taskCount = pendingTasks ? pendingTasks.length : 0;
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`⚡ [DAEMON] TRIGGER ACTIVATED: ${taskCount} task(s) detected in queue.`);
    console.log(`   • Mode: ${CONCURRENCY} workers | ${HEADLESS ? 'HEADLESS' : 'HEADFUL'}`);
    console.log(`   • Phase 1: Unique link cluster scan & answers distribution to job_distributions`);
    console.log(`   • Phase 2: Autonomous fast-fill and CA-approved submission execution`);
    console.log(`${'═'.repeat(70)}\n`);

    isPoolRunning = true;
    lastTriggerTime = new Date().toISOString();
    await updateDaemonCaState('_daemon_', {
      caName: 'Autonomous 3-Worker Pool',
      state: 'running',
      syncedDate: todayStr(),
      workersAssigned: CONCURRENCY,
      tasksDispatched: taskCount,
    }).catch(() => {});

    // Phase 1: Cluster Batch Runner on unique links -> saves scanned_jobs & distributes to job_distributions
    try {
      console.log(`\n🚀 [DAEMON] Launching 3-Worker Cluster Batch Runner on unique links...`);
      const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
      await runClusterBatchRunner({
        topLinks: 50,
        workers: CONCURRENCY,
        headless: HEADLESS,
        confirmSubmit: false,
      });
      console.log(`✅ [DAEMON] Cluster scanning & client distribution completed successfully.`);
    } catch (clusterErr) {
      console.error(`⚠️ [DAEMON] Cluster batch runner note:`, clusterErr?.message || clusterErr);
    }

    // Phase 2: Worker pool execution for any approved submissions or queue tasks
    try {
      console.log(`\n🚀 [DAEMON] Launching Worker Pool for submissions and queue tasks...`);
      const results = await runQueueWorkerPool({
        concurrency: CONCURRENCY,
        headless: HEADLESS,
        confirmSubmit: true,
        dryRun: DRY_RUN,
        defaultPassword: process.env.WORKDAY_PASSWORD || '',
        activeCaOnly: false,
      });

      const submitted = results.filter((r) => r.status === 'submitted').length;
      const reachedReview = results.filter((r) => r.status === 'reached_review' || r.status === 'ready_for_review').length;
      const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
      console.log(`\n[DAEMON] Pool run finished: ${submitted} submitted, ${reachedReview} review-ready, ${failed} failed.`);
    } catch (err) {
      console.error(`\n[DAEMON] Worker pool error:`, err?.message || err);
    } finally {
      await updateDaemonCaState('_daemon_', {
        caName: 'Autonomous 3-Worker Pool',
        state: 'idle',
        syncedDate: todayStr(),
      }).catch(() => {});
      isPoolRunning = false;
    }
  } catch (err) {
    console.error('[DAEMON] checkAndTriggerAutonomousPool error:', err?.message || err);
    isPoolRunning = false;
  }
}

// Check for trigger signal in Supabase queue_daemon_state
async function checkSupabaseTriggerSignal() {
  if (isPoolRunning) return;
  try {
    const { getCleanSupabaseEnv } = await import('../lib/clusterBatchRunner.mjs');
    const { httpsJsonWithRetry } = await import('../lib/httpClient.mjs');
    const { url, key, configured } = getCleanSupabaseEnv();
    if (!configured) return;

    const res = await httpsJsonWithRetry({
      url: `${url}/rest/v1/queue_daemon_state?ca_email=eq._daemon_&select=state,triggered_at`,
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });

    if (res.ok && res.text) {
      const data = res.json();
      if (Array.isArray(data) && data[0]?.state === 'trigger_requested') {
        console.log(`\n⚡ [DAEMON] Supabase trigger signal received from Developer Dashboard! Starting 3-worker bot...`);
        checkAndTriggerAutonomousPool(true).catch(console.error);
      }
    }
  } catch {}
}

// Embedded Native HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'workday-queue-daemon',
      poolRunning: isPoolRunning,
      workers: CONCURRENCY,
      lastTriggerTime,
      time: new Date().toISOString(),
    }));
    return;
  }

  if (u.pathname === '/api/bot/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isRunning: isPoolRunning,
      workers: CONCURRENCY,
      lastTriggerTime,
      time: new Date().toISOString(),
    }));
    return;
  }

  if (u.pathname === '/api/bot/trigger') {
    if (isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '3-Worker Bot is already executing in the background.',
        isRunning: true,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON] HTTP Trigger received from Developer Dashboard! Starting 3 workers...`);
    // Launch execution asynchronously so HTTP response is instant
    checkAndTriggerAutonomousPool(true).catch((err) => console.error('[HTTP TRIGGER ERROR]', err));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Autonomous 3-Worker Bot successfully triggered! Workers are clustering unique links, scraping questions into scanned_jobs, and distributing answers.',
      isRunning: true,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DAEMON SERVER] HTTP listening on 0.0.0.0:${PORT} (Health & Developer Trigger API active)`);
});

// Main Poll Loop
async function pollLoop() {
  const sep = '='.repeat(70);
  console.log(`\n${sep}`);
  console.log('  QUEUE WATCHER DAEMON — 3-WORKER AUTONOMOUS BACKGROUND ENGINE');
  console.log(`  Workers: ${CONCURRENCY} | Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Dry-run: ${DRY_RUN}`);
  console.log(`  Poll Interval: ${POLL_INTERVAL_MS / 1000}s | HTTP Port: ${PORT}`);
  console.log(`${sep}\n`);

  while (true) {
    try {
      resetIfNewDay();

      // 1. Check for on-demand trigger signal from Developer Dashboard in Supabase
      await checkSupabaseTriggerSignal();

      // 2. Check and trigger autonomous background pool on any uploaded or approved tasks
      await checkAndTriggerAutonomousPool(false);

      // 3. Track operator presence for dashboard metrics
      const activeOps = await getActiveOperators().catch(() => []);
      for (const op of activeOps) {
        const email = (op.email || '').toLowerCase().trim();
        if (!email || email === '_daemon_') continue;
        const lastIn = Math.max(
          new Date(op.last_sign_in || 0).getTime(),
          new Date(op.updated_at || 0).getTime()
        );
        const ageSec = (Date.now() - lastIn) / 1000;
        if (ageSec <= 180) {
          await updateDaemonCaState(email, {
            caName: op.name || email,
            state: isPoolRunning ? 'running' : 'idle',
            syncedDate: todayStr(),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[DAEMON] Poll error:', err?.message || err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on('SIGTERM', () => { clearInterval(heartbeatTimer); server.close(); console.log('[DAEMON] SIGTERM. Shutting down.'); process.exit(0); });
process.on('SIGINT',  () => { clearInterval(heartbeatTimer); server.close(); console.log('[DAEMON] Interrupted.'); process.exit(0); });

pollLoop().catch((err) => { console.error('[DAEMON] Fatal:', err); process.exit(1); });
