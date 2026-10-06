/**
 * queue_daemon.mjs — Automatic Queue Watcher Daemon
 * ==================================================
 * Runs continuously in the background (Railway or local node process).
 *
 * Architecture:
 *   1. Polls batch_job_queue and job_distributions every 15 seconds.
 *   2. Autonomously triggers on pending links:
 *      - When links are uploaded to Supabase, triggers a 3-worker headless pool.
 *      - Processes all unique links in the background BEFORE the CA logs in.
 *      - Scrapes questions, captures review screenshots, and resolves 4-tier answers.
 *      - Distributes successful results into job_distributions table.
 *      - Distributes failures into failed_jobs and application_failures tables with failure screenshots.
 *   3. Executes CA-approved submissions:
 *      - When CA clicks "Review & Submit", tasks marked 'approved_for_submission' / 'queued'
 *        are prioritized immediately.
 *      - Real bot fills the application using pre-resolved JSON answers.
 *      - While waiting, status shows 'queued'.
 *      - When worker executes, status updates to 'applying'.
 *      - After successful Workday submission, captures authentic confirmation screenshot,
 *        saves it to original_application_screenshot_successful, and marks status 'submitted'.
 *   4. Heartbeats to Supabase every 60 seconds so Railway shows the daemon alive.
 *
 * Usage:
 *   node backend/scripts/queue_daemon.mjs [--workers 3] [--dry-run] [--headful]
 */

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
const POLL_INTERVAL_MS = 15_000;
const SYNC_WAIT_MS = 8_000;
const HEARTBEAT_MS = 60_000;

// In-Memory Dispatch Tracking
const dispatchedToday = new Map();
let daemonDate = new Date().toISOString().slice(0, 10);
let isPoolRunning = false;

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
      caName: 'System Daemon',
      state: isPoolRunning ? 'running' : 'idle',
      syncedDate: todayStr(),
    });
    console.log(`[DAEMON] Heartbeat @ ${new Date().toISOString()} (pool: ${isPoolRunning ? 'RUNNING' : 'IDLE'})`);
  } catch {}
}, HEARTBEAT_MS);

// Autonomous Background Worker Pool Dispatch
async function checkAndTriggerAutonomousPool() {
  if (isPoolRunning) return;

  try {
    const pendingTasks = await fetchPendingTasksForActiveCAs(null);
    if (!pendingTasks || pendingTasks.length === 0) {
      return;
    }

    const approvedCount = pendingTasks.filter(
      (t) => t.status === 'approved_for_submission' || t.status === 'queued_for_submission' || t.status === 'queued'
    ).length;
    const regularPendingCount = pendingTasks.length - approvedCount;

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`⚡ [DAEMON] TRIGGER ACTIVATED: ${pendingTasks.length} queued task(s) detected.`);
    console.log(`   • ${regularPendingCount} pending blueprint & distribution tasks`);
    console.log(`   • ${approvedCount} CA-reviewed tasks ready for final real submission`);
    console.log(`   • Mode: ${CONCURRENCY} workers | ${HEADLESS ? 'HEADLESS' : 'HEADFUL'}`);
    console.log(`${'═'.repeat(70)}\n`);

    isPoolRunning = true;
    await updateDaemonCaState('_daemon_', {
      caName: 'Background Daemon',
      state: 'running',
      syncedDate: todayStr(),
      workersAssigned: CONCURRENCY,
      tasksDispatched: pendingTasks.length,
    }).catch(() => {});

    try {
      const results = await runQueueWorkerPool({
        concurrency: CONCURRENCY,
        headless: HEADLESS,
        confirmSubmit: false, // Halts pending tasks at Step 5 Review; approved tasks automatically execute final submission
        dryRun: DRY_RUN,
        defaultPassword: process.env.WORKDAY_PASSWORD || '',
        activeCaOnly: false, // Autonomously executes in background without waiting for CA!
      });

      const submitted = results.filter((r) => r.status === 'submitted').length;
      const reachedReview = results.filter((r) => r.status === 'reached_review' || r.status === 'ready_for_review').length;
      const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
      console.log(`\n[DAEMON] Pool run finished: ${submitted} submitted, ${reachedReview} review-ready & distributed, ${failed} failed, ${results.length} total.`);

      await updateDaemonCaState('_daemon_', {
        caName: 'Background Daemon',
        state: 'idle',
        syncedDate: todayStr(),
      }).catch(() => {});
    } catch (err) {
      console.error(`\n[DAEMON] Worker pool error:`, err?.message || err);
      await updateDaemonCaState('_daemon_', { caName: 'Background Daemon', state: 'idle' }).catch(() => {});
    } finally {
      isPoolRunning = false;
    }
  } catch (err) {
    console.error('[DAEMON] checkAndTriggerAutonomousPool error:', err?.message || err);
  }
}

// Main Poll Loop
async function pollLoop() {
  const sep = '='.repeat(70);
  console.log(`\n${sep}`);
  console.log('  QUEUE WATCHER DAEMON — 3-WORKER AUTONOMOUS BACKGROUND ENGINE');
  console.log(`  Workers: ${CONCURRENCY} | Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Dry-run: ${DRY_RUN}`);
  console.log(`  Poll Interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`${sep}\n`);

  while (true) {
    try {
      resetIfNewDay();

      // 1. Check and trigger autonomous background pool on any uploaded or approved tasks
      await checkAndTriggerAutonomousPool();

      // 2. Track operator presence for dashboard metrics
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

process.on('SIGTERM', () => { clearInterval(heartbeatTimer); console.log('[DAEMON] SIGTERM. Shutting down.'); process.exit(0); });
process.on('SIGINT',  () => { clearInterval(heartbeatTimer); console.log('[DAEMON] Interrupted.'); process.exit(0); });

pollLoop().catch((err) => { console.error('[DAEMON] Fatal:', err); process.exit(1); });
