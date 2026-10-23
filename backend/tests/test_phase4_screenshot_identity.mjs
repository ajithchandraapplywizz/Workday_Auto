import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { claimNextTask } from '../lib/submissionWorkerPool.mjs';
import { recordTaskSubmissionProof, BUCKET_NAME } from '../lib/submissionScreenshotService.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper to generate a minimal valid 1x1 PNG image buffer
function createSamplePngBuffer(label = '') {
  // 1x1 transparent PNG header + IHDR + IDAT + IEND
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // 8-bit RGBA
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND chunk
    0x42, 0x60, 0x82,
  ]);
}

async function runTest() {
  console.log('================================================================');
  console.log('  PHASE 4 ACCEPTANCE TEST: DETERMINISTIC SCREENSHOT IDENTITY   ');
  console.log('================================================================\n');

  const CLIENT_ID = 'AWL-6451';

  // 1. Find 2 ready_for_review tasks for the SAME client
  const { data: clientTasks } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, company, status')
    .eq('applywizz_id', CLIENT_ID)
    .order('id', { ascending: true })
    .limit(2);

  if (!clientTasks || clientTasks.length < 2) {
    throw new Error(`Client ${CLIENT_ID} must have at least 2 tasks, found ${clientTasks?.length}`);
  }

  const [task1, task2] = clientTasks;
  console.log(`[STEP 1] Selected 2 applications for client ${CLIENT_ID}:`);
  console.log(`   Task 1: #${task1.id} (${task1.company})`);
  console.log(`   Task 2: #${task2.id} (${task2.company})\n`);

  // Reset both tasks to queued state
  const now = new Date().toISOString();
  await supabase
    .from('submission_tasks')
    .update({ status: 'queued', worker_id: null, worker_leased_at: null, updated_at: now })
    .in('id', [task1.id, task2.id]);

  // 2. Worker 1 claims Task 1
  console.log('[STEP 2] Submitting Worker 1 claims Task 1...');
  const claimed1 = await claimNextTask('submitting_worker_1');
  console.log(`   Claimed Task 1 ID: #${claimed1?.id} by worker: ${claimed1?.worker_id}`);

  // 3. Worker 1 uploads screenshot and records submission proof for Task 1
  console.log(`\n[STEP 3] Worker 1 captures and records submission proof for Task #${claimed1.id}...`);
  const pngBuffer1 = createSamplePngBuffer('Proof 1');
  const result1 = await recordTaskSubmissionProof({
    taskId: claimed1.id,
    applywizzId: claimed1.applywizz_id,
    workerId: 'submitting_worker_1',
    imageBuffer: pngBuffer1,
  });

  console.log('   Result 1:', {
    taskId: result1.taskId,
    path: result1.screenshotPath,
    url: result1.screenshotUrl,
  });

  // 4. Worker 2 claims Task 2
  console.log('\n[STEP 4] Submitting Worker 2 claims Task 2...');
  const claimed2 = await claimNextTask('submitting_worker_2');
  console.log(`   Claimed Task 2 ID: #${claimed2?.id} by worker: ${claimed2?.worker_id}`);

  // 5. Worker 2 uploads screenshot and records submission proof for Task 2
  console.log(`\n[STEP 5] Worker 2 captures and records submission proof for Task #${claimed2.id}...`);
  const pngBuffer2 = createSamplePngBuffer('Proof 2');
  const result2 = await recordTaskSubmissionProof({
    taskId: claimed2.id,
    applywizzId: claimed2.applywizz_id,
    workerId: 'submitting_worker_2',
    imageBuffer: pngBuffer2,
  });

  console.log('   Result 2:', {
    taskId: result2.taskId,
    path: result2.screenshotPath,
    url: result2.screenshotUrl,
  });

  // 6. Query both submitted tasks from database to verify evidence
  console.log('\n[STEP 6] Querying database for both submitted applications...');
  const { data: verifiedTasks } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, company, status, worker_id, screenshot_path, application_submitted_screenshot_url, completed_at')
    .in('id', [claimed1.id, claimed2.id])
    .order('id', { ascending: true });

  console.table(verifiedTasks.map(t => ({
    task_id: t.id,
    client: t.applywizz_id,
    status: t.status,
    file_path: t.screenshot_path,
    screenshot_url: t.application_submitted_screenshot_url?.slice(0, 75) + '...',
  })));

  // Verification Assertions
  const v1 = verifiedTasks.find(t => t.id === claimed1.id);
  const v2 = verifiedTasks.find(t => t.id === claimed2.id);

  console.log('\n--- VERIFICATION PROOFS ---');
  const sameClient = v1.applywizz_id === v2.applywizz_id && v1.applywizz_id === CLIENT_ID;
  const bothSubmitted = v1.status === 'submitted' && v2.status === 'submitted';
  const differentPaths = v1.screenshot_path !== v2.screenshot_path;
  const differentUrls = v1.application_submitted_screenshot_url !== v2.application_submitted_screenshot_url;
  const path1MatchesTask1 = v1.screenshot_path.includes(v1.id) && v1.screenshot_path.endsWith(`${v1.id}.png`);
  const path2MatchesTask2 = v2.screenshot_path.includes(v2.id) && v2.screenshot_path.endsWith(`${v2.id}.png`);
  const url1MatchesTask1 = v1.application_submitted_screenshot_url.includes(v1.id);
  const url2MatchesTask2 = v2.application_submitted_screenshot_url.includes(v2.id);

  console.log(`1. Both tasks belong to the exact same client (${CLIENT_ID}):         ${sameClient ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`2. Both tasks have status = 'submitted':                            ${bothSubmitted ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`3. Two completely different screenshot file paths:                   ${differentPaths ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`4. Two completely different public URLs:                             ${differentUrls ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`5. File 1 deterministic name matches Task 1 ID (${v1.id}.png):       ${path1MatchesTask1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`6. File 2 deterministic name matches Task 2 ID (${v2.id}.png):       ${path2MatchesTask2 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`7. URL 1 explicitly contains Task 1 ID:                               ${url1MatchesTask1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`8. URL 2 explicitly contains Task 2 ID:                               ${url2MatchesTask2 ? '✅ PASS' : '❌ FAIL'}`);

  // 7. Check trigger mirror on job_distributions
  const { data: jdRows } = await supabase
    .from('job_distributions')
    .select('id, status, application_submitted_screenshot_url')
    .in('id', [v1.distribution_id, v2.distribution_id]);

  console.log(`\n9. Database Trigger Mirroring to job_distributions:`);
  console.table(jdRows);
  const jdMirrored = jdRows.every(r => r.status === 'submitted' && Boolean(r.application_submitted_screenshot_url));
  console.log(`   Trigger mirror check: ${jdMirrored ? '✅ PASS (Both URLs mirrored to job_distributions)' : '❌ FAIL'}`);

  if (sameClient && bothSubmitted && differentPaths && differentUrls && path1MatchesTask1 && path2MatchesTask2 && jdMirrored) {
    console.log('\n🏆 ALL PHASE 4 ACCEPTANCE CRITERIA VERIFIED WITH REAL DATABASE EVIDENCE!');
  } else {
    throw new Error('Phase 4 verification failed assertions');
  }

  // Clean up test tasks back to clean state
  await supabase
    .from('submission_tasks')
    .update({
      status: 'ready_for_review',
      worker_id: null,
      worker_leased_at: null,
      screenshot_path: null,
      application_submitted_screenshot_url: null,
      completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .in('id', [v1.id, v2.id]);

  // Clean up job_distributions
  await supabase
    .from('job_distributions')
    .update({
      status: 'ready_for_review',
      worker_id: null,
      worker_leased_at: null,
      application_submitted_screenshot_url: null,
      updated_at: new Date().toISOString(),
    })
    .in('id', [v1.distribution_id, v2.distribution_id]);
}

runTest().catch((err) => {
  console.error('\n❌ Phase 4 test failed:', err);
  process.exit(1);
});
