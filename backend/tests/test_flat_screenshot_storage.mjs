import { recordTaskSubmissionProof, BUCKET_NAME } from '../lib/submissionScreenshotService.mjs';
import { getCleanSupabaseEnv } from '../lib/clusterBatchRunner.mjs';
import { createClient } from '@supabase/supabase-js';

const { url, key } = getCleanSupabaseEnv();
const supabase = createClient(url, key);

function createSamplePngBuffer() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

async function testFlatScreenshotStorage() {
  console.log('=== TEST: FLAT SCREENSHOT STORAGE (ZERO NESTED FOLDERS) ===');

  // Find 1 task in submission_tasks to test with
  const { data: testTask, error: findErr } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, company, status')
    .limit(1)
    .single();

  if (findErr || !testTask) {
    throw new Error('Could not find a task in submission_tasks to test.');
  }

  console.log(`Using Task #${testTask.id} (AWL: ${testTask.applywizz_id}, Company: ${testTask.company})`);

  // Ensure task is in 'applying' state leased by test worker
  const testWorkerId = 'submitting_worker_test';
  await supabase
    .from('submission_tasks')
    .update({ status: 'applying', worker_id: testWorkerId, updated_at: new Date().toISOString() })
    .eq('id', testTask.id);

  const pngBuffer = createSamplePngBuffer();
  const proofResult = await recordTaskSubmissionProof({
    taskId: testTask.id,
    applywizzId: testTask.applywizz_id,
    company: testTask.company,
    workerId: testWorkerId,
    imageBuffer: pngBuffer,
  });

  console.log('\n--- UPLOAD PROOF RESULTS ---');
  console.log('Storage Path:', proofResult.screenshotPath);
  console.log('Public URL:  ', proofResult.screenshotUrl);

  // Assertions
  const hasNoForwardSlashes = !proofResult.screenshotPath.includes('/');
  const containsAwl = proofResult.screenshotPath.includes(testTask.applywizz_id.replace(/["'\[\]\\]/g, ''));
  const containsTaskId = proofResult.screenshotPath.includes(String(testTask.id));

  console.log('\n--- ASSERTIONS ---');
  console.log(`1. Path is flat in root (NO slashes/subfolders): ${hasNoForwardSlashes ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`2. Path contains clean AWL ID:                   ${containsAwl ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`3. Path contains deterministic Task ID:          ${containsTaskId ? '✅ PASS' : '❌ FAIL'}`);

  // Check Supabase DB row
  const { data: verifiedRow } = await supabase
    .from('submission_tasks')
    .select('id, status, application_submitted_screenshot_url')
    .eq('id', testTask.id)
    .single();

  const urlPersisted = verifiedRow?.application_submitted_screenshot_url === proofResult.screenshotUrl;
  console.log(`4. Public URL persisted on submission_tasks:     ${urlPersisted ? '✅ PASS' : '❌ FAIL'}`);

  if (hasNoForwardSlashes && containsAwl && containsTaskId && urlPersisted) {
    console.log('\n🎉 Flat screenshot storage verified with 100% PASS!');
  } else {
    throw new Error('Flat screenshot storage test failed assertions.');
  }
}

testFlatScreenshotStorage().catch((err) => {
  console.error('\n❌ Test Error:', err.message);
  process.exit(1);
});
