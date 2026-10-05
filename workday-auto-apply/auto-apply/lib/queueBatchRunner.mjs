/**
 * lib/queueBatchRunner.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Terminal-First Link-Clustered Queue Controller for batch_job_queue
 * ─────────────────────────────────────────────────────────────────────────────
 * Execution Flow:
 *   1. Resets stale statuses for this job_url in batch_job_queue to 'pending'.
 *   2. Sorts candidates numerically by AWL ID (AWL-1568 is #1 Blueprint Leader).
 *   3. PHASE 1: Runs Application 1 (AWL-1568) FIRST:
 *      - Fills form with unique profile facts.
 *      - Fills date phase ("when are you willing to join") with 2-digit padding (04, 16, 2026).
 *      - Reaches Review & Submit -> Scrapes all Q&A from Review DOM into JSON.
 *      - Captures mandatory screenshot -> saves to screenshot_path in Supabase.
 *   4. PHASE 2: Broadcasts scraped Q&A to all remaining 46 tasks in Supabase.
 *   5. PHASE 3: Launches 5 PARALLEL WORKERS to follow Client 1:
 *      - 5 headed browser windows open simultaneously.
 *      - Each worker fills candidates in 5-8s using the pre-resolved Q&A.
 *      - Each candidate keeps their own unique Name, Email, Phone, and Resume.
 *      - Mandatory screenshots captured for every application.
 */

import { executeWorkerTask } from './workerPool.mjs';
import { isSupabaseConfigured } from './supabaseClient.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

async function queueDbRequest(path, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) return null;
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/${path}${query}`,
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body,
    timeoutMs: 20000,
  }, { attempts: 2, label: 'BatchQueue' });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${String(res.text || '').slice(0, 180)}`);
  if (!res.text) return null;
  return res.json();
}

/**
 * Reset all tasks for this job URL to pending so a fresh batch runs cleanly.
 */
export async function resetQueueTasksForUrl(jobUrl) {
  if (!isSupabaseConfigured() || !jobUrl) return;
  try {
    const cleanUrl = encodeURIComponent(String(jobUrl).trim());
    await queueDbRequest('batch_job_queue', {
      method: 'PATCH',
      query: `?job_url=eq.${cleanUrl}`,
      prefer: 'return=minimal',
      body: {
        status: 'pending',
        worker_id: null,
        started_at: null,
        completed_at: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      },
    });
    console.log(`  🔄 Reset all queue tasks for this URL to 'pending' for a clean batch run.`);
  } catch (err) {
    console.log(`  ⚠️ Note on queue reset: ${err.message}`);
  }
}

/**
 * Fetch all tasks for a specific URL from batch_job_queue, sorted numerically by AWL ID.
 */
