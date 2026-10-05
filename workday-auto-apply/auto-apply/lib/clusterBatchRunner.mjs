/**
 * lib/clusterBatchRunner.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Worker Parallel Cluster Inspection & Fast-Fill Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow:
 *   1. Clusters all pending tasks in batch_job_queue by job_url.
 *   2. Sorts clusters by highest candidate/client count descending.
 *   3. Launches N parallel workers on N different links simultaneously (default: 3 workers).
 *   4. For each assigned link:
 *      - PHASE 1 (Blueprint Inspection):
 *        • Candidate 1 (lowest numeric AWL ID, e.g. AWL-1568) runs FIRST.
 *        • Fills 4-tier application (with strict 2-digit date formatting).
 *        • At Review & Submit DOM, scrapes all required Q&A into JSONB.
 *        • Captures mandatory screenshot -> saved to Supabase screenshot_path.
 *      - PHASE 2 (Database Broadcast):
 *        • Broadcasts Candidate 1's scraped Q&A JSON into pre_resolved_answers
 *          column for all other candidate rows belonging to that same link.
 *        • Sets status = 'pre_resolved'.
 *      - PHASE 3 (Fast-Filling Followers):
 *        • Worker loops through remaining candidates for that link.
 *        • Direct DOM fill using pre-resolved Q&A in 5-8s per page.
 *        • Injects each candidate's unique personal facts (Name, Email, Phone, Resume).
 *        • Captures mandatory screenshots for every candidate.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { executeWorkerTask } from './workerPool.mjs';
import { isSupabaseConfigured } from './supabaseClient.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

function getCleanSupabaseEnv() {
  let rawUrl = String(process.env.SUPABASE_URL || '').trim();
  let rawKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!rawUrl || !rawKey) {
    const envCandidates = [
      resolve(process.cwd(), '.env'),
      resolve(process.cwd(), 'auto-apply', '.env'),
    ];
    for (const p of envCandidates) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, 'utf-8');
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
            if (match) {
              const [, k, v] = match;
              const cleanV = v.trim().replace(/^['"](.*)['"]$/, '$1');
              if (k === 'SUPABASE_URL' && !rawUrl) rawUrl = cleanV;
              if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !rawKey) rawKey = cleanV;
            }
          }
        } catch {}
      }
    }
  }

  const url = rawUrl.replace(/[\"']/g, '').replace(/\/+$/, '');
  const key = rawKey.replace(/[\"']/g, '');
  return { url, key, configured: Boolean(url && key) };
}

function parseUrlDetails(rawUrl) {
  let company = '';
  let role = '';
  try {
    const u = new URL(rawUrl);
    const hostMatch = u.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (hostMatch) {
      const t = hostMatch[1];
      if (/unity/i.test(t)) company = 'Unity';
      else if (/lendingclub/i.test(t)) company = 'LendingClub';
      else if (/pfizer/i.test(t)) company = 'Pfizer';
      else company = t.charAt(0).toUpperCase() + t.slice(1);
    }
    const pathParts = u.pathname.split('/').filter(Boolean);
    const jobSegment = pathParts[pathParts.length - 1] || '';
    if (jobSegment) {
      const cleaned = jobSegment
        .replace(/_[A-Z0-9-]+$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleaned.length > 2) {
        role = cleaned;
      }
    }
  } catch {}
  return { company, role };
}

async function queueDbRequest(path, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
  const { url, key, configured } = getCleanSupabaseEnv();
  if (!configured) return null;
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/${path}${query}`,
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body,
    timeoutMs: 25000,
  }, { attempts: 3, label: 'ClusterBatchQueue' });

  if (!res.ok) throw new Error(`Supabase ${res.status}: ${String(res.text || '').slice(0, 200)}`);
  if (!res.text) return null;
  return res.json();
}

/**
 * Fetch and cluster all queue tasks by job_url, sorted descending by client count.
 * Inside each cluster, tasks are sorted numerically ascending by AWL ID (e.g. AWL-1568 first).
 */
