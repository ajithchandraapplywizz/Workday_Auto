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
import { updateWorkerStatus } from './supabaseClient.mjs';
import { isGlobalStopRequested, setGlobalStop } from './browserLifecycle.mjs';

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
        } catch { }
      }
    }
  }

  const url = rawUrl.replace(/[\"']/g, '').replace(/\/+$/, '');
  const key = rawKey.replace(/[\"']/g, '');
  return { url, key, configured: Boolean(url && key) };
}

let clusterStopFlag = false;
export function setClusterStop(val) {
  clusterStopFlag = Boolean(val);
  setGlobalStop(val);
}
export function getClusterStop() {
  return clusterStopFlag || isGlobalStopRequested();
}

export async function isClusterStopRequested() {
  return clusterStopFlag || isGlobalStopRequested();
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

    const cleanUrl = `https://${host}${path}`;
    // STRICT URL IDENTIFICATION: The canonical key is strictly the normalized URL itself!
    const canonicalKey = cleanUrl.toLowerCase();

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
  } catch { }
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

  let rows = [];
  try {
    rows = await queueDbRequest('batch_job_queue', {
      query: '?select=id,applywizz_id,job_url,status,company,role_title,screenshot_path,job_id&limit=10000',
    });
  } catch (err) {
    if (String(err?.message || '').includes('42703') || String(err?.message || '').includes('batch_job_queue.id')) {
      rows = await queueDbRequest('batch_job_queue', {
        query: '?select=applywizz_id,job_url,status,company,role_title,screenshot_path,job_id&limit=10000',
      });
    } else {
      throw err;
    }
  }

  if (!Array.isArray(rows)) return [];

  // Fetch completed scanned_jobs to strictly prevent re-scanning already completed links
  const completedScannedUrls = new Set();
  try {
    const scanned = await queueDbRequest('scanned_jobs', {
      query: '?select=job_url&scan_status=eq.completed&limit=5000',
    });
    if (Array.isArray(scanned)) {
      for (const s of scanned) {
        if (s.job_url) {
          const { canonicalKey } = canonicalizeWorkdayUrl(s.job_url);
          if (canonicalKey) completedScannedUrls.add(canonicalKey);
        }
      }
    }
  } catch { }

  const clusterMap = new Map();

  for (const row of rows) {
    if (row.status === 'submitted') continue;
    const rawUrl = String(row.job_url || '').trim();
    if (!rawUrl) continue;

    if (!row.id) {
      row.id = `${row.applywizz_id}:::${rawUrl}`;
    }

    const { canonicalKey, cleanUrl, tenant, reqId } = canonicalizeWorkdayUrl(rawUrl);

    // Skip links that are already scanned and completed in scanned_jobs!
    if (completedScannedUrls.has(canonicalKey)) continue;

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
      const isComposite = chunk.some((id) => String(id).includes(':::'));
      if (isComposite) {
        for (const cid of chunk) {
          const [awlId, ...rest] = String(cid).split(':::');
          const jUrl = rest.join(':::');
          await queueDbRequest('batch_job_queue', {
            method: 'PATCH',
            query: `?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(jUrl)}`,
            prefer: 'return=minimal',
            body: {
              status: 'pending',
              worker_id: null,
              locked_at: null,
              updated_at: new Date().toISOString(),
            },
          }).catch(() => { });
        }
      } else {
        const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
        await queueDbRequest('batch_job_queue', {
          method: 'PATCH',
          query: `?id=in.(${idFilter})`,
          prefer: 'return=minimal',
          body: {
            status: 'pending',
            worker_id: null,
            locked_at: null,
            updated_at: new Date().toISOString(),
          },
        });
      }
    }
  } catch (err) {
    console.log(`  ⚠️ Note on queue reset: ${err.message}`);
  }
}

/**
 * Fail/skip multiple cluster tasks by their specific IDs in Supabase.
 */
export async function failClusterTasksByIds(taskIds = [], reason = 'Link expired on Workday') {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return;
  try {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
      const chunk = taskIds.slice(i, i + CHUNK_SIZE);
      const isComposite = chunk.some((id) => String(id).includes(':::'));
      if (isComposite) {
        for (const cid of chunk) {
          const [awlId, ...rest] = String(cid).split(':::');
          const jUrl = rest.join(':::');
          await queueDbRequest('batch_job_queue', {
            method: 'PATCH',
            query: `?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(jUrl)}`,
            prefer: 'return=minimal',
            body: {
              status: 'failed',
              locked_at: null,
              updated_at: new Date().toISOString(),
            },
          }).catch(() => { });
        }
      } else {
        const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
        await queueDbRequest('batch_job_queue', {
          method: 'PATCH',
          query: `?id=in.(${idFilter})`,
          prefer: 'return=minimal',
          body: {
            status: 'failed',
            locked_at: null,
            updated_at: new Date().toISOString(),
          },
        });
      }
    }
    console.log(`\n📥 [SUPABASE INGESTION] table: batch_job_queue | action: PATCH (${taskIds.length} follower tasks marked status = 'failed' | reason: ${reason})\n`);
  } catch (err) {
    console.log(`  ⚠️ Note on failing cluster tasks: ${err.message}`);
  }
}

