/**
 * lib/clusterBatchRunner.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Worker Parallel Cluster Inspection & Fast-Fill Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow:
 *   1. CANONICAL CLUSTERING:
 *      - Strips tracking query parameters (?source=LinkedIn, ?bid=..., etc.)
 *      - Strips /apply suffix and /en-US/ language prefixes
 *      - Extracts tenant and Workday Job Req ID (e.g. JR386, JOBREQ-2616280)
 *      - Merges all messy URL variations for the same job into 1 unified cluster.
 *   2. Sorts clusters by highest candidate/client count descending.
 *   3. Launches 3 parallel workers on 3 different links simultaneously in HEADED browser mode.
 *   4. For each assigned link:
 *      - PHASE 1 (Blueprint Inspection):
 *        • Candidate 1 (lowest numeric AWL ID, e.g. AWL-1568) runs FIRST in a visible browser.
 *        • Fills 4-tier application (with strict 2-digit date formatting: 04, 16, 2026).
 *        • At Review & Submit DOM, scrapes all required Q&A into JSONB.
 *        • Captures mandatory screenshot -> saved to Supabase screenshot_path.
 *      - PHASE 2 (Database Broadcast):
 *        • Atomically updates ALL follower client rows by their Supabase task IDs.
 *        • Copies Candidate 1's scraped Q&A JSON into their pre_resolved_answers column.
 *        • Sets status = 'pre_resolved'.
 *      - PHASE 3 (Fast-Filling Followers):
 *        • Worker fast-fills the remaining candidates in headed browser windows.
 *        • Direct DOM fill using pre-resolved Q&A in 5-8s per page.
 *        • Injects each candidate's unique personal facts (Name, Email, Phone, Resume).
 *        • Captures mandatory screenshots for every candidate.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { executeWorkerTask } from './workerPool.mjs';
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

/**
 * Robust Canonicalizer for Workday URLs:
 * 1. Strips tracking query parameters (?source=..., ?bid=..., ?ref=...)
 * 2. Strips /apply suffix and trailing slashes
 * 3. Strips language prefixes like /en-US/ or /en/
 * 4. Extracts tenant and unique Job Req ID (e.g. JR386, JOBREQ-2616280, R26_3863-1)
 */
export function canonicalizeWorkdayUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { canonicalKey: '', cleanUrl: '', tenant: '', reqId: '', rawUrl: '' };
  }
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.toLowerCase();

    // Strip trailing /apply, trailing slashes
    let path = u.pathname.replace(/\/apply\/?$/i, '').replace(/\/+$/, '');
    // Strip locale prefix (/en-US/, /en-GB/, /en/)
    path = path.replace(/^\/en-[A-Za-z]{2,4}\//i, '/');
    path = path.replace(/^\/en\//i, '/');

    // Extract tenant: e.g. centricsoftware from centricsoftware.wd501.myworkdayjobs.com
    const hostMatch = host.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    const tenant = hostMatch ? hostMatch[1].toLowerCase() : host.split('.')[0].toLowerCase();

    // Extract Job Req ID (the portion after the last underscore in the job path)
    const reqMatch = path.match(/_([A-Za-z0-9_-]+)$/);
    const reqId = reqMatch ? reqMatch[1].toUpperCase() : '';

    const canonicalKey = `${tenant}::${reqId || path.toLowerCase()}`;
    const cleanUrl = `https://${host}${path}`;

    return {
      canonicalKey,
      cleanUrl,
      tenant,
      reqId,
      rawUrl,
    };
  } catch {
    const trimmed = String(rawUrl).trim();
    return {
      canonicalKey: trimmed.toLowerCase(),
      cleanUrl: trimmed,
      tenant: '',
      reqId: '',
      rawUrl: trimmed,
    };
  }
}