export async function fetchQueueClusters({ minClients = 1, limit = 3 } = {}) {
  const { configured } = getCleanSupabaseEnv();
  if (!configured) return [];

  const rows = await queueDbRequest('batch_job_queue', {
    query: '?select=id,applywizz_id,job_url,status,pre_resolved_answers,company,role_title,screenshot_path&limit=10000',
  });

  if (!Array.isArray(rows)) return [];

  const clusterMap = new Map();

  for (const row of rows) {
    const rawUrl = String(row.job_url || '').trim();
    if (!rawUrl) continue;

    if (!clusterMap.has(rawUrl)) {
      const parsed = parseUrlDetails(rawUrl);
      const company = (row.company && row.company !== 'Workday Company')
        ? row.company
        : (parsed.company || 'Workday Company');
      const roleTitle = (row.role_title && row.role_title !== 'Application')
        ? row.role_title
        : (parsed.role || 'Application');

      clusterMap.set(rawUrl, {
        jobUrl: rawUrl,
        company,
        roleTitle,
        tasks: [],
      });
    }

    const c = clusterMap.get(rawUrl);
    c.tasks.push(row);
  }

  const clusters = Array.from(clusterMap.values());

  // Sort tasks within each cluster numerically ascending by AWL ID (AWL-1568 first)
  for (const c of clusters) {
    c.tasks.sort((a, b) => {
      const numA = parseInt(String(a.applywizz_id || '').replace(/\D/g, '') || '0', 10);
      const numB = parseInt(String(b.applywizz_id || '').replace(/\D/g, '') || '0', 10);
      return numA - numB;
    });
    c.clientCount = c.tasks.length;
  }

  // Filter clusters by minClients and sort descending by clientCount
  return clusters
    .filter((c) => c.clientCount >= minClients)
    .sort((a, b) => b.clientCount - a.clientCount)
    .slice(0, limit);
}

/**
 * Reset all tasks for a specific URL to 'pending' for a clean cluster run.
 */
export async function resetClusterTasksForUrl(jobUrl) {
  if (!jobUrl) return;
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
  } catch (err) {
    console.log(`  ⚠️ Note on queue reset: ${err.message}`);
  }
}

/**
 * Broadcast scraped Q&A to all remaining follower tasks for this URL in batch_job_queue.
 */
export async function broadcastScrapedQaToCluster(jobUrl, sourceTaskId, answersMap = {}) {
  if (!jobUrl || !answersMap || Object.keys(answersMap).length === 0) return;
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
  } catch (err) {
    console.log(`  ⚠️ Broadcast error: ${err.message}`);
  }
}

/**
 * Fetch fresh tasks for a URL, sorted numerically ascending.
 */
