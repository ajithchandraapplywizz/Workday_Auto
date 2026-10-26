/**
 * run_10_tasks_3_workers.mjs
 * 
 * Takes 10 eligible tasks from expired_and_restarted_applications.csv
 * and applies them concurrently across 3 workers (submitting_worker_1, submitting_worker_2, submitting_worker_3).
 * 
 * Strict Zero Local Screenshots Policy:
 * - All screenshots are stored in Supabase Storage directly from in-memory buffers.
 * - No screenshots written to local disk.
 */

import fs from 'fs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { executeWorkerTask } from '../lib/workerPool.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const WORKER_COUNT = 3;
const WORKER_IDS = ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'];

// Parse CSV
const content = fs.readFileSync('expired_and_restarted_applications.csv', 'utf8');
const lines = content.trim().split('\n').slice(1);
const csvRows = lines.map(l => {
  const parts = l.split('","').map(p => p.replace(/^"|"$/g, ''));
  return {
    source: parts[0],
    id: parts[1],
    distId: parts[2],
    awlId: parts[3],
    company: parts[4],
    role: parts[5],
    status: parts[6],
    error: parts[7],
    url: parts[9],
  };
});

async function getEligibleTasks(limit = 10) {
  const taskIds = csvRows.map(r => r.id);
  const { data: liveTasks } = await supabase
    .from('submission_tasks')
    .select('id, status, error_message, applywizz_id, company, role_title, job_url, distribution_id')
    .in('id', taskIds);

  const statusMap = new Map();
  for (const t of liveTasks || []) {
    statusMap.set(t.id, t.status);
  }

  // Also check job_distributions status
  const distIds = csvRows.map(r => r.distId).filter(Boolean);
  const { data: liveDists } = await supabase
    .from('job_distributions')
    .select('id, status')
    .in('id', distIds);

  const distStatusMap = new Map();
  for (const d of liveDists || []) {
    distStatusMap.set(d.id, d.status);
  }

  const eligible = [];
  for (const r of csvRows) {
    const taskStatus = statusMap.get(r.id) || r.status;
    const distStatus = distStatusMap.get(r.distId);
    if (
      taskStatus !== 'submitted' &&
      taskStatus !== 'already_applied' &&
      distStatus !== 'submitted' &&
      distStatus !== 'already_applied'
    ) {
      eligible.push({
        taskId: r.id,
        distributionId: r.distId,
        applywizzId: r.awlId,
        company: r.company,
        roleTitle: r.role,
        jobUrl: r.url,
      });
    }
  }

  return eligible.slice(0, limit);
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🚀 [3-Worker Runner] Starting execution for 10 tasks across 3 workers`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const tasksToRun = await getEligibleTasks(10);
  console.log(`Found ${tasksToRun.length} eligible tasks to process:`);
  tasksToRun.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.applywizzId}] ${t.company} - ${t.roleTitle} (task: ${t.taskId})`);
  });

  if (tasksToRun.length === 0) {
    console.log(`No eligible tasks to run! All selected tasks may already be submitted.`);
    return;
  }

  // Queue of tasks
  const queue = [...tasksToRun];
  const results = [];
  let completedCount = 0;

  // Worker loop
  async function runWorker(workerId, workerIndex) {
    console.log(`[${workerId}] Worker started.`);
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;

      const taskNum = ++completedCount;
      console.log(`\n⚡ [${workerId}] Picking up task ${taskNum}/${tasksToRun.length}: ${task.applywizzId} @ ${task.company}`);

      const now = new Date().toISOString();

      try {
        await supabase
          .from('submission_tasks')
          .update({
            status: 'applying',
            worker_id: workerId,
            started_at: now,
            worker_leased_at: now,
            updated_at: now,
          })
          .eq('id', task.taskId);
      } catch (_) { }

      if (task.distributionId) {
        try {
          await supabase
            .from('job_distributions')
            .update({
              status: 'applying',
              worker_id: workerId,
              updated_at: now,
            })
            .eq('id', task.distributionId);
        } catch (_) { }
      }

      let res;
      try {
        res = await executeWorkerTask({
          task: {
            id: task.distributionId,
            distributionId: task.distributionId,
            taskId: task.taskId,
            applywizzId: task.applywizzId,
            jobUrl: task.jobUrl,
            company: task.company,
            roleTitle: task.roleTitle,
            status: 'approved_for_submission',
          },
          taskId: task.taskId,
          workerId,
          taskIndex: taskNum,
          totalTasks: tasksToRun.length,
          options: {
            headless: process.env.HEADFUL === 'true' ? false : true,
            confirmSubmit: true,
            dryRun: false,
            taskId: task.taskId,
          },
        });
      } catch (err) {
        console.error(`❌ [${workerId}] Task failed with exception:`, err);
        res = { status: 'failed', error: err.message };
      }

      const finalStatus = res?.status || 'failed';
      const proofUrl = res?.screenshotUrl || null;
      console.log(`🏁 [${workerId}] Finished task ${task.applywizzId}: ${finalStatus} (proof: ${proofUrl || 'none'})`);

      // Record in Supabase
      const completedAt = new Date().toISOString();
      const finalError = finalStatus === 'submitted' ? null : (res?.error || res?.reason || `Failed during submission at step: ${res?.stoppedAtStep || 'unknown'}`);

      try {
        await supabase
          .from('submission_tasks')
          .update({
            status: finalStatus,
            error_message: finalError,
            application_submitted_screenshot_url: proofUrl,
            screenshot_url: proofUrl,
            completed_at: completedAt,
            updated_at: completedAt,
          })
          .eq('id', task.taskId);
      } catch (_) { }

      if (task.distributionId) {
        try {
          await supabase
            .from('job_distributions')
            .update({
              status: finalStatus,
              error_message: finalError,
              screenshot_path: proofUrl,
              application_submitted_screenshot_url: proofUrl,
              completed_at: completedAt,
              updated_at: completedAt,
            })
            .eq('id', task.distributionId);
        } catch (_) { }
      }

      if (finalStatus !== 'submitted' && finalStatus !== 'already_applied') {
        try {
          const { recordFailedJob } = await import('../lib/supabaseClient.mjs');
          await recordFailedJob({
            applywizzId: task.applywizzId,
            jobUrl: task.jobUrl,
            company: task.company,
            roleTitle: task.roleTitle,
            failureReason: finalError,
            failedAtStep: res?.stoppedAtStep || 'Submission',
            screenshotPath: proofUrl,
          });
        } catch (_) { }
      }

      results.push({
        taskId: task.taskId,
        applywizzId: task.applywizzId,
        company: task.company,
        status: finalStatus,
        proofUrl,
        error: res?.error || null,
      });
    }
    console.log(`[${workerId}] Queue empty. Worker finished.`);
  }

  // Launch 3 workers concurrently
  const startTime = Date.now();
  await Promise.all(
    WORKER_IDS.slice(0, Math.min(WORKER_COUNT, tasksToRun.length)).map((id, idx) => runWorker(id, idx))
  );

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🏁 [3-Worker Batch] ALL ${tasksToRun.length} TASKS COMPLETED in ${durationSec}s`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.applywizzId}] ${r.company} -> ${r.status} ${r.proofUrl ? `(proof: ${r.proofUrl})` : ''} ${r.error ? `(err: ${r.error})` : ''}`);
  });

  const submittedCount = results.filter(r => r.status === 'submitted').length;
  const alreadyAppliedCount = results.filter(r => r.status === 'already_applied').length;
  const failedCount = results.filter(r => r.status === 'failed').length;

  console.log(`\nSummary: ${submittedCount} submitted, ${alreadyAppliedCount} already applied, ${failedCount} failed.`);
}

main().catch(console.error);