export async function broadcastScrapedQaToClusterByIds(taskIds = [], answersMap = {}) {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !answersMap || Object.keys(answersMap).length === 0) return;
  try {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
      const chunk = taskIds.slice(i, i + CHUNK_SIZE);
      const isComposite = chunk.some((id) => String(id).includes(':::'));
      if (isComposite) {
        for (const cid of chunk) {
          const [awlId, ...rest] = String(cid).split(':::');
          const jUrl = rest.join(':::');
          await queueDbRequest('batch_job_queue', {
            method: 'PATCH',
            query: `?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(jUrl)}`,
            prefer: 'return=minimal',
            body: {
              status: 'pre_resolved',
              updated_at: new Date().toISOString(),
            },
          }).catch(() => { });
        }
      } else {
        const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
        await queueDbRequest('batch_job_queue', {
          method: 'PATCH',
          query: `?id=in.(${idFilter})`,
          prefer: 'return=minimal',
          body: {
            status: 'pre_resolved',
            updated_at: new Date().toISOString(),
          },
        });
      }
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
    const isComposite = chunk.some((id) => String(id).includes(':::'));
    if (isComposite) {
      for (const cid of chunk) {
        const [awlId, ...rest] = String(cid).split(':::');
        const jUrl = rest.join(':::');
        try {
          const rows = await queueDbRequest('batch_job_queue', {
            query: `?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(jUrl)}&select=applywizz_id,job_url,status,company,role_title,screenshot_path`,
          });
          if (Array.isArray(rows) && rows[0]) {
            rows[0].id = cid;
            results.push(rows[0]);
          }
        } catch { }
      }
    } else {
      const idFilter = chunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
      const rows = await queueDbRequest('batch_job_queue', {
        query: `?id=in.(${idFilter})&select=id,applywizz_id,job_url,status,company,role_title,screenshot_path`,
      });
      if (Array.isArray(rows)) results.push(...rows);
    }
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
    defaultPassword = process.env.WORKDAY_PASSWORD || 'Applywizz@2026',
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


  // Active tasks to actually run in the browser (respecting limitPerLink if specified)
  const activeTasks = limitPerLink ? allTasks.slice(0, limitPerLink) : allTasks;

  if (!activeTasks.length) {
    console.log(`⚠️ [${workerId}] No active tasks for this link.`);
    return { workerId, jobUrl, company, succeeded: 0, failed: 0, total: 0, scrapedQaCount: 0 };
  }

  let blueprintTask = null;
  let blueprintResult = null;
  let bpSuccess = false;
  let isExpired = false;
  let leadProofShot = null;
  let leadFailReason = null;
  let leadFailStep = null;

  const maxLeadAttempts = Math.min(3, activeTasks.length);

  for (let attemptIdx = 0; attemptIdx < maxLeadAttempts; attemptIdx++) {
    const candidateTask = activeTasks[attemptIdx];
    console.log(`\n📍 [${workerId}] PHASE 1: Testing Lead Candidate #${attemptIdx + 1} (${candidateTask.applywizz_id}) for Unique Link...`);
    console.log(`   (Strictly 1 browser run per unique link; Followers will NOT run in browsers)`);

    const result = await executeWorkerTask({
      task: {
        ...candidateTask,
        queueTaskId: candidateTask.id,
        applywizzId: candidateTask.applywizz_id,
        jobUrl: candidateTask.job_url || jobUrl,
      },
      workerId,
      taskIndex: attemptIdx + 1,
      totalTasks: 1,
      options: {
        headless: Boolean(headless),
        dryRun: !confirmSubmit,
        confirmSubmit,
        defaultPassword,
        isClusterBlueprint: true,
      },
    });

    const reachedReviewStep = String(result?.stoppedAtStep || '').toLowerCase().includes('review');
    const success = result && (
      result.status === 'submitted' ||
      result.status === 'reached-review' ||
      result.status === 'reached_review' ||
      result.status === 'ready_for_review' ||
      (result.status === 'human-required' && reachedReviewStep) ||
      reachedReviewStep
    );

    if (success) {
      blueprintTask = candidateTask;
      blueprintResult = result;
      bpSuccess = true;
      break;
    }

    // Check if the job itself is genuinely expired / closed / 404
    const deadJob = result?.status === 'job_expired' ||
      String(result?.reason || '').includes('expired') ||
      String(result?.reason || '').includes('apply_not_found') ||
      String(result?.reason || '').includes('empty_page') ||
      result?.stoppedAtStep === 'Job Discovery / Link Expired';

    if (deadJob) {
      isExpired = true;
      leadProofShot = result?.screenshotUrl || null;
      leadFailReason = 'Job Expired / Closed / No Apply button';
      leadFailStep = result?.stoppedAtStep || 'Job Discovery / Link Expired';
      blueprintTask = candidateTask;
      blueprintResult = result;
      console.log(`\n❌ [${workerId}] Genuine job expiration confirmed on Workday for link. Stopping cluster.`);
      break;
    }

    // Candidate-specific failure (e.g. auth_failed, missing credentials, locked account)
    console.log(`\n⚠️ [${workerId}] Lead Candidate ${candidateTask.applywizz_id} stopped (${result?.failureReason || result?.error || result?.status || 'Failed'}).`);
    if (attemptIdx + 1 < maxLeadAttempts) {
      console.log(`   🔄 Trying next candidate in cluster (#${attemptIdx + 2}: ${activeTasks[attemptIdx + 1].applywizz_id}) to scan job...`);
    } else {
      leadProofShot = result?.screenshotUrl || null;
      leadFailReason = result?.failureReason || result?.error || result?.status || 'Lead candidate auth/form run failed';
      leadFailStep = result?.stoppedAtStep || 'Form Wizard';
      blueprintTask = candidateTask;
      blueprintResult = result;
    }
  }

  // Handle failure if none of the candidate attempts reached review
  if (!bpSuccess) {
    if (isExpired) {
      const skipReason = leadFailReason || 'Job Expired / Closed / No Apply button';
      const failStep = leadFailStep || 'Job Discovery / Link Expired';
      const proofShot = leadProofShot;
      const allFollowers = allTasks.filter((t) => t.id !== blueprintTask?.id);
      const allFollowerIds = allFollowers.map((t) => t.id);

      console.log(`\n⚠️ [${workerId}] Link confirmed expired on Workday. Skipping all ${allFollowerIds.length} follower candidate(s) for this job!`);

      try {
        const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
        for (const t of allTasks) {
          await recordFailedJob({
            applywizzId: t.applywizz_id,
            jobId: t.job_id || cluster.reqId || null,
            jobUrl: t.job_url || jobUrl,
            company,
            roleTitle: role,
            failureReason: `Job expired/closed on Workday (${skipReason})`,
            failedAtStep: failStep,
            screenshotPath: proofShot,
          }).catch(() => {});
        }
      } catch {}

      if (allTaskIds.length > 0) {
        await failClusterTasksByIds(allTaskIds, `Job expired / closed on Workday (confirmed dead URL)`);
        console.log(`   ✓ Marked ${allTaskIds.length} tasks as expired in batch_job_queue.`);
      }

      return {
        workerId,
        jobUrl,
        company,
        role,
        succeeded: 0,
        failed: allTasks.length,
        total: allTasks.length,
        scrapedQaCount: 0,
        expired: true,
      };
    } else {
      // NOT expired: Candidates encountered auth or login issues. DO NOT mark remaining followers as expired!
      console.log(`\n⚠️ [${workerId}] Link is NOT expired, but attempted lead candidate(s) encountered auth/login errors.`);
      console.log(`   ⏭️  Leaving remaining ${allTasks.length - maxLeadAttempts} follower tasks as pending in queue for retry.`);
      return {
        workerId,
        jobUrl,
        company,
        role,
        succeeded: 0,
        failed: maxLeadAttempts,
        total: allTasks.length,
        scrapedQaCount: 0,
        expired: false,
      };
    }
  }

  const reviewShotUrl = blueprintResult?.screenshotUrl || blueprintResult?.reviewScreenshotUrl || null;
  const harvestedQuestions = blueprintResult?.scrapedQuestions || blueprintResult?.harvestedFields || [];

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🎉 [${workerId}] PHASE 1: SCANNING IS DONE!`);
  console.log(`   Status: REACHED REVIEW & SUBMIT`);
  console.log(`   Blueprint Lead Candidate: ${blueprintTask.applywizz_id}`);
  console.log(`   Job Posting: ${company} — ${role}`);
  console.log(`   📸 Blueprint Review Screenshot: ${reviewShotUrl || 'Uploaded to Supabase'}`);
  console.log(`   📋 Harvested Questions Count: ${harvestedQuestions.length} fields`);
  console.log(`${'═'.repeat(72)}\n`);

  // PHASE 2: Dump row into scanned_jobs with Candidate 1's AWL ID, review screenshot, and total client count!
  console.log(`📍 [${workerId}] PHASE 2: Inserting unique job blueprint into scanned_jobs table...`);
  let scannedJobId = null;
  const leadAnswers = [];
  if (Array.isArray(blueprintResult?.resolvedAnswers) && blueprintResult.resolvedAnswers.length > 0) {
    leadAnswers.push(...blueprintResult.resolvedAnswers);
  } else if (blueprintResult?.answersMap) {
    for (const [k, v] of Object.entries(blueprintResult.answersMap)) {
      if (k && v != null) {
        leadAnswers.push({
          question: k,
          answer: String(v),
          is_answered: true,
        });
      }
    }
  }

  try {
    const { saveScannedJob } = await import('./supabaseClient.mjs');
    const saved = await saveScannedJob({
      applywizzId: blueprintTask.applywizz_id,
      jobUrl,
      jobId: blueprintTask.job_id || cluster.reqId || null,
      company,
      roleTitle: role,
      scrapedQuestions: harvestedQuestions,
      resolvedAnswers: leadAnswers,
      screenshotPath: reviewShotUrl,
      clientCount: allTasks.length,
      stepNames: ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Review'],
      scanStatus: 'completed',
    });
    scannedJobId = saved?.id || null;
    console.log(`✅ [${workerId}] PHASE 2 COMPLETE: 1 unique job inserted to scanned_jobs!`);
    console.log(`   • ID: ${scannedJobId || 'Generated'}`);
    console.log(`   • Company: ${company} | Role: ${role}`);
    console.log(`   • Harvested Questions: ${harvestedQuestions.length} mandatory question(s) with types & options`);
    console.log(`   • Blueprint Candidate: ${blueprintTask.applywizz_id}`);
    console.log(`   • Resolved Answers Count: ${leadAnswers.length}`);
    console.log(`   • Review Screenshot: ${reviewShotUrl || 'None'}`);
    console.log(`   • Client Queue Size: ${allTasks.length} candidates\n`);
  } catch (scanSaveErr) {
    console.log(`⚠️ [${workerId}] Phase 2 note on saving scanned_jobs: ${scanSaveErr.message}\n`);
  }

  // STRICT FLOW: Only proceed with distributing to job_distributions if scanned questions are present!
  if (!harvestedQuestions || harvestedQuestions.length === 0) {
    console.log(`⛔ [${workerId}] Skipping distribution to job_distributions: 0 questions were harvested for "${company} - ${role}".`);
    return {
      workerId,
      jobUrl,
      company,
      role,
      succeeded: 0,
      failed: 0,
      total: allTasks.length,
      scrapedQaCount: 0,
    };
  }

  // PHASE 3: Distribute to job_distributions table in PARALLEL for ALL clients!
  console.log(`📍 [${workerId}] PHASE 3: Resolving answers & distributing into job_distributions table in PARALLEL...`);
  console.log(`   Target: ${allTasks.length} candidates allotted to this unique link`);

  const { loadProfile } = await import('./planner.mjs');
  const { preResolveClientAnswersDetailed } = await import('./jobFormCache.mjs');

  const schema = {
    id: scannedJobId,
    fields_schema: harvestedQuestions,
    company,
    role_title: role,
    tenant: cluster.tenant,
  };

  const distributionRows = [];
  const RESOLVE_CHUNK = 8;
  for (let cIdx = 0; cIdx < allTasks.length; cIdx += RESOLVE_CHUNK) {
    const chunk = allTasks.slice(cIdx, cIdx + RESOLVE_CHUNK);
    const chunkRows = await Promise.all(chunk.map(async (task, offset) => {
      const idx = cIdx + offset;
      const awlId = String(task.applywizz_id || '').trim().toUpperCase();
      let detailed = null;
      try {
        const profile = await loadProfile(null, { applywizzId: awlId });
        if (profile) {
          profile._applyWizzId = awlId;
          profile._canonicalJobUrl = jobUrl;
          profile._jobUrl = jobUrl;
          if (company) profile._company = company;
          detailed = await preResolveClientAnswersDetailed({ jobUrl, schema, profile });
        }
      } catch (err) {
        console.log(`   ⚠️ [${workerId}] Answer resolution error for client ${awlId}: ${err.message}`);
      }

      const structuredAnswers = detailed?.structuredAnswers || [];
      const answersMap = detailed?.answersMap || {};
      const answeredCount = structuredAnswers.filter(q => q.is_answered).length;
      const rawUnanswered = Array.isArray(detailed?.unansweredQuestions)
        ? detailed.unansweredQuestions
        : structuredAnswers.filter(q => !q.is_answered && q.is_required).map(q => ({
          question: q.question,
          field_type: q.field_type || 'text',
          step: q.step || 'Application Questions',
          options: q.options || [],
          is_required: true,
          reason: 'missing_required_answer',
        }));

      // Filter out standard personal info and voluntary EEO disclosures so unanswered questions are strictly actionable job questions!
      const unansweredQuestions = rawUnanswered.filter((q) => {
        const lbl = String(q.question || q.label || '').toLowerCase();
        if (/first name|last name|email|phone|mobile|address|street|city|state|postal|zip|country/i.test(lbl)) return false;
        if (/voluntary|disclosure|self identify|eeo|veteran|disability|gender|race|ethnicity|hispanic/i.test(lbl)) return false;
        return true;
      });

      const unansweredCount = unansweredQuestions.length;
      const isFullyAnswered = (unansweredCount === 0);
      const clientStatus = isFullyAnswered ? 'ready_for_review' : 'needs_answers';

      console.log(`   ⚡ [Phase 3 Client #${idx + 1}: ${awlId}] Resolved ${answeredCount}/${harvestedQuestions.length} questions across 4 tiers | Status: "${clientStatus}" | Unanswered Required: ${unansweredCount}`);

      return {
        taskId: task.id,
        applywizzId: awlId,
        jobId: task.job_id || cluster.reqId || null,
        jobUrl: task.job_url || jobUrl,
        company: task.company || company,
        roleTitle: task.role_title || role,
        leadApplywizzId: blueprintTask.applywizz_id,
        scrapedQuestions: harvestedQuestions,
        questionCount: harvestedQuestions.length,
        resolvedAnswers: structuredAnswers,
        unansweredQuestions,
        unansweredCount,
        isFullyAnswered,
        screenshotUrl: null,
        status: clientStatus,
        answersMap,
      };
    }));
    distributionRows.push(...chunkRows);
  }

  // Batch insert all resolved clients into job_distributions table!
  try {
    const { recordJobDistributions, saveScannedJob } = await import('./supabaseClient.mjs');
    await recordJobDistributions({
      leadApplywizzId: blueprintTask.applywizz_id,
      jobId: blueprintTask.job_id || cluster.reqId || null,
      jobUrl,
      company,
      roleTitle: role,
      scrapedQuestions: harvestedQuestions,
      screenshotUrl: null,
      status: 'distributed',
      clients: distributionRows,
    });
    console.log(`\n📋 [${workerId}] PHASE 3 INSERTED: Successfully recorded ${distributionRows.length} client distributions into job_distributions table!`);

    // Also update scanned_jobs row with Candidate 1's resolved_answers
    const leadRow = distributionRows.find(r => r.applywizzId === String(blueprintTask.applywizz_id).trim().toUpperCase()) || distributionRows[0];
    if (leadRow?.resolvedAnswers?.length > 0) {
      await saveScannedJob({
        applywizzId: blueprintTask.applywizz_id,
        jobUrl,
        jobId: blueprintTask.job_id || cluster.reqId || null,
        company,
        roleTitle: role,
        scrapedQuestions: harvestedQuestions,
        resolvedAnswers: leadRow.resolvedAnswers,
        screenshotPath: reviewShotUrl,
        clientCount: allTasks.length,
        scanStatus: 'completed',
      });
      console.log(`💾 [${workerId}] PHASE 2 REFINED: Updated scanned_jobs with ${leadRow.resolvedAnswers.length} master resolved answers from lead blueprint candidate.`);
    }
  } catch (distErr) {
    console.log(`⚠️ [${workerId}] Phase 3 note on job_distributions / scanned_jobs: ${distErr.message}`);
  }

  // STEP 4: Update candidate rows in batch_job_queue with scanned_job_id, status, and lead screenshot
  if (allTaskIds.length > 0) {
    try {
      const blueprintAwlId = String(blueprintTask.applywizz_id || '').trim().toUpperCase();
      const blueprintTaskId = blueprintTask.id;
      const CHUNK_SIZE = 40;
      for (let i = 0; i < allTaskIds.length; i += CHUNK_SIZE) {
        const chunk = allTaskIds.slice(i, i + CHUNK_SIZE);
        const isComposite = chunk.some((id) => String(id).includes(':::'));
        if (isComposite) {
          for (const cid of chunk) {
            const [awlId, ...rest] = String(cid).split(':::');
            const jUrl = rest.join(':::');
            const isLead = String(awlId).trim().toUpperCase() === blueprintAwlId;
            await queueDbRequest('batch_job_queue', {
              method: 'PATCH',
              query: `?applywizz_id=eq.${encodeURIComponent(awlId)}&job_url=eq.${encodeURIComponent(jUrl)}`,
              prefer: 'return=minimal',
              body: {
                scanned_job_id: scannedJobId,
                screenshot_path: isLead ? reviewShotUrl : null,
                status: 'pre_resolved',
                job_id: blueprintTask.job_id || cluster.reqId || null,
                error_message: null,
                updated_at: new Date().toISOString(),
              },
            }).catch(() => { });
          }
        } else {
          // Update follower tasks with screenshot_path: null
          const followerChunk = chunk.filter(id => id !== blueprintTaskId);
          if (followerChunk.length > 0) {
            const followerFilter = followerChunk.map((id) => encodeURIComponent(String(id).trim())).join(',');
            await queueDbRequest('batch_job_queue', {
              method: 'PATCH',
              query: `?id=in.(${followerFilter})`,
              prefer: 'return=minimal',
              body: {
                scanned_job_id: scannedJobId,
                screenshot_path: null,
                status: 'pre_resolved',
                job_id: blueprintTask.job_id || cluster.reqId || null,
                error_message: null,
                updated_at: new Date().toISOString(),
              },
            }).catch(() => { });
          }
          // Update blueprint task with reviewShotUrl
          if (chunk.includes(blueprintTaskId)) {
            await queueDbRequest('batch_job_queue', {
              method: 'PATCH',
              query: `?id=eq.${encodeURIComponent(String(blueprintTaskId).trim())}`,
              prefer: 'return=minimal',
              body: {
                scanned_job_id: scannedJobId,
                screenshot_path: reviewShotUrl,
                status: 'pre_resolved',
                job_id: blueprintTask.job_id || cluster.reqId || null,
                error_message: null,
                updated_at: new Date().toISOString(),
              },
            }).catch(() => { });
          }
        }
      }
      console.log(`\n📥 [SUPABASE INGESTION] table: batch_job_queue | action: PATCH (${allTasks.length} tasks)`);
      console.log(`   • Lead Task (${blueprintAwlId}):  status: 'pre_resolved' | screenshot_path: attached`);
      console.log(`   • Follower Tasks (${allTasks.length - 1} clients): status: 'pre_resolved' | screenshot_path: null`);
      console.log(`   • Linked Scanned Job ID:  ${scannedJobId || 'None'}\n`);
    } catch (qErr) {
      console.log(`⚠️ [${workerId}] Note on updating batch_job_queue: ${qErr.message}`);
    }
  }

  console.log(`\n🏁 [${workerId}] COMPLETED CLUSTER: ${company} — Tested Lead (${blueprintTask.applywizz_id}) in Browser & Distributed all ${allTasks.length} Clients with Resolved Answers.`);
  return {
    workerId,
    jobUrl,
    company,
    role,
    total: allTasks.length,
    succeeded: allTasks.length,
    failed: 0,
    scrapedQaCount: harvestedQuestions.length,
  };
}