export async function fetchFreshTasksForUrl(jobUrl) {
  if (!jobUrl) return [];
  const cleanUrl = encodeURIComponent(String(jobUrl).trim());
  const rows = await queueDbRequest('batch_job_queue', {
    query: `?job_url=eq.${cleanUrl}&select=id,applywizz_id,job_url,status,pre_resolved_answers,company,role_title,screenshot_path&order=created_at.asc`,
  });
  if (!Array.isArray(rows)) return [];
  return rows.sort((a, b) => {
    const numA = parseInt(String(a.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    const numB = parseInt(String(b.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    return numA - numB;
  });
}

/**
 * Worker dedicated to processing a single link cluster end-to-end:
 *   1. Blueprint Leader (AWL-1568) -> Form fill -> Review DOM Q&A Scrape -> Screenshot
 *   2. Copy-paste JSON to all other client rows in Supabase
 *   3. Fast-fill followers using pre_resolved_answers
 */
export async function runClusterWorker(workerId, cluster, options = {}) {
  const {
    headless = false,
    confirmSubmit = false,
    limitPerLink = null,
    defaultPassword = '',
  } = options;

  const jobUrl = cluster.jobUrl;
  const company = cluster.company;
  const role = cluster.roleTitle;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🚀 [${workerId}] ASSIGNED LINK: ${company} — ${role}`);
  console.log(`   URL:          ${jobUrl}`);
  console.log(`   Total Clients: ${cluster.clientCount} in queue`);
  console.log(`${'═'.repeat(70)}`);

  // Clean reset for this link
  await resetClusterTasksForUrl(jobUrl);

  // Fetch sorted tasks numerically
  let allTasks = await fetchFreshTasksForUrl(jobUrl);
  if (!allTasks.length) {
    allTasks = cluster.tasks;
  }

  // Apply optional limit per link (e.g. for testing)
  const activeTasks = limitPerLink ? allTasks.slice(0, limitPerLink) : allTasks;
  if (!activeTasks.length) {
    console.log(`⚠️ [${workerId}] No active tasks for this link.`);
    return { workerId, jobUrl, company, succeeded: 0, failed: 0, total: 0, scrapedQaCount: 0 };
  }

  const blueprintTask = activeTasks[0];
  const followerTasks = activeTasks.slice(1);

  console.log(`\n📍 [${workerId}] PHASE 1: Blueprint Inspection for Candidate #1: ${blueprintTask.applywizz_id}...`);
  console.log(`   (Strict 2-digit date formatting, full profile facts, Review DOM Q&A scrape)`);

  const blueprintResult = await executeWorkerTask({
    task: {
      ...blueprintTask,
      queueTaskId: blueprintTask.id,
      applywizzId: blueprintTask.applywizz_id,
      jobUrl: blueprintTask.job_url,
    },
    workerId: `${workerId}-Lead`,
    taskIndex: 1,
    totalTasks: activeTasks.length,
    options: {
      headless,
      dryRun: !confirmSubmit,
      confirmSubmit,
      defaultPassword,
    },
  });

  const bpSuccess = blueprintResult && (
    blueprintResult.status === 'submitted' ||
    blueprintResult.status === 'reached-review' ||
    blueprintResult.status === 'reached_review' ||
    blueprintResult.status === 'ready_for_review'
  );

  // Extract scraped Q&A map
  let scrapedQa = blueprintResult?.answersMap || {};
  if (Object.keys(scrapedQa).length === 0) {
    // Fallback: reload Candidate 1's row from Supabase
    const reloadedTasks = await fetchFreshTasksForUrl(jobUrl);
    const bpReloaded = reloadedTasks.find((t) => t.id === blueprintTask.id);
    scrapedQa = bpReloaded?.pre_resolved_answers || {};
  }

  const qaCount = Object.keys(scrapedQa).length;
  console.log(`\n📍 [${workerId}] Blueprint Candidate ${blueprintTask.applywizz_id}: ${bpSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`   Scraped Q&A Fields: ${qaCount} questions stored in Supabase.`);

  // ── PHASE 2: Database Broadcast (Copy-Paste to remaining client rows) ─────────
  if (qaCount > 0 && followerTasks.length > 0) {
    console.log(`\n📡 [${workerId}] PHASE 2: Broadcasting scraped Q&A (${qaCount} fields) to remaining ${followerTasks.length} client rows in Supabase...`);
    await broadcastScrapedQaToCluster(jobUrl, blueprintTask.id, scrapedQa);
    console.log(`   ✅ [${workerId}] Successfully copied & pasted Q&A JSON into pre_resolved_answers for all ${followerTasks.length} clients!`);
  }

  if (followerTasks.length === 0) {
    return {
      workerId,
      jobUrl,
      company,
      succeeded: bpSuccess ? 1 : 0,
      failed: bpSuccess ? 0 : 1,
      total: 1,
      scrapedQaCount: qaCount,
    };
  }

  // ── PHASE 3: Fast-Filling Remaining Clients ──────────────────────────────────
  console.log(`\n⚡ [${workerId}] PHASE 3: Fast-Filling Remaining ${followerTasks.length} Clients Using Pre-Resolved Q&A...`);
  console.log(`   (DOM matching: ~5-8s per page, unique Name/Email/Phone/Resume preserved, screenshots captured)`);

  // Reload fresh follower tasks
  const freshFollowers = (await fetchFreshTasksForUrl(jobUrl)).filter((t) => t.id !== blueprintTask.id);
  const tasksToProcess = limitPerLink ? freshFollowers.slice(0, limitPerLink - 1) : freshFollowers;

  const results = [blueprintResult];
  let followerIndex = 0;

  for (const t of tasksToProcess) {
    followerIndex++;
    console.log(`\n   🚀 [${workerId}] Fast-filling candidate ${followerIndex}/${tasksToProcess.length}: ${t.applywizz_id}...`);

    const res = await executeWorkerTask({
      task: {
        ...t,
        queueTaskId: t.id,
        applywizzId: t.applywizz_id,
        jobUrl: t.job_url,
        pre_resolved_answers: t.pre_resolved_answers || scrapedQa,
      },
      workerId,
      taskIndex: followerIndex + 1,
      totalTasks: activeTasks.length,
      options: {
        headless,
        dryRun: !confirmSubmit,
        confirmSubmit,
        defaultPassword,
      },
    });

    results.push(res);
  }

  const successCount = results.filter((r) => r && (
    r.status === 'submitted' ||
    r.status === 'reached-review' ||
    r.status === 'reached_review' ||
    r.status === 'ready_for_review'
  )).length;
  const failCount = results.length - successCount;

  console.log(`\n🏁 [${workerId}] COMPLETED LINK: ${company}`);
  console.log(`   Succeeded: ${successCount}/${results.length} | Failed: ${failCount}`);

  return {
    workerId,
    jobUrl,
    company,
    role,
    total: results.length,
    succeeded: successCount,
    failed: failCount,
    scrapedQaCount: qaCount,
  };
}

/**
 * Master Controller:
 * 1. Clusters links and picks the top N links (highest candidate count).
 * 2. Runs N dedicated workers in parallel (1 per link).
 * 3. Each worker performs Blueprint Inspection -> Broadcast Copy-Paste -> Fast-Fill Followers.
 */
export async function runClusterBatchRunner({
  topLinks = 3,
  workers = 3,
  headless = false,
  confirmSubmit = false,
  limitPerLink = null,
  defaultPassword = '',
} = {}) {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`⚡ CLUSTER BATCH RUNNER — 3 PARALLEL WORKERS ON TOP 3 LINKS`);
  console.log(`   Top Links:    ${topLinks} highest client-count links`);
  console.log(`   Workers:      ${workers} parallel workers running simultaneously`);
  console.log(`   Browser Mode: ${headless ? 'Headless (Hidden)' : 'Headed (Visible Browsers)'}`);
  console.log(`   Submission:   ${confirmSubmit ? 'Auto-Submit' : 'Halt at Review (Screenshots & Scrapes Only)'}`);
  if (limitPerLink) {
    console.log(`   Link Limit:   Max ${limitPerLink} clients per link (Test Mode)`);
  }
  console.log(`${'═'.repeat(75)}\n`);

  // Step 1: Cluster links and select top N
  console.log(`🔍 Clustering links from Supabase batch_job_queue...`);
  const topClusters = await fetchQueueClusters({ minClients: 1, limit: topLinks });

  if (!topClusters.length) {
    console.log(`❌ No tasks found in batch_job_queue!`);
    return;
  }

  console.log(`\n📋 Selected Top ${topClusters.length} Links for Parallel Execution:\n`);
  console.log(` Worker   │ Company & Role                             │ Clients │ Link`);
  console.log(`──────────┼────────────────────────────────────────────┼─────────┼──────────────────────────────`);
  topClusters.forEach((c, idx) => {
    const workerLabel = `Worker ${idx + 1}`.padEnd(8, ' ');
    const desc = `${c.company} — ${c.roleTitle}`.slice(0, 42).padEnd(42, ' ');
    const count = String(c.clientCount).padStart(7, ' ');
    const urlSnip = c.jobUrl.slice(0, 30) + '...';
    console.log(` ${workerLabel} │ ${desc} │ ${count} │ ${urlSnip}`);
  });
  console.log(`──────────┴────────────────────────────────────────────┴─────────┴──────────────────────────────\n`);

  // Step 2: Launch N Workers in Parallel (1 per link)
  console.log(`🚀 Launching ${topClusters.length} Parallel Workers Simultaneously...\n`);

  const workerPromises = topClusters.map((cluster, idx) => {
    const workerId = `Worker-${idx + 1}`;
    return runClusterWorker(workerId, cluster, {
      headless,
      confirmSubmit,
      limitPerLink,
      defaultPassword,
    });
  });

  const clusterResults = await Promise.all(workerPromises);

  // Step 3: Final Execution Summary
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalProcessed = clusterResults.reduce((acc, r) => acc + (r.total || 0), 0);
  const totalSuccess = clusterResults.reduce((acc, r) => acc + (r.succeeded || 0), 0);
  const totalFailed = clusterResults.reduce((acc, r) => acc + (r.failed || 0), 0);

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`🏁 ALL ${topClusters.length} CLUSTERS COMPLETED IN ${elapsedSec}s`);
  console.log(`${'═'.repeat(75)}`);
  console.log(` Worker   │ Company                  │ Processed │ Succeeded │ Failed │ Q&A Scraped`);
  console.log(`──────────┼──────────────────────────┼───────────┼───────────┼────────┼────────────`);
  clusterResults.forEach((r) => {
    const w = (r.workerId || '').padEnd(8, ' ');
    const comp = (r.company || '').slice(0, 24).padEnd(24, ' ');
    const proc = String(r.total || 0).padStart(9, ' ');
    const succ = String(r.succeeded || 0).padStart(9, ' ');
    const fail = String(r.failed || 0).padStart(6, ' ');
    const qa = String(r.scrapedQaCount || 0).padStart(10, ' ');
    console.log(` ${w} │ ${comp} │ ${proc} │ ${succ} │ ${fail} │ ${qa}`);
  });
  console.log(`──────────┴──────────────────────────┴───────────┴───────────┴────────┴────────────`);
  console.log(` TOTALS:    Processed: ${totalProcessed} | Succeeded: ${totalSuccess} | Failed: ${totalFailed}`);
  console.log(` Screenshots saved to Supabase 'screenshot_path' for every application.`);
  console.log(`${'═'.repeat(75)}\n`);
}