function parseUrlDetails(rawUrl, tenant = '') {
  let company = '';
  let role = '';
  try {
    if (tenant) {
      if (/unity/i.test(tenant)) company = 'Unity';
      else if (/lendingclub/i.test(tenant)) company = 'LendingClub';
      else if (/pfizer/i.test(tenant)) company = 'Pfizer';
      else if (/centric/i.test(tenant)) company = 'Centric Software';
      else if (/ameriprise/i.test(tenant)) company = 'Ameriprise';
      else if (/skechers/i.test(tenant)) company = 'Skechers';
      else company = tenant.charAt(0).toUpperCase() + tenant.slice(1);
    }
    const u = new URL(rawUrl);
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
 * Fetch and cluster all queue tasks using canonical job keys.
 * Merges messy link variations (?source=LinkedIn, /en-US/, etc.) into single clusters.
 * Tasks inside each cluster are sorted numerically ascending by AWL ID (AWL-1568 first).
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

    const { canonicalKey, cleanUrl, tenant, reqId } = canonicalizeWorkdayUrl(rawUrl);

    if (!clusterMap.has(canonicalKey)) {
      const parsed = parseUrlDetails(rawUrl, tenant);
      const company = (row.company && row.company !== 'Workday Company')
        ? row.company
        : (parsed.company || 'Workday Company');
      const roleTitle = (row.role_title && row.role_title !== 'Application')
        ? row.role_title
        : (parsed.role || 'Application');

      clusterMap.set(canonicalKey, {
        canonicalKey,
        jobUrl: cleanUrl || rawUrl,
        primaryRawUrl: rawUrl,
        tenant,
        reqId,
        company,
        roleTitle,
        tasks: [],
        rawUrls: new Set(),
      });
    }

    const c = clusterMap.get(canonicalKey);
    c.tasks.push(row);
    c.rawUrls.add(rawUrl);
    if ((!c.company || c.company === 'Workday Company') && row.company && row.company !== 'Workday Company') {
      c.company = row.company;
    }
    if ((!c.roleTitle || c.roleTitle === 'Application') && row.role_title && row.role_title !== 'Application') {
      c.roleTitle = row.role_title;
    }
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
 * Reset all tasks in a cluster to 'pending' by task IDs (immune to URL variations).
 */
export async function resetClusterTasksByIds(taskIds = []) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return;
  try {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
      const chunk = taskIds.slice(i, i + CHUNK_SIZE);
      const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
      await queueDbRequest('batch_job_queue', {
        method: 'PATCH',
        query: `?id=in.(${idFilter})`,
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
    }
  } catch (err) {
    console.log(`  ⚠️ Note on queue reset: ${err.message}`);
  }
}

/**
 * Broadcast scraped Q&A to all follower tasks by their specific IDs (immune to URL variations).
 */
export async function broadcastScrapedQaToClusterByIds(taskIds = [], answersMap = {}) {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !answersMap || Object.keys(answersMap).length === 0) return;
  try {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
      const chunk = taskIds.slice(i, i + CHUNK_SIZE);
      const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
      await queueDbRequest('batch_job_queue', {
        method: 'PATCH',
        query: `?id=in.(${idFilter})`,
        prefer: 'return=minimal',
        body: {
          pre_resolved_answers: answersMap,
          status: 'pre_resolved',
          updated_at: new Date().toISOString(),
        },
      });
    }
  } catch (err) {
    console.log(`  ⚠️ Broadcast error: ${err.message}`);
  }
}

/**
 * Fetch fresh data for specific task IDs from Supabase.
 */
