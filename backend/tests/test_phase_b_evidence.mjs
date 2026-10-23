import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { processClaimedTask, updateSubmissionTaskWithCheck } from '../lib/submissionWorkerPool.mjs';
import { recoverInterruptedSubmissionTasks } from '../scripts/queue_daemon.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runPhaseBEvidence() {
  console.log('================================================================');
  console.log('  PHASE B EVIDENCE RUNNER (SAFETY-COMPLIANT MOCK WORKER TEST)');
  console.log('  Rule: No live submit endpoints called, no real applications touched.');
  console.log('================================================================\n');

  const workerId = 'submitting_worker_1';
  const testCandidateId = 'AWL-TEST-PHASE-B';
  const now = new Date().toISOString();

  // 1. Create isolated test row in submission_tasks
  console.log('Creating isolated test task in submission_tasks...');
  const { data: inserted, error: insErr } = await supabase
    .from('submission_tasks')
    .insert({
      applywizz_id: testCandidateId,
      job_url: 'https://safety-test.workday.com/job/test-phase-b',
      company: 'Phase B Safety Test Inc',
      role_title: 'Software Test Safety Engineer',
      status: 'applying',
      worker_id: workerId,
      started_at: now,
      worker_leased_at: now,
    })
    .select('*');

  if (insErr || !inserted || inserted.length === 0) {
    console.error('❌ Failed to insert test task:', insErr?.message);
    process.exit(1);
  }

  const testTask = inserted[0];
  console.log(`✅ Created test task #${testTask.id} (status: applying, worker: ${workerId})\n`);

  try {
    // --------------------------------------------------------------------------
    // EVIDENCE (a): Task that fails and ends 'failed' with screenshot URL on its own row
    // --------------------------------------------------------------------------
    console.log('----------------------------------------------------------------');
    console.log('EVIDENCE (a): Task execution failure with screenshot URL on task row');
    console.log('----------------------------------------------------------------');

    // Simulate upload of failure screenshot for this task
    const timestamp = Date.now();
    const fakeBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2d400000000049454e44ae426082', 'hex'); // valid 1x1 png
    const shotPath = `${testCandidateId}/${testTask.id}_failed_${timestamp}.png`;
    const { error: upErr } = await supabase.storage
      .from('submitted-applications')
      .upload(shotPath, fakeBuffer, { contentType: 'image/png', upsert: true });

    if (upErr) {
      console.warn('Storage upload note:', upErr.message);
    } else {
      console.log(`[${workerId}] screenshot uploaded: ${shotPath}`);
    }

    const { data: urlData } = supabase.storage
      .from('submitted-applications')
      .getPublicUrl(shotPath);
    const shotUrl = urlData?.publicUrl || null;

    // Run processClaimedTask with simulated runner that ends in failure with screenshot
    const resA = await processClaimedTask({
      task: testTask,
      workerId,
      runnerFn: async () => {
        return {
          status: 'failed',
          error: 'Workday validation error: required question unanswered',
          screenshotUrl: shotUrl,
          screenshotPath: shotPath,
        };
      },
    });

    // Fetch and display the updated submission_tasks row
    const { data: rowA } = await supabase
      .from('submission_tasks')
      .select('id, applywizz_id, status, error_message, application_submitted_screenshot_url, screenshot_path, worker_id, updated_at')
      .eq('id', testTask.id)
      .single();

    console.log('\n[EVIDENCE a] submission_tasks row after execution failure:');
    console.log(JSON.stringify(rowA, null, 2));
    console.log('\n');

    // --------------------------------------------------------------------------
    // EVIDENCE (b): Forced hang stopped by the 8-minute watchdog
    // --------------------------------------------------------------------------
    console.log('----------------------------------------------------------------');
    console.log('EVIDENCE (b): Forced hang stopped by task watchdog');
    console.log('----------------------------------------------------------------');

    // Reset task row back to applying for worker
    await supabase
      .from('submission_tasks')
      .update({
        status: 'applying',
        worker_id: workerId,
        error_message: null,
        worker_leased_at: new Date().toISOString(),
      })
      .eq('id', testTask.id);

    // Run with forced hang runner and 1500ms watchdog limit
    const resB = await processClaimedTask({
      task: testTask,
      workerId,
      options: { watchdogTimeoutMs: 1500 },
      runnerFn: async () => {
        // Hang forever
        await new Promise((r) => setTimeout(r, 60000));
        return { status: 'submitted' };
      },
    });

    const { data: rowB } = await supabase
      .from('submission_tasks')
      .select('id, applywizz_id, status, error_message, application_submitted_screenshot_url, screenshot_path, worker_id, updated_at')
      .eq('id', testTask.id)
      .single();

    console.log('\n[EVIDENCE b] submission_tasks row after watchdog timeout:');
    console.log(JSON.stringify(rowB, null, 2));
    console.log('\n');

    // --------------------------------------------------------------------------
    // EVIDENCE (c): Daemon restart startup recovery of applying rows
    // --------------------------------------------------------------------------
    console.log('----------------------------------------------------------------');
    console.log('EVIDENCE (c): Daemon restart recovery of applying rows');
    console.log('----------------------------------------------------------------');

    // Put task back into applying state as if worker was interrupted by SIGTERM
    await supabase
      .from('submission_tasks')
      .update({
        status: 'applying',
        worker_id: workerId,
        error_message: null,
        worker_leased_at: new Date().toISOString(),
      })
      .eq('id', testTask.id);

    // Call startup recovery function
    const recoveryCount = await recoverInterruptedSubmissionTasks();

    const { data: rowC } = await supabase
      .from('submission_tasks')
      .select('id, applywizz_id, status, error_message, application_submitted_screenshot_url, screenshot_path, worker_id, updated_at')
      .eq('id', testTask.id)
      .single();

    console.log('\n[EVIDENCE c] submission_tasks row after daemon restart recovery:');
    console.log(JSON.stringify(rowC, null, 2));
    console.log('\n');

  } finally {
    // --------------------------------------------------------------------------
    // RESTORE / CLEANUP
    // --------------------------------------------------------------------------
    console.log('----------------------------------------------------------------');
    console.log('CLEANUP: Restoring database state (removing safety test task)...');
    console.log('----------------------------------------------------------------');
    await supabase.from('submission_tasks').delete().eq('id', testTask.id);
    try {
      await supabase.storage.from('submitted-applications').remove([`${testCandidateId}/${testTask.id}_failed_${timestamp}.png`]);
    } catch {}
    console.log('✅ Safety cleanup complete. Database restored to original state.');
  }
}

runPhaseBEvidence().catch((err) => {
  console.error('Evidence run error:', err);
  process.exit(1);
});
