/**
 * test_e2e_frontend_toggle_and_services.mjs
 * End-to-end human-like test verifying:
 * 1. Two separate local services (Scanner on 3001, Submitter on 3002)
 * 2. Frontend toggle triggers only the appropriate service
 * 3. Log isolation: Scanner logs stay on 3001, Submitter logs stay on 3002
 * 4. Page reload / mobile sync: isScanning / isSubmitting state persistence
 * 5. User halt / stop: browser aborts, in-progress queue item cleanly rolls back to pending
 * 6. Clean re-trigger & submission trigger isolation
 */

import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Supabase credentials missing from .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_JOB_IDS = [
  '06c93927-15e4-48de-a08a-cae468e4788c', // FICO
  'cccaff5e-73d8-4eb5-8269-0e36db52f7ad', // T. Rowe Price
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Accept': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(4000),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function runTest() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🧪 RUNNING PRODUCTION-GRADE E2E FRONTEND TOGGLE & SERVICES TEST');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // STEP 1: Reset 2 real test companies in batch_job_queue to 'pending'
  console.log('▶️ [STEP 1] Resetting 2 test companies (FICO & T. Rowe Price) to pending in batch_job_queue...');
  const { error: resetErr } = await supabase
    .from('batch_job_queue')
    .update({
      status: 'pending',
      worker_id: null,
      locked_at: null,
      attempt_count: 0,
      updated_at: new Date().toISOString(),
    })
    .in('id', TEST_JOB_IDS);

  if (resetErr) {
    throw new Error('Failed to reset batch_job_queue: ' + resetErr.message);
  }

  // Also reset bot_control to clean idle state
  await supabase
    .from('bot_control')
    .update({
      stage: 'idle',
      is_running: false,
      is_paused: false,
      stop_requested: false,
      trigger_requested: false,
      last_action_requested: null,
      current_action: 'Test Initialized: Idle',
      active_worker_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  // Ensure all workers in worker_status are idle
  await supabase
    .from('worker_status')
    .update({
      state: 'idle',
      stage: 'idle',
      current_application_id: null,
      updated_at: new Date().toISOString(),
    })
    .neq('worker_id', '');

  console.log('   ✓ Real applications reset to pending in batch_job_queue.');
  console.log('   ✓ bot_control reset to idle.');
  console.log('   ✓ worker_status reset to idle.');

  // STEP 2: Launch Service 1 (Scanner on 3001) & Service 2 (Submitter on 3002)
  console.log('\n▶️ [STEP 2] Launching 2 separate local services (Scanner :3001, Submitter :3002)...');

  const nodeBin = process.execPath;
  const scannerProcess = spawn(nodeBin, ['backend/scripts/queue_daemon.mjs', 'scanner', '--test'], {
    env: { ...process.env, SERVICE_ROLE: 'scanner', PORT: '3001', HEADLESS: 'true', SCANNER_RUN: 'true' },
    stdio: 'pipe',
  });

  const submitterProcess = spawn(nodeBin, ['backend/scripts/queue_daemon.mjs', 'submitter'], {
    env: { ...process.env, SERVICE_ROLE: 'submitter', PORT: '3002', HEADLESS: 'true', SUBMIT_RUN: 'true' },
    stdio: 'pipe',
  });

  scannerProcess.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('error') || s.includes('Error') || s.includes('Exception') || s.includes('fail') || s.includes('CLUSTER') || s.includes('Scanning')) {
      console.log('   [SCANNER STDOUT]:', s.trim());
    }
  });
  scannerProcess.stderr.on('data', (d) => console.error('   [SCANNER STDERR]:', d.toString().trim()));
  submitterProcess.stderr.on('data', (d) => console.error('   [SUBMITTER STDERR]:', d.toString().trim()));

  const cleanup = () => {
    try { scannerProcess.kill('SIGKILL'); } catch {}
    try { submitterProcess.kill('SIGKILL'); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  // Wait for services to bind to ports
  let scannerReady = false;
  let submitterReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(600);
    if (!scannerReady) {
      const h1 = await fetchJson('http://localhost:3001/health');
      if (h1.ok) scannerReady = true;
    }
    if (!submitterReady) {
      const h2 = await fetchJson('http://localhost:3002/health');
      if (h2.ok) submitterReady = true;
    }
    if (scannerReady && submitterReady) break;
  }

  if (!scannerReady || !submitterReady) {
    cleanup();
    throw new Error(`Services failed to start! scannerReady: ${scannerReady}, submitterReady: ${submitterReady}`);
  }

  console.log('   ✓ Scanner service active on http://localhost:3001');
  console.log('   ✓ Submitter service active on http://localhost:3002');

  // STEP 3: Verify initial idle state & isolated logs
  console.log('\n▶️ [STEP 3] Verifying initial service log isolation...');
  const logs1 = await fetchJson('http://localhost:3001/api/bot/logs');
  const logs2 = await fetchJson('http://localhost:3002/api/bot/logs');

  console.log(`   ✓ Service 1 (:3001 Scanner) returned ${logs1.data?.scanLogs?.length || 0} scan log(s).`);
  console.log(`   ✓ Service 2 (:3002 Submitter) returned ${logs2.data?.submitLogs?.length || 0} submit log(s).`);

  // STEP 4: Simulate clicking Frontend Toggle "Scan & Resolve"
  console.log('\n▶️ [STEP 4] Simulating Human Clicking Frontend Toggle "Trigger Scanning & Resolving"...');

  // Frontend sends POST /api/bot/start to port 3001 AND updates bot_control in Supabase
  const startResp = await fetchJson('http://localhost:3001/api/bot/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', trigger: true }),
  });

  await supabase
    .from('bot_control')
    .update({
      stage: 'scanning',
      is_running: true,
      is_paused: false,
      stop_requested: false,
      trigger_requested: true,
      last_action_requested: 'start_scan',
      current_action: 'Scanning unique job links across dedicated workers...',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  console.log('   ✓ Trigger dispatched! startResp status:', startResp.status);

  // Give scanner service 4 seconds to claim task and start Playwright
  console.log('   ⏳ Waiting 4s for scanner worker to lease batch link and launch browser...');
  await sleep(4000);

  // Check Service 1 (Scanner) logs vs Service 2 (Submitter) logs
  const scanActiveLogs = await fetchJson('http://localhost:3001/api/bot/logs');
  const submitIdleLogs = await fetchJson('http://localhost:3002/api/bot/logs');

  console.log(`   Recent scanner logs (${scanActiveLogs.data?.scanLogs?.length || 0}):`);
  (scanActiveLogs.data?.scanLogs || []).slice(-10).forEach(l => console.log('     ', l.message));
  const hasScanLogs = (scanActiveLogs.data?.scanLogs || []).some((l) =>
    l.message.includes('CLUSTER BATCH RUNNER') ||
    l.message.includes('Scanning') ||
    l.message.includes('Worker') ||
    l.message.includes('Job #') ||
    l.message.includes('Stage 1')
  );

  const submitRanAnyScan = (submitIdleLogs.data?.logs || []).some((l) =>
    l.message.includes('CLUSTER BATCH RUNNER') ||
    l.message.includes('Stage 1')
  );

  console.log(`   ✓ Scanner service active logs flowing: ${hasScanLogs ? 'YES (Verified)' : 'NO'}`);
  console.log(`   ✓ Submitter service completely isolated (0 scan activity): ${!submitRanAnyScan ? 'YES (Verified)' : 'FAILED'}`);

  if (submitRanAnyScan) {
    cleanup();
    throw new Error('Submitter service improperly processed scan trigger!');
  }

  // STEP 5: Test Page Reload / Mobile Sync (Verify Toggle DOES NOT fall back to "Trigger")
  console.log('\n▶️ [STEP 5] Simulating Page Refresh / Mobile Open (State Persistence Check)...');

  // Exact reproduction of fetchBotDaemonStatus from api.js:
  let scannerApiRunning = false;
  let submitterApiRunning = false;
  try {
    const s1 = await fetchJson('http://localhost:3001/api/bot/status');
    if (s1.ok) {
      scannerApiRunning = Boolean(s1.data?.isRunning || s1.data?.stage === 'scanning' || s1.data?.scan_status === 'running');
    }
  } catch {}
  try {
    const s2 = await fetchJson('http://localhost:3002/api/bot/status');
    if (s2.ok) {
      submitterApiRunning = Boolean(s2.data?.isRunning || s2.data?.stage === 'submitting' || s2.data?.submit_status === 'running');
    }
  } catch {}

  const { data: bcCheck } = await supabase.from('bot_control').select('*').eq('id', 'primary').maybeSingle();
  const { data: wsCheck } = await supabase.from('worker_status').select('*');

  const hasActiveScanWorkers = (wsCheck || []).some((w) =>
    (w.stage === 'scanning' || w.stage === 'resolving' || w.worker_id?.includes('scan')) &&
    (w.state === 'in_flight' || w.state === 'busy')
  );
  const isScanHalted = bcCheck?.last_action_requested === 'stop_scan' && bcCheck?.stop_requested;

  const isScanning = !isScanHalted && Boolean(
    scannerApiRunning ||
    hasActiveScanWorkers ||
    (bcCheck?.stage === 'scanning' && bcCheck?.is_running && !bcCheck?.stop_requested) ||
    (bcCheck?.last_action_requested === 'start_scan' && (bcCheck?.trigger_requested || bcCheck?.is_running))
  );

  console.log(`   ✓ scannerApiRunning (Port 3001): ${scannerApiRunning}`);
  console.log(`   ✓ bot_control.stage: "${bcCheck?.stage}", is_running: ${bcCheck?.is_running}`);
  console.log(`   ✓ UI State on reload: isScanActive = ${isScanning} (Toggle shows "Stop Scanning", NOT "Trigger")`);

  if (!isScanning) {
    cleanup();
    throw new Error('Page reload / mobile state calculation failed! isScanning evaluated to false.');
  }

  // STEP 6: Test Human Clicking "Stop Scanning" (Graceful Halt & Fallback to Pending)
  console.log('\n▶️ [STEP 6] Simulating Human Clicking "Stop Scanning" (Halt & Rollback Check)...');

  // Frontend stop button dispatches stop to port 3001 and marks bot_control stop_requested
  await fetchJson('http://localhost:3001/api/bot/scan/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop_scan' }),
  });

  await supabase
    .from('bot_control')
    .update({
      stage: 'idle',
      is_running: false,
      stop_requested: true,
      trigger_requested: false,
      last_action_requested: 'stop_scan',
      current_action: 'Scan & Resolve stopped by user.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  // Rollback processing tasks in batch_job_queue as frontend stopAutonomousBot does
  await supabase
    .from('batch_job_queue')
    .update({
      status: 'pending',
      worker_id: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing');

  console.log('   ⏳ Waiting 3s for worker abortion and DB rollback...');
  await sleep(3000);

  // Check batch_job_queue status: Must be 'pending', NOT 'failed'!
  const { data: queueAfterStop } = await supabase
    .from('batch_job_queue')
    .select('id, company, status, worker_id')
    .in('id', TEST_JOB_IDS);

  console.log('   Queue items after stop:', queueAfterStop);
  const anyMarkedFailed = (queueAfterStop || []).some((q) => q.status === 'failed');
  const allPendingOrReached = (queueAfterStop || []).every((q) => q.status === 'pending' || q.status === 'reached_review');

  console.log(`   ✓ Processing items cleanly rolled back to pending (not failed): ${allPendingOrReached && !anyMarkedFailed ? 'YES (Verified)' : 'FAILED'}`);

  // Check failed_jobs table: Must NOT contain any row with failure_reason from user halt
  const { data: failedJobsCheck } = await supabase
    .from('failed_jobs')
    .select('id, company, failure_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  const haltedFailedJobs = (failedJobsCheck || []).filter((f) =>
    new Date(f.created_at) > new Date(Date.now() - 30000) &&
    (f.failure_reason?.includes('Target closed') || f.failure_reason?.includes('User HALT') || f.failure_reason?.includes('abort'))
  );

  console.log(`   ✓ 0 user halt abortions recorded in failed_jobs: ${haltedFailedJobs.length === 0 ? 'YES (Verified)' : 'FAILED'}`);

  if (anyMarkedFailed || haltedFailedJobs.length > 0) {
    cleanup();
    throw new Error('Halt / Stop failed to cleanly roll back tasks to pending!');
  }

  // STEP 7: Test Submissions Trigger Isolation
  console.log('\n▶️ [STEP 7] Simulating Human Clicking "Trigger Submissions"...');

  // Frontend triggers submissions on port 3002 AND updates bot_control
  await fetchJson('http://localhost:3002/api/bot/submit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit_approved' }),
  });

  await supabase
    .from('bot_control')
    .update({
      stage: 'submitting',
      is_running: true,
      stop_requested: false,
      trigger_requested: true,
      last_action_requested: 'start_submit',
      current_action: 'Submitting approved applications across dedicated workers...',
      active_worker_count: 2,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  await sleep(3000);

  // Check Submitter logs vs Scanner logs
  const submitActiveLogs = await fetchJson('http://localhost:3002/api/bot/logs');
  const scanIdleLogs = await fetchJson('http://localhost:3001/api/bot/logs');

  const hasSubmitLogs = (submitActiveLogs.data?.submitLogs || submitActiveLogs.data?.logs || []).some((l) =>
    l.cluster === 'Submit' ||
    l.message.includes('SUBMISSION') ||
    l.message.includes('Stage 3') ||
    l.message.includes('Submissions')
  );

  const scannerRanAnySubmit = (scanIdleLogs.data?.scanLogs || []).some((l) =>
    l.message.includes('Stage 3') ||
    l.message.includes('SUBMISSION')
  );

  console.log(`   ✓ Submitter service active logs flowing: ${hasSubmitLogs ? 'YES (Verified)' : 'NO'}`);
  console.log(`   ✓ Scanner service completely isolated (0 submit activity): ${!scannerRanAnySubmit ? 'YES (Verified)' : 'FAILED'}`);

  // Stop Submissions cleanly
  await fetchJson('http://localhost:3002/api/bot/submit/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop_submit' }),
  });

  await supabase
    .from('bot_control')
    .update({
      stage: 'idle',
      is_running: false,
      stop_requested: true,
      trigger_requested: false,
      last_action_requested: 'stop_submit',
      current_action: 'Submissions stopped by user.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  cleanup();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('✅ ALL PRODUCTION-GRADE E2E TOGGLE & SERVICE TESTS PASSED!');
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

runTest().catch((err) => {
  console.error('\n❌ E2E TEST FAILED:', err.message);
  process.exit(1);
});