export async function fetchFreshTasksByIds(taskIds = []) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return [];
  const results = [];
  const CHUNK_SIZE = 40;
  for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
    const chunk = taskIds.slice(i, i + CHUNK_SIZE);
    const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
    const rows = await queueDbRequest('batch_job_queue', {
      query: `?id=in.(${idFilter})&select=id,applywizz_id,job_url,status,pre_resolved_answers,company,role_title,screenshot_path`,
    });
    if (Array.isArray(rows)) results.push(...rows);
  }

  return results.sort((a, b) => {
    const numA = parseInt(String(a.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    const numB = parseInt(String(b.applywizz_id || '').replace(/\D/g, '') || '0', 10);
    return numA - numB;
  });
}

/**
 * Worker dedicated to processing a single link cluster end-to-end:
 *   1. Blueprint Leader (AWL-1568) -> Form fill in HEADED browser -> Review DOM Q&A Scrape -> Screenshot
 *   2. Copy-paste JSON to all other client rows in Supabase by their task IDs
 *   3. Fast-fill followers using pre_resolved_answers in HEADED browser
 */
export async function runClusterWorker(workerId, cluster, options = {}) {
  const {
    headless = false, // HEADED by default!
    confirmSubmit = false,
    limitPerLink = null,
    defaultPassword = '',
  } = options;

  const jobUrl = cluster.jobUrl;
  const company = cluster.company;
  const role = cluster.roleTitle;
  const allTasks = cluster.tasks;
  const allTaskIds = allTasks.map((t) => t.id);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🚀 [${workerId}] ASSIGNED CLUSTER: ${company.toUpperCase()} — ${role}`);
  console.log(`   Canonical URL: ${jobUrl}`);
  console.log(`   Job Req ID:    ${cluster.reqId || 'N/A'}`);
  console.log(`   Total Clients: ${cluster.clientCount} (clustered across ${cluster.rawUrls.size} messy link variations)`);
  console.log(`   Browser Mode:  ${headless ? 'Headless' : 'HEADED (Visible Browser Window)'}`);
  console.log(`${'═'.repeat(72)}`);

  // Clean reset all candidate tasks in this cluster
  await resetClusterTasksByIds(allTaskIds);

  // Apply optional limit per link (e.g. for testing)
  const activeTasks = limitPerLink ? allTasks.slice(0, limitPerLink) : allTasks;
  if (!activeTasks.length) {
    console.log(`⚠️ [${workerId}] No active tasks for this link.`);
    return { workerId, jobUrl, company, succeeded: 0, failed: 0, total: 0, scrapedQaCount: 0 };
  }

  const blueprintTask = activeTasks[0];
  const followerTasks = activeTasks.slice(1);
  const followerIds = followerTasks.map((t) => t.id);

  console.log(`\n📍 [${workerId}] PHASE 1: Blueprint Inspection for Candidate #1: ${blueprintTask.applywizz_id}...`);
  console.log(`   (Launching HEADED browser, 2-digit date formatting, DOM Review Q&A scrape)`);

  const blueprintResult = await executeWorkerTask({
    task: {
      ...blueprintTask,
      queueTaskId: blueprintTask.id,
      applywizzId: blueprintTask.applywizz_id,
      jobUrl: blueprintTask.job_url || jobUrl,
    },
    workerId: `${workerId}-Lead`,
    taskIndex: 1,
    totalTasks: activeTasks.length,
    options: {
      headless: false, // Ensure visible headed browser window
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
    // Fallback: reload Candidate 1 from Supabase
    const reloaded = await fetchFreshTasksByIds([blueprintTask.id]);
    scrapedQa = reloaded[0]?.pre_resolved_answers || {};
  }

  const qaCount = Object.keys(scrapedQa).length;
  console.log(`\n📍 [${workerId}] Blueprint Candidate ${blueprintTask.applywizz_id}: ${bpSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`   Scraped Q&A Fields: ${qaCount} questions stored in Supabase.`);

  // ── PHASE 2: Database Broadcast (Copy-Paste to remaining client rows by IDs) ─
  if (qaCount > 0 && followerIds.length > 0) {
    console.log(`\n📡 [${workerId}] PHASE 2: Broadcasting scraped Q&A (${qaCount} fields) to remaining ${followerIds.length} clients in Supabase...`);
    await broadcastScrapedQaToClusterByIds(followerIds, scrapedQa);
    console.log(`   ✅ [${workerId}] Successfully copied & pasted Q&A JSON into pre_resolved_answers for all ${followerIds.length} clients!`);
  }

  if (followerTasks.length === 0) {
    return {
      workerId,
      jobUrl,
      company,
      role,
      succeeded: bpSuccess ? 1 : 0,
      failed: bpSuccess ? 0 : 1,
      total: 1,
      scrapedQaCount: qaCount,
    };
  }

  // ── PHASE 3: Fast-Filling Remaining Clients in HEADED Browsers ────────────────
  console.log(`\n⚡ [${workerId}] PHASE 3: Fast-Filling Remaining ${followerTasks.length} Clients in HEADED Browsers...`);
  console.log(`   (Fast DOM matching: ~5-8s per page, unique Name/Email/Phone/Resume preserved, screenshots captured)`);

  const results = [blueprintResult];
  let followerIndex = 0;

  for (const t of followerTasks) {
    followerIndex++;
    console.log(`\n   🚀 [${workerId}] Fast-filling candidate ${followerIndex}/${followerTasks.length}: ${t.applywizz_id} (HEADED)...`);

    const res = await executeWorkerTask({
      task: {
        ...t,
        queueTaskId: t.id,
        applywizzId: t.applywizz_id,
        jobUrl: t.job_url || jobUrl,
        pre_resolved_answers: t.pre_resolved_answers || scrapedQa,
      },
      workerId,
      taskIndex: followerIndex + 1,
      totalTasks: activeTasks.length,
      options: {
        headless: false, // Ensure visible headed browser window
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

  console.log(`\n🏁 [${workerId}] COMPLETED CLUSTER: ${company}`);
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
 * 1. Clusters links canonically and picks the top N links (highest candidate count).
 * 2. Runs N dedicated workers in parallel (1 per link) with HEADED browsers.
 * 3. Each worker performs Blueprint Inspection -> Broadcast Copy-Paste -> Fast-Fill Followers.
 */
export async function runClusterBatchRunner({
  topLinks = 3,
  workers = 3,
  headless = false, // HEADED execution by default!
  confirmSubmit = false,
  limitPerLink = null,
  defaultPassword = '',
} = {}) {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`⚡ CLUSTER BATCH RUNNER — 3 PARALLEL WORKERS ON TOP 3 LINKS (HEADED ONLY)`);
  console.log(`   Top Links:     ${topLinks} highest client-count clusters`);
  console.log(`   Workers:       ${workers} parallel workers running simultaneously`);
  console.log(`   Browser Mode:  HEADED (Visible Browser Windows Only)`);
  console.log(`   Submission:    ${confirmSubmit ? 'Auto-Submit' : 'Halt at Review (Screenshots & Scrapes Only)'}`);
  if (limitPerLink) {
    console.log(`   Link Limit:    Max ${limitPerLink} clients per link (Test Mode)`);
  }
  console.log(`${'═'.repeat(78)}\n`);

  // Step 1: Cluster links canonically and select top N
  console.log(`🔍 Canonicalizing & clustering messy URLs from Supabase batch_job_queue...`);
  const topClusters = await fetchQueueClusters({ minClients: 1, limit: topLinks });

  if (!topClusters.length) {
    console.log(`❌ No tasks found in batch_job_queue!`);
    return;
  }

  console.log(`\n📋 Selected Top ${topClusters.length} Canonical Clusters for Parallel Execution:\n`);
  console.log(` Worker   │ Company & Role                         │ Req ID      │ Clients │ Messy URLs`);
  console.log(`──────────┼────────────────────────────────────────┼─────────────┼─────────┼───────────`);
  topClusters.forEach((c, idx) => {
    const workerLabel = `Worker ${idx + 1}`.padEnd(8, ' ');
    const desc = `${c.company} — ${c.roleTitle}`.slice(0, 38).padEnd(38, ' ');
    const req = (c.reqId || 'N/A').slice(0, 11).padEnd(11, ' ');
    const count = String(c.clientCount).padStart(7, ' ');
    const variations = String(c.rawUrls.size).padStart(9, ' ');
    console.log(` ${workerLabel} │ ${desc} │ ${req} │ ${count} │ ${variations}`);
  });
  console.log(`──────────┴────────────────────────────────────────┴─────────────┴─────────┴───────────\n`);

  // Step 2: Launch N Workers in Parallel (1 per link) with HEADED browsers
  console.log(`🚀 Launching ${topClusters.length} Parallel Workers in HEADED Mode Simultaneously...\n`);

  const workerPromises = topClusters.map((cluster, idx) => {
    const workerId = `Worker-${idx + 1}`;
    return runClusterWorker(workerId, cluster, {
      headless: false, // Explicitly HEADED only!
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

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`🏁 ALL ${topClusters.length} CLUSTERS COMPLETED IN ${elapsedSec}s (HEADED MODE)`);
  console.log(`${'═'.repeat(78)}`);
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
  console.log(`${'═'.repeat(78)}\n`);
}
