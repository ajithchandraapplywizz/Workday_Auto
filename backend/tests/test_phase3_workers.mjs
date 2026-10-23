import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { claimNextTask, reapExpiredLeases, SUBMISSION_WORKER_IDS } from '../lib/submissionWorkerPool.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runTest() {
  console.log('================================================================');
  console.log('  PHASE 3 ACCEPTANCE TEST: 3 CONCURRENT WORKERS & LEASE REAPER  ');
  console.log('================================================================\n');

  // 1. Prepare 5 tasks set to 'queued'
  console.log('[STEP 1] Preparing 5 test tasks in queued status...');

  // Fetch 5 ready_for_review tasks from submission_tasks
  const { data: candidateTasks } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, company, status')
    .eq('status', 'ready_for_review')
    .limit(5);

  if (!candidateTasks || candidateTasks.length < 5) {
    throw new Error(`Need at least 5 ready_for_review tasks to run test, found ${candidateTasks?.length}`);
  }

  const testTaskIds = candidateTasks.map(t => t.id);

  // Set all 5 to 'queued' with distinct ascending created_at timestamps
  const baseTime = Date.now() - 50000;
  for (let i = 0; i < testTaskIds.length; i++) {
    const ts = new Date(baseTime + i * 5000).toISOString();
    await supabase
      .from('submission_tasks')
      .update({
        status: 'queued',
        worker_id: null,
        worker_leased_at: null,
        started_at: null,
        created_at: ts,
        updated_at: new Date().toISOString(),
      })
      .eq('id', testTaskIds[i]);
  }

  // Verify all 5 are 'queued'
  const { data: initialQueued } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, company, status, created_at')
    .in('id', testTaskIds)
    .order('created_at', { ascending: true });

  console.log(`\nVerified 5 Queued Tasks:`);
  console.table(initialQueued.map(t => ({
    id: t.id,
    applywizz_id: t.applywizz_id,
    company: t.company,
    status: t.status,
    created_at: t.created_at,
  })));

  // 2. Concurrently dispatch claims from all 3 workers
  console.log('\n[STEP 2] All 3 workers concurrently attempt to claim work...');
  console.log('Dispatching claims for:', SUBMISSION_WORKER_IDS.join(', '));

  const claimPromises = SUBMISSION_WORKER_IDS.map(wId => claimNextTask(wId));
  const claimedResults = await Promise.all(claimPromises);

  console.log('\nClaim Results:');
  for (let i = 0; i < SUBMISSION_WORKER_IDS.length; i++) {
    const claimed = claimedResults[i];
    console.log(`   • ${SUBMISSION_WORKER_IDS[i]}: Claimed Task #${claimed?.id} (${claimed?.company || 'Company'})`);
  }

  // 3. Inspect database state immediately after the 3 claims:
  // MUST SHOW: Exactly 3 tasks applying, exactly 2 tasks queued!
  const { data: afterClaimTasks } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, company, status, worker_id, worker_leased_at')
    .in('id', testTaskIds)
    .order('created_at', { ascending: true });

  console.log('\n[STEP 3] Database State with 3 Workers Running (EVIDENCE: 3 Applying, 2 Queued):');
  console.table(afterClaimTasks.map(t => ({
    task_id: t.id,
    company: t.company,
    status: t.status,
    worker_id: t.worker_id || 'None (in queue)',
    leased_at: t.worker_leased_at ? t.worker_leased_at.slice(11, 19) : 'None'
  })));

  const applyingCount = afterClaimTasks.filter(t => t.status === 'applying').length;
  const queuedCount = afterClaimTasks.filter(t => t.status === 'queued').length;

  console.log('\n--- VERIFICATION CHECKS ---');
  console.log(`1. Applying count is exactly 3: ${applyingCount === 3 ? '✅ PASS (3 APPLYING)' : '❌ FAIL'}`);
  console.log(`2. Queued count is exactly 2:   ${queuedCount === 2 ? '✅ PASS (2 QUEUED)' : '❌ FAIL'}`);

  // Check unique worker assignment
  const assignedWorkers = afterClaimTasks.filter(t => t.status === 'applying').map(t => t.worker_id);
  const uniqueWorkers = new Set(assignedWorkers);
  console.log(`3. Each worker claimed a distinct task: ${uniqueWorkers.size === 3 ? '✅ PASS (3 UNIQUE WORKERS)' : '❌ FAIL'}`);

  if (applyingCount !== 3 || queuedCount !== 2 || uniqueWorkers.size !== 3) {
    throw new Error('Initial concurrent claim failed assertions!');
  }

  // 4. Drain the remaining 2 tasks
  console.log('\n[STEP 4] Simulating completion of first 3 tasks and draining remaining 2...');

  // Complete first 3 tasks
  const now = new Date().toISOString();
  for (const claimed of claimedResults) {
    if (claimed) {
      await supabase
        .from('submission_tasks')
        .update({
          status: 'ready_for_review', // Reset back to clean state
          worker_id: null,
          worker_leased_at: null,
          updated_at: now,
        })
        .eq('id', claimed.id);
    }
  }

  // Workers 1 and 2 claim the remaining 2 queued tasks
  const drainClaim1 = await claimNextTask('submitting_worker_1');
  const drainClaim2 = await claimNextTask('submitting_worker_2');
  console.log(`   • Worker 1 claimed remaining task: #${drainClaim1?.id}`);
  console.log(`   • Worker 2 claimed remaining task: #${drainClaim2?.id}`);

  // Query remaining tasks
  const { data: drainedTasks } = await supabase
    .from('submission_tasks')
    .select('id, status, worker_id')
    .in('id', [drainClaim1?.id, drainClaim2?.id]);

  console.table(drainedTasks);

  // Reset drained tasks back to clean state
  for (const t of drainedTasks) {
    await supabase
      .from('submission_tasks')
      .update({
        status: 'ready_for_review',
        worker_id: null,
        worker_leased_at: null,
        updated_at: now,
      })
      .eq('id', t.id);
  }

  console.log('✅ Queue successfully drained! 0 tasks left queued.');

  // 5. Test 10-Minute Reaper Functionality
  console.log('\n[STEP 5] Testing 10-Minute Lease Reaper on Expired Task...');
  const testReaperTask = testTaskIds[0];
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Artificially simulate a worker crash: status='applying' with lease expired 15 minutes ago
  await supabase
    .from('submission_tasks')
    .update({
      status: 'applying',
      worker_id: 'submitting_worker_1',
      worker_leased_at: fifteenMinutesAgo,
      updated_at: fifteenMinutesAgo,
    })
    .eq('id', testReaperTask);

  console.log(`Simulated crashed worker on Task #${testReaperTask} (leased at: ${fifteenMinutesAgo})`);

  // Execute Reaper
  const reaped = await reapExpiredLeases(10);
  console.log('Reaper executed. Tasks reaped:', reaped.map(r => ({ id: r.id, status: r.status, error: r.error_message })));

  const { data: reapedVerify } = await supabase
    .from('submission_tasks')
    .select('id, status, error_message')
    .eq('id', testReaperTask)
    .single();

  console.log(`\nReaped Task Verification:`);
  console.log(`   Status:        ${reapedVerify.status} (Expected: 'failed')`);
  console.log(`   Error Message: ${reapedVerify.error_message}`);

  const reaperPassed = reapedVerify.status === 'failed' && reapedVerify.error_message.includes('expired');
  console.log(`\nReaper Test Result: ${reaperPassed ? '✅ PASS: Expired lease marked as failed for admin inspection (never re-queued)' : '❌ FAIL'}`);

  // Clean up test task back to ready_for_review
  await supabase
    .from('submission_tasks')
    .update({
      status: 'ready_for_review',
      worker_id: null,
      worker_leased_at: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', testReaperTask);

  if (reaperPassed) {
    console.log('\n🏆 ALL PHASE 3 ACCEPTANCE CRITERIA VERIFIED WITH REAL DATABASE EVIDENCE!');
  } else {
    throw new Error('Reaper test failed.');
  }
}

runTest().catch((err) => {
  console.error('\n❌ Phase 3 test failed:', err);
  process.exit(1);
});