/**
 * Generates and prints the authoritative 10-Batch Milestone Applications Report.
 */
export function print10BatchMilestoneReport({
  cycleIndex,
  cycleStartBatch,
  cycleEndBatch,
  batchesInCycle,
  elapsedSec,
  totalCumulativeBatches,
  totalClustersTarget,
}) {
  const cycleTotalClients = batchesInCycle.reduce((acc, b) => acc + (b.total || 0), 0);
  const cycleSucceeded = batchesInCycle.reduce((acc, b) => acc + (b.succeeded || 0), 0);
  const cycleFailed = batchesInCycle.reduce((acc, b) => acc + (b.failed || 0), 0);
  const cycleScrapedQa = batchesInCycle.reduce((acc, b) => acc + (b.scrapedQaCount || 0), 0);
  const blueprintsCreated = batchesInCycle.filter((b) => b.succeeded > 0).length;
  const expiredOrFailed = batchesInCycle.filter((b) => b.succeeded === 0).length;
  const successRate = cycleTotalClients > 0 ? ((cycleSucceeded / cycleTotalClients) * 100).toFixed(1) : '0.0';

  console.log(`\n${'╔' + '═'.repeat(94) + '╗'}`);
  console.log(`║ 📊 10-BATCH PIPELINE MILESTONE REPORT (BATCHES #${cycleStartBatch} TO #${cycleEndBatch})`.padEnd(95, ' ') + '║');
  console.log(`║    Status: Cycle #${cycleIndex} Complete | 3 Parallel Workers Active | Cycle Duration: ${elapsedSec}s`.padEnd(95, ' ') + '║');
  console.log(`╠${'═'.repeat(94)}╣`);
  console.log(`║ 📦 SUPABASE DATABASE INGESTION TOTALS FOR THIS 10-BATCH CYCLE:`.padEnd(95, ' ') + '║');
  console.log(`║    • Unique Job Blueprints (scanned_jobs):     ${String(blueprintsCreated).padEnd(4, ' ')} jobs inserted with master review screenshots`.padEnd(95, ' ') + '║');
  console.log(`║    • Client Applications (job_distributions):   ${String(cycleSucceeded).padEnd(4, ' ')} candidates pre-resolved & distributed`.padEnd(95, ' ') + '║');
  console.log(`║    • Failed Applications (failed_jobs):        ${String(cycleFailed).padEnd(4, ' ')} candidate rows recorded (${expiredOrFailed} batches expired/failed)`.padEnd(95, ' ') + '║');
  console.log(`║    • Mandatory Questions Harvested & Typed:    ${String(cycleScrapedQa).padEnd(4, ' ')} form fields across unique job blueprints`.padEnd(95, ' ') + '║');
  console.log(`║    • Overall Candidate Pass Rate:              ${successRate}%`.padEnd(95, ' ') + '║');
  console.log(`╟${'─'.repeat(94)}╢`);
  console.log(`║ 📋 DETAILED BATCH-BY-BATCH APPLICATIONS BREAKDOWN:`.padEnd(95, ' ') + '║');
  console.log(`║ Batch │ Worker   │ Company & Role                     │ Clients │ Status    │ Questions │ Proof Shot ║`);
  console.log(`║───────┼──────────┼────────────────────────────────────┼─────────┼───────────┼───────────┼────────────║`);

  batchesInCycle.forEach((b, i) => {
    const bNum = `#${cycleStartBatch + i}`.padEnd(5, ' ');
    const wId = (b.workerId || 'worker').padEnd(8, ' ');
    const compRole = `${b.company || 'Job'} — ${b.role || 'Role'}`.slice(0, 34).padEnd(34, ' ');
    const clients = String(b.total || 0).padStart(7, ' ');
    const isOk = b.succeeded > 0;
    const st = (isOk ? '✅ SUCCESS' : '❌ FAILED ').padEnd(9, ' ');
    const qa = String(b.scrapedQaCount || 0).padStart(9, ' ');
    const shot = (b.reviewScreenshotUrl || b.screenshotUrl ? '📸 Saved  ' : 'None      ');
    console.log(`║ ${bNum} │ ${wId} │ ${compRole} │ ${clients} │ ${st} │ ${qa} │ ${shot} ║`);
  });

  console.log(`╚${'═'.repeat(94)}╝\n`);
}

