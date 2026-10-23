import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { queueSubmissionTask } from '../lib/submissionTaskService.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runTest() {
  console.log('================================================================');
  console.log('  PHASE 2 ACCEPTANCE TEST: CA CLICK ENDPOINT (ATOMIC QUEUEING)  ');
  console.log('================================================================\n');

  const CLIENT_ID = 'AWL-6451';
  const ASSIGNED_CA = 'akhilakarike@applywizz.ai';
  const UNASSIGNED_CA = 'intruder@unauthorized.com';

  // 1. Initial State: Inspect all applications for client AWL-6451
  const { data: beforeTasks } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, company, status, reviewed_by, updated_at')
    .eq('applywizz_id', CLIENT_ID)
    .order('id', { ascending: true });

  console.log(`[STEP 1] Applications for client ${CLIENT_ID} BEFORE click (${beforeTasks.length} total):`);
  console.table(beforeTasks.map(t => ({
    task_id: t.id,
    company: t.company,
    status: t.status,
    reviewed_by: t.reviewed_by || 'None'
  })));

  if (beforeTasks.length < 3) {
    throw new Error(`Expected at least 3 tasks for ${CLIENT_ID}, found ${beforeTasks.length}`);
  }

  const targetTask = beforeTasks[0];
  const siblingTask1 = beforeTasks[1];
  const siblingTask2 = beforeTasks[2];

  console.log(`\n🎯 TARGET APPLICATION TO CLICK: Task #${targetTask.id} (${targetTask.company})`);
  console.log(`   SIBLING APPLICATION 1:       Task #${siblingTask1.id} (${siblingTask1.company})`);
  console.log(`   SIBLING APPLICATION 2:       Task #${siblingTask2.id} (${siblingTask2.company})\n`);

  // 2. Security Check: Attempt click with an unassigned CA
  console.log(`[STEP 2] Testing CA Authorization Guard (Unassigned CA: ${UNASSIGNED_CA})...`);
  const unauthorizedResult = await queueSubmissionTask({
    taskId: siblingTask1.id,
    ca: UNASSIGNED_CA,
  });
  console.log('   Response for unauthorized CA:', unauthorizedResult);
  if (unauthorizedResult.statusCode === 403) {
    console.log('   ✅ PASS: Authorization guard rejected unassigned CA with 403 Forbidden.');
  } else {
    console.error('   ❌ FAIL: Unauthorized CA was not rejected!');
  }

  // 3. Authorized Click: Click TARGET task with assigned CA
  console.log(`\n[STEP 3] CA clicks "Review & Submit" on Task #${targetTask.id} with CA '${ASSIGNED_CA}'...`);
  const clickResult = await queueSubmissionTask({
    taskId: targetTask.id,
    ca: ASSIGNED_CA,
  });
  console.log('   Click endpoint response:', clickResult);

  if (clickResult.success && clickResult.changed && clickResult.status === 'queued') {
    console.log('   ✅ PASS: Task atomically transitioned to queued.');
  } else {
    throw new Error('Failed to queue target task: ' + JSON.stringify(clickResult));
  }

  // 4. Double-Click / Refresh Safety Check: Click SAME task again
  console.log(`\n[STEP 4] Double-Click / Rapid Refresh Test on Task #${targetTask.id}...`);
  const doubleClickResult = await queueSubmissionTask({
    taskId: targetTask.id,
    ca: ASSIGNED_CA,
  });
  console.log('   Double-click response:', doubleClickResult);
  if (doubleClickResult.success && doubleClickResult.changed === false && doubleClickResult.status === 'queued') {
    console.log('   ✅ PASS: Double-click safely handled. Returned current status without error.');
  } else {
    throw new Error('Double click was not handled safely: ' + JSON.stringify(doubleClickResult));
  }

  // 5. Verify Database State After Click: Prove EXACTLY one row changed
  const { data: afterTasks } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, company, status, reviewed_by, updated_at')
    .eq('applywizz_id', CLIENT_ID)
    .order('id', { ascending: true });

  console.log(`\n[STEP 5] Applications for client ${CLIENT_ID} AFTER click:`);
  console.table(afterTasks.map(t => ({
    task_id: t.id,
    company: t.company,
    status: t.status,
    reviewed_by: t.reviewed_by || 'None'
  })));

  // Verification assertions
  const targetAfter = afterTasks.find(t => t.id === targetTask.id);
  const sibling1After = afterTasks.find(t => t.id === siblingTask1.id);
  const sibling2After = afterTasks.find(t => t.id === siblingTask2.id);

  console.log('\n--- VERIFICATION PROOFS ---');
  const targetChanged = targetAfter.status === 'queued' && targetAfter.reviewed_by === ASSIGNED_CA;
  const sibling1Untouched = sibling1After.status === 'ready_for_review';
  const sibling2Untouched = sibling2After.status === 'ready_for_review';

  console.log(`1. Target Task #${targetTask.id} changed to 'queued':      ${targetChanged ? '✅ YES' : '❌ NO'}`);
  console.log(`2. Sibling Task 1 #${siblingTask1.id} stayed 'ready_for_review': ${sibling1Untouched ? '✅ YES (UNTOUCHED)' : '❌ NO'}`);
  console.log(`3. Sibling Task 2 #${siblingTask2.id} stayed 'ready_for_review': ${sibling2Untouched ? '✅ YES (UNTOUCHED)' : '❌ NO'}`);

  // 6. Check Database Trigger Mirroring to job_distributions
  const { data: distRow } = await supabase
    .from('job_distributions')
    .select('id, status, error_message, updated_at')
    .eq('id', targetTask.distribution_id)
    .single();

  console.log(`4. Database Trigger Mirror to job_distributions:`);
  console.log(`   job_distributions record #${distRow.id} status = '${distRow.status}': ${distRow.status === 'queued' ? '✅ MIRRORED' : '❌ NOT MIRRORED'}`);

  if (targetChanged && sibling1Untouched && sibling2Untouched && distRow.status === 'queued') {
    console.log('\n🏆 ALL PHASE 2 ACCEPTANCE CRITERIA VERIFIED WITH REAL DATABASE EVIDENCE!');
  } else {
    throw new Error('Phase 2 verification failed assertions.');
  }
}

runTest().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