export async function fetchQueueTasksForUrlSorted(jobUrl) {
  if (!isSupabaseConfigured() || !jobUrl) return [];
  const cleanUrl = encodeURIComponent(String(jobUrl).trim());
  const tasks = await queueDbRequest('batch_job_queue', {
    query: `?job_url=eq.${cleanUrl}&order=created_at.asc`,
  });
  if (!Array.isArray(tasks)) return [];

  // Sort numerically ascending by AWL number (AWL-1568 first, then AWL-3615, etc.)
  return tasks.sort((a, b) => {
    const numA = parseInt(String(a.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    const numB = parseInt(String(b.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    return numA - numB;
  });
}

/**
 * Broadcast scraped Q&A to all remaining tasks for this URL in batch_job_queue.
 */
export async function broadcastScrapedQaToQueue(jobUrl, sourceTaskId, answersMap = {}) {
  if (!isSupabaseConfigured() || !jobUrl || !answersMap || Object.keys(answersMap).length === 0) return;
  try {
    const cleanUrl = encodeURIComponent(String(jobUrl).trim());
    const cleanId = encodeURIComponent(String(sourceTaskId).trim());
    await queueDbRequest('batch_job_queue', {
      method: 'PATCH',
      query: `?job_url=eq.${cleanUrl}&id=neq.${cleanId}`,
      prefer: 'return=minimal',
      body: {
        pre_resolved_answers: answersMap,
        status: 'pre_resolved',
        updated_at: new Date().toISOString(),
      },
    });
    console.log(`  📡 Broadcasted scraped Q&A JSON to all follower tasks in batch_job_queue.`);
  } catch (err) {
    console.log(`  ⚠️ Broadcast error: ${err.message}`);
  }
}

// ── Master Controller: Blueprint 1st, Then 5 Parallel Workers ────────────────

export async function runQueueBatchForUrl({
  jobUrl = '',
  concurrency = 5,
  headless = false,
  confirmSubmit = false,
  defaultPassword = '',
} = {}) {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`⚡ BATCH QUEUE RUNNER — BLUEPRINT FIRST, THEN ${concurrency} PARALLEL WORKERS`);
  console.log(`   Target URL:  ${jobUrl}`);
  console.log(`   Concurrency: ${concurrency} parallel workers for followers`);
  console.log(`   Browser:     ${headless ? 'Headless (Hidden)' : 'Headed (Visible Browsers)'}`);
  console.log(`   Submission:  ${confirmSubmit ? 'Auto-Submit' : 'Halt at Review (Screenshot Only)'}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Step 1: Reset tasks for clean run
  await resetQueueTasksForUrl(jobUrl);

  // Step 2: Fetch and sort tasks numerically by AWL ID
  console.log(`🔍 Querying Supabase batch_job_queue...`);
  const sortedTasks = await fetchQueueTasksForUrlSorted(jobUrl);

  if (!sortedTasks.length) {
    console.log(`❌ No tasks found in batch_job_queue for URL: ${jobUrl}`);
    return;
  }

  console.log(`📋 Found ${sortedTasks.length} candidate tasks for this URL.`);
  console.log(`   Execution Order (Lowest AWL number to Highest):`);
  sortedTasks.forEach((t, i) => {
    console.log(`     ${String(i + 1).padStart(2, ' ')}. ${t.applywizz_id} (status: ${t.status})`);
  });

  const blueprintTask = sortedTasks[0];
  const followerTasks = sortedTasks.slice(1);

  // ── Step 3: Run Application 1 (AWL-1568) FIRST ───────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📍 PHASE 1: Running Blueprint Task FIRST (#1: ${blueprintTask.applywizz_id})...`);
  console.log(`${'─'.repeat(70)}`);

  const blueprintResult = await executeWorkerTask({
    task: {
      ...blueprintTask,
      queueTaskId: blueprintTask.id,
      applywizzId: blueprintTask.applywizz_id,
      jobUrl: blueprintTask.job_url,
    },
    workerId: 'Worker-Blueprint',
    taskIndex: 1,
    totalTasks: sortedTasks.length,
    options: {
      headless,
      dryRun: !confirmSubmit,
      confirmSubmit,
      defaultPassword,
    },
  });

  // Check if blueprint succeeded
  const bpSuccess = blueprintResult && (
    blueprintResult.status === 'submitted' ||
    blueprintResult.status === 'reached-review' ||
    blueprintResult.status === 'reached_review' ||
    blueprintResult.status === 'ready_for_review'
  );

  // Fetch updated blueprint row to get the scraped Q&A map
  let scrapedQa = {};
  if (bpSuccess) {
    const updatedTasks = await fetchQueueTasksForUrlSorted(jobUrl);
    const updatedBp = updatedTasks.find((t) => t.id === blueprintTask.id);
    scrapedQa = updatedBp?.pre_resolved_answers || {};
  }

  const qaCount = Object.keys(scrapedQa).length;
  console.log(`\n📍 Blueprint outcome: ${bpSuccess ? 'SUCCESS' : 'FAILED'} (Scraped Q&A: ${qaCount} fields)`);

  // ── Step 4: Broadcast Scraped Q&A to Followers in Supabase ───────────────────
  if (qaCount > 0) {
    console.log(`\n📍 PHASE 2: Broadcasting ${qaCount} Q&A pairs to remaining ${followerTasks.length} tasks in Supabase...`);
    await broadcastScrapedQaToQueue(jobUrl, blueprintTask.id, scrapedQa);
  }

  if (followerTasks.length === 0) {
    console.log(`\n✅ Blueprint finished. No followers in queue.`);
    return;
  }

  // ── Step 5: Launch 5 Parallel Workers to Follow Client 1 ────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📍 PHASE 3: Launching ${concurrency} Parallel Workers for the Remaining ${followerTasks.length} Clients...`);
  console.log(`${'─'.repeat(70)}`);

  // Refresh follower tasks to get the pre_resolved_answers
  const freshTasks = await fetchQueueTasksForUrlSorted(jobUrl);
  const freshFollowers = freshTasks.filter((t) => t.id !== blueprintTask.id);

  let currentIndex = 0;
  const results = [blueprintResult];

  async function workerLoop(workerNum) {
    const workerId = `Worker-${workerNum}`;
    while (currentIndex < freshFollowers.length) {
      const myIdx = currentIndex++;
      if (myIdx >= freshFollowers.length) break;
      const t = freshFollowers[myIdx];

      console.log(`   🚀 [${workerId}] Starting candidate ${t.applywizz_id} (${myIdx + 2}/${sortedTasks.length})...`);
      const res = await executeWorkerTask({
        task: {
          ...t,
          queueTaskId: t.id,
          applywizzId: t.applywizz_id,
          jobUrl: t.job_url,
          pre_resolved_answers: t.pre_resolved_answers || scrapedQa,
        },
        workerId,
        taskIndex: myIdx + 2,
        totalTasks: sortedTasks.length,
        options: {
          headless,
          dryRun: !confirmSubmit,
          confirmSubmit,
          defaultPassword,
        },
      });
      results.push(res);
    }
  }

  const workerPromises = [];
  const effectiveConcurrency = Math.min(concurrency, freshFollowers.length);
  for (let w = 1; w <= effectiveConcurrency; w++) {
    workerPromises.push(workerLoop(w));
  }

  await Promise.all(workerPromises);

  // Summary
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = results.filter((r) => r && (
    r.status === 'submitted' ||
    r.status === 'reached-review' ||
    r.status === 'reached_review' ||
    r.status === 'ready_for_review'
  )).length;
  const failCount = results.length - successCount;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏁 BATCH QUEUE RUN COMPLETED in ${elapsedSec}s`);
  console.log(`   Total Candidates: ${sortedTasks.length}`);
  console.log(`   Successful:       ${successCount}`);
  console.log(`   Failed:           ${failCount}`);
  console.log(`   Scraped Q&A:      ${qaCount} fields stored in pre_resolved_answers`);
  console.log(`   Screenshots:      Saved to screenshot_path in Supabase`);
  console.log(`${'═'.repeat(70)}\n`);
}