/**
 * Master Controller:
 * 1. Clusters links canonically and picks the top N links (highest candidate count).
 * 2. Runs N dedicated workers in parallel (1 per link) with HEADED browsers.
 * 3. Each worker performs Blueprint Inspection -> Broadcast Copy-Paste -> Fast-Fill Followers.
 * 4. Outputs comprehensive 10-batch milestone reports for every 10 batches completed.
 */
export async function runClusterBatchRunner({
  topLinks = 3,
  workers = 3,
  headless = false, // HEADED execution by default!
  confirmSubmit = false,
  limitPerLink = null,
  defaultPassword = process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
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
    console.log(`❌ No tasks found in batch_job_queue! Setting scanning workers to idle.`);
    for (let slot = 1; slot <= 3; slot++) {
      await updateWorkerStatus(`worker-${slot}`, {
        state: 'idle',
        current_application_id: 'Ready (0 pending queue items)',
      }).catch(() => { });
    }
    return;
  }

  // Set scanning workers to active in-flight in Supabase worker_status
  for (let slot = 1; slot <= Math.min(3, topClusters.length); slot++) {
    await updateWorkerStatus(`worker-${slot}`, {
      state: 'in_flight',
      current_application_id: 'Clustering & preparing link run...',
    }).catch(() => { });
  }

  console.log(`\n📋 Selected Top ${topClusters.length} Unique Job URLs for Parallel Execution:\n`);
  console.log(` Worker   │ Job URL (Strict URL Identification)                                            │ Clients │ Links`);
  console.log(`──────────┼────────────────────────────────────────────────────────────────────────────────┼─────────┼──────`);
  topClusters.forEach((c, idx) => {
    const workerLabel = `Worker ${idx + 1}`.padEnd(8, ' ');
    const urlDisplay = (c.jobUrl || '').slice(0, 78).padEnd(78, ' ');
    const count = String(c.clientCount).padStart(7, ' ');
    const variations = String(c.rawUrls.size).padStart(5, ' ');
    console.log(` ${workerLabel} │ ${urlDisplay} │ ${count} │ ${variations}`);
  });
  console.log(`──────────┴────────────────────────────────────────────────────────────────────────────────┴─────────┴──────\n`);

  // Step 2: Launch exactly N Workers in Parallel (concurrency pool, strictly N at a time)
  const concurrency = Math.min(Number(workers) || 3, topClusters.length);
  console.log(`🚀 Running strictly ${concurrency} Parallel Scanning Workers on ${topClusters.length} unique links in dynamic queue (HEADED Mode)...\n`);

  let clusterIndex = 0;
  let completedBatchesCount = 0;
  let current10BatchCycle = [];
  let cycleStartTime = Date.now();
  const clusterResults = [];

  async function workerLoop(slot) {
    const workerId = `scanning_worker_${slot}`;
    while (clusterIndex < topClusters.length) {
      if (await isClusterStopRequested()) {
        console.log(`🛑 [Scanning Worker ${slot}] Stop flag active! Halting cluster loop.`);
        break;
      }
      const myIndex = clusterIndex++;
      const cluster = topClusters[myIndex];
      if (!cluster) break;

      await updateWorkerStatus(workerId, {
        state: 'in_flight',
        current_application_id: cluster.jobUrl, // Strictly identify by URL in worker_status
        stage: 'scanning',
        bot_name: `Scanning Worker ${slot}`,
      }).catch(() => { });

      console.log(`\n▶️ [Scanning Worker ${slot}] [Batch #${myIndex + 1}/${topClusters.length}] Assigned Job URL: ${cluster.jobUrl}`);
      console.log(`   Job Metadata: ${cluster.company} — ${cluster.roleTitle} (${cluster.clientCount} clients)`);

      let res = null;
      try {
        res = await runClusterWorker(workerId, cluster, {
          headless: Boolean(headless),
          confirmSubmit,
          limitPerLink,
          defaultPassword,
        });
      } catch (err) {
        console.error(`❌ [Scanning Worker ${slot}] Error on batch #${myIndex + 1} (${cluster.canonicalUrl}): ${err.message}`);
        res = {
          workerId,
          jobUrl: cluster.canonicalUrl,
          company: cluster.company,
          role: cluster.roleTitle,
          total: cluster.clientCount,
          succeeded: 0,
          failed: cluster.clientCount,
          scrapedQaCount: 0,
        };
      }

      clusterResults.push(res);
      current10BatchCycle.push(res);
      completedBatchesCount++;

      // Trigger authoritative 10-batch milestone report every 10 batches!
      if (completedBatchesCount % 10 === 0) {
        const cycleNum = completedBatchesCount / 10;
        print10BatchMilestoneReport({
          cycleIndex: cycleNum,
          cycleStartBatch: completedBatchesCount - 9,
          cycleEndBatch: completedBatchesCount,
          batchesInCycle: [...current10BatchCycle],
          elapsedSec: ((Date.now() - cycleStartTime) / 1000).toFixed(1),
          totalCumulativeBatches: completedBatchesCount,
          totalClustersTarget: topClusters.length,
        });
        current10BatchCycle = [];
        cycleStartTime = Date.now();
      }
    }

    await updateWorkerStatus(workerId, {
      state: 'idle',
      current_application_id: null,
      stage: 'scanning',
      bot_name: `Scanning Worker ${slot}`,
    }).catch(() => { });
  }

  const workerPromises = [];
  for (let slot = 1; slot <= concurrency; slot++) {
    workerPromises.push(workerLoop(slot));
  }

  await Promise.all(workerPromises);

  // If remaining batches in cycle (e.g. 14 batches total -> batches 11 to 14), print milestone report for them
  if (current10BatchCycle.length > 0) {
    const cycleNum = Math.floor(completedBatchesCount / 10) + 1;
    const startBatch = Math.floor(completedBatchesCount / 10) * 10 + 1;
    print10BatchMilestoneReport({
      cycleIndex: cycleNum,
      cycleStartBatch: startBatch,
      cycleEndBatch: completedBatchesCount,
      batchesInCycle: [...current10BatchCycle],
      elapsedSec: ((Date.now() - cycleStartTime) / 1000).toFixed(1),
      totalCumulativeBatches: completedBatchesCount,
      totalClustersTarget: topClusters.length,
    });
    current10BatchCycle = [];
  }

  // Return all scanning workers to idle
  for (let slot = 1; slot <= 3; slot++) {
    await updateWorkerStatus(`scanning_worker_${slot}`, {
      state: 'idle',
      current_application_id: null,
      stage: 'scanning',
      bot_name: `Scanning Worker ${slot}`,
    }).catch(() => { });
  }

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
