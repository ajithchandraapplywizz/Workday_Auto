/**
 * queue_daemon.mjs — Automatic Queue Watcher Daemon
 * ==================================================
 * Runs continuously in the background (Railway or local node process).
 *
 * Behavior:
 *   1. Polls the `operators` table every 15 seconds.
 *   2. When a new CA signs in (status='active', last_sign_in is recent):
 *      a. Records their state in queue_daemon_state as 'detected'.
 *      b. Waits 8 seconds for the frontend Smart Sync to complete.
 *      c. Confirms the CA has pending tasks in batch_job_queue.
 *      d. If tasks exist, spawns the Link-Clustered Fair-Share worker pool.
 *   3. Tracks which CAs have been dispatched today to prevent double-dispatch.
 *   4. Heartbeats to Supabase every 60 seconds so Railway shows the daemon alive.
 *
 * Usage:
 *   node scripts/queue_daemon.mjs [--workers 10] [--dry-run] [--headful]
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
const CONCURRENCY = workersIdx !== -1 && args[workersIdx + 1] ? Number(args[workersIdx + 1]) || 1 : 1;
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function alreadyDispatchedToday(caEmail) {
  if (FORCE_DISPATCH) return false;
  return dispatchedToday.get(caEmail.toLowerCase()) === todayStr();
}

function markDispatched(caEmail) {
  dispatchedToday.set(caEmail.toLowerCase(), todayStr());
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
      state: 'idle',
      syncedDate: todayStr(),
    });
    console.log(`[DAEMON] Heartbeat @ ${new Date().toISOString()}`);
  } catch {}
}, HEARTBEAT_MS);

// Worker Pool Dispatch
async function dispatchWorkerPoolForCA(caEmail, caName) {
  console.log(`\n[DAEMON] Dispatching ${CONCURRENCY}-worker pool for ${caEmail} (${caName})`);
  await updateDaemonCaState(caEmail, {
    caName,
    state: 'dispatched',
    syncedDate: todayStr(),
    workersAssigned: CONCURRENCY,
  });
  markDispatched(caEmail);

  try {
    const results = await runQueueWorkerPool({
      concurrency: CONCURRENCY,
      headless: HEADLESS,
      confirmSubmit: false, // Halts at Step 5 Review & Submit, scraping questions into JSON for CA manual review
      dryRun: DRY_RUN,
      defaultPassword: process.env.WORKDAY_PASSWORD || '',
      activeCaOnly: true,
      caEmails: [caEmail],
    });
    const submitted = results.filter((r) => r.status === 'submitted').length;
    const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
    console.log(`\n[DAEMON] Pool for ${caEmail} finished: ${submitted} submitted, ${failed} failed, ${results.length} total.`);
    await updateDaemonCaState(caEmail, { caName, state: 'draining', tasksDispatched: results.length });
  } catch (err) {
    console.error(`\n[DAEMON] Pool error for ${caEmail}:`, err?.message || err);
    await updateDaemonCaState(caEmail, { caName, state: 'idle' });
  }
}

// Main Poll Loop
async function pollLoop() {
  const sep = '='.repeat(70);
  console.log(`\n${sep}`);
  console.log('  QUEUE WATCHER DAEMON — LINK-CLUSTERED FAIR-SHARE');
  console.log(`  Workers: ${CONCURRENCY} | Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Dry-run: ${DRY_RUN}`);
  console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s | Sync grace: ${SYNC_WAIT_MS / 1000}s`);
  console.log(`${sep}\n`);

  while (true) {
    try {
      resetIfNewDay();
      const activeOps = await getActiveOperators();
      // Sort so the CA who is currently online/active in the browser is prioritized first
      activeOps.sort((a, b) => {
        const timeA = Math.max(new Date(a.updated_at || 0).getTime(), new Date(a.last_sign_in || 0).getTime());
        const timeB = Math.max(new Date(b.updated_at || 0).getTime(), new Date(b.last_sign_in || 0).getTime());
        return timeB - timeA;
      });

      const newLogins = activeOps.filter((op) => {
        const email = (op.email || '').toLowerCase().trim();
        if (!email || email === '_daemon_') return false;
        if (TARGET_CA && email !== TARGET_CA) return false;
        if (alreadyDispatchedToday(email)) return false;
        const lastIn = Math.max(
          new Date(op.last_sign_in || 0).getTime(),
          new Date(op.updated_at || 0).getTime()
        );
        const ageSec = (Date.now() - lastIn) / 1000;
        // Strictly require the CA to be actively online within the last 3 minutes (180s)
        return ageSec <= 180;
      });

      if (newLogins.length > 0) {
        console.log(`\n[DAEMON] ${newLogins.length} new CA login(s): ${newLogins.map((o) => o.email).join(', ')}`);
        for (const op of newLogins) {
          const caEmail = op.email.toLowerCase().trim();
          const caName = op.name || '';
          await updateDaemonCaState(caEmail, { caName, state: 'detected', syncedDate: todayStr() });
          console.log(`  [DAEMON] Waiting ${SYNC_WAIT_MS / 1000}s for Smart Sync to complete for ${caEmail}...`);
          await new Promise((r) => setTimeout(r, SYNC_WAIT_MS));

          const caScope = await getActiveCaCandidateIds({ caEmails: [caEmail] });
          if (caScope.candidateIds.length === 0) {
            console.log(`  🛑 [DAEMON] No candidates assigned to ${caEmail}. Bot triggering STOPPED.`);
            await updateDaemonCaState(caEmail, { caName, state: 'idle', syncedDate: todayStr(), note: '0 assigned candidates' });
            markDispatched(caEmail);
            continue;
          }

          // Check application count for clients inside CA dashboard (matches left sidebar count)
          // If 0 for all clients for this particular CA, STOP the triggering of bot!
          const totalApps = await getTotalApplicationCountForCandidates(caScope.candidateIds);
          if (totalApps === 0) {
            console.log(`  🛑 [DAEMON] STOPPED: Application count for all ${caScope.candidateIds.length} clients of ${caEmail} is 0. Bot triggering STOPPED. No use in triggering.`);
            await updateDaemonCaState(caEmail, {
              caName,
              state: 'idle',
              syncedDate: todayStr(),
              candidateIds: caScope.candidateIds,
              tasksDispatched: 0,
              note: '0 applications across all clients. Bot triggering stopped.'
            });
            markDispatched(caEmail);
            continue;
          }

          const pending = await fetchPendingTasksForActiveCAs(caScope.candidateIds);
          if (pending.length === 0) {
            console.log(`  🛑 [DAEMON] STOPPED: 0 pending tasks for ${caEmail} (out of ${totalApps} total apps). Bot triggering STOPPED.`);
            await updateDaemonCaState(caEmail, {
              caName,
              state: 'idle',
              syncedDate: todayStr(),
              candidateIds: caScope.candidateIds,
              tasksDispatched: 0,
              note: '0 pending tasks remaining. Bot triggering stopped.'
            });
            markDispatched(caEmail);
            continue;
          }

          await updateDaemonCaState(caEmail, { caName, state: 'synced', syncedDate: todayStr(), candidateIds: caScope.candidateIds });
          console.log(`  ⚡ [DAEMON] ${caEmail}: ${pending.length} pending tasks for ${caScope.candidateIds.length} clients (${totalApps} total apps) -> dispatching.`);
          dispatchWorkerPoolForCA(caEmail, caName).catch((err) => {
            console.error(`  [DAEMON] Background error for ${caEmail}:`, err?.message || err);
          });
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
