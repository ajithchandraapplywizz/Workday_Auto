/**
 * lib/demoRunner.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Blueprint Pre-fill Controller (40-Client Parallel Batch with Screenshots)
 * ─────────────────────────────────────────────────────────────────────────────
 * Flow:
 *   1. Client 1 (Blueprint): Runs full apply -> scrapes Q&A from Review DOM
 *      -> captures screenshot -> saves JSON & screenshot to Supabase row 1.
 *   2. Copies scraped Q&A JSON to all remaining 39 client rows in Supabase.
 *   3. Runs 5 concurrent workers to fill Clients 2-40 in parallel:
 *      - Injects scraped Q&A as Tier 1 instant answers (5-8s per client).
 *      - Captures final screenshot of each application (success or failure).
 *      - Updates each client row with status and screenshot path.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import {
  isSupabaseConfigured,
  uploadStorageScreenshot,
} from './supabaseClient.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';
import { loadProfile } from './planner.mjs';
import { fillForm } from './engine.mjs';
import { scanForm } from './scanner.mjs';
import { resolveCompanyEmail } from './applyWizzClient.mjs';

// ── Supabase REST helpers for demo_client_applications ────────────────────────

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

async function dbRequest(path, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
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
  }, { attempts: 2, label: 'DemoSupabase' });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${String(res.text || '').slice(0, 180)}`);
  if (!res.text) return null;
  return res.json();
}

/**
 * Ingest/ensure rows exist in demo_client_applications for this job link and client list.
 */
export async function ingestDemoBatchRows(jobUrl, clientIds = [], { company = '', roleTitle = '' } = {}) {
  const cleanUrl = String(jobUrl || '').trim();
  if (!cleanUrl || !clientIds.length) return [];
  if (!isSupabaseConfigured()) {
    console.log('  ⚠️ Supabase not configured; demo rows will be tracked in-memory.');
    return clientIds.map((id, idx) => ({
      job_url: cleanUrl,
      awl_id: id,
      is_blueprint: idx === 0,
      status: 'pending',
    }));
  }

  try {
    const rows = clientIds.map((id, index) => ({
      job_url: cleanUrl,
      awl_id: id.trim(),
      company: company || null,
      role_title: roleTitle || null,
      is_blueprint: index === 0,
      status: 'pending',
      scraped_qa_json: {},
      updated_at: new Date().toISOString(),
    }));

    await dbRequest('demo_client_applications', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows,
    });
    console.log(`  ✅ Ingested ${rows.length} client rows into demo_client_applications for this job.`);
    return rows;
  } catch (err) {
    console.log(`  ⚠️ ingestDemoBatchRows note: ${err.message}`);
    return [];
  }
}

/**
 * Update a specific client row in demo_client_applications.
 */
export async function updateDemoClientRow(jobUrl, awlId, updates = {}) {
  if (!isSupabaseConfigured()) return;
  try {
    const cleanUrl = encodeURIComponent(String(jobUrl || '').trim());
    const cleanId = encodeURIComponent(String(awlId || '').trim());
    await dbRequest('demo_client_applications', {
      method: 'PATCH',
      query: `?job_url=eq.${cleanUrl}&awl_id=eq.${cleanId}`,
      prefer: 'return=minimal',
      body: {
        ...updates,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.log(`  ⚠️ updateDemoClientRow error for ${awlId}: ${err.message}`);
  }
}

/**
 * Copy blueprint scraped Q&A to all remaining client rows in demo_client_applications.
 */
export async function broadcastScrapedQaToFollowers(jobUrl, scrapedQaJson = {}) {
  if (!isSupabaseConfigured() || !scrapedQaJson || Object.keys(scrapedQaJson).length === 0) return;
  try {
    const cleanUrl = encodeURIComponent(String(jobUrl || '').trim());
    await dbRequest('demo_client_applications', {
      method: 'PATCH',
      query: `?job_url=eq.${cleanUrl}&is_blueprint=eq.false&status=eq.pending`,
      prefer: 'return=minimal',
      body: {
        scraped_qa_json: scrapedQaJson,
        status: 'pre_filled',
        updated_at: new Date().toISOString(),
      },
    });
    console.log(`  📡 Broadcasted scraped Q&A JSON to all follower client rows.`);
  } catch (err) {
    console.log(`  ⚠️ broadcastScrapedQaToFollowers error: ${err.message}`);
  }
}

// ── Screenshot Helper ─────────────────────────────────────────────────────────

async function captureAndSaveScreenshot(page, applywizzId, status, bucketName = 'application-successes') {
  const screenshotsDir = resolve(process.cwd(), 'screenshots');
  if (!existsSync(screenshotsDir)) {
    mkdirSync(screenshotsDir, { recursive: true });
  }

  const filename = `demo_${applywizzId}_${status}_${Date.now()}.jpg`;
  const localPath = join(screenshotsDir, filename);

  let buffer = null;
  try {
    if (page && !page.isClosed()) {
      buffer = await page.screenshot({ type: 'jpeg', quality: 85 }).catch(() => null);
      if (buffer) {
        writeFileSync(localPath, buffer);
      }
    }
  } catch {}

  let remoteUrl = null;
  if (buffer && isSupabaseConfigured()) {
    try {
      remoteUrl = await uploadStorageScreenshot(bucketName, filename, buffer);
    } catch {}
  }

  return remoteUrl || localPath;
}

// ── Single Client Runner ──────────────────────────────────────────────────────

async function runSingleDemoClient({
  jobUrl,
  applywizzId,
  isBlueprint = false,
  preResolvedAnswers = {},
  headless = true,
  confirmSubmit = false,
  defaultPassword = '',
  workerId = 'Worker-1',
}) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🚀 [${workerId}] Starting ${isBlueprint ? 'BLUEPRINT' : 'PRE-FILL'} Client: ${applywizzId}`);
  console.log(`${'─'.repeat(60)}`);

  await updateDemoClientRow(jobUrl, applywizzId, {
    status: isBlueprint ? 'blueprint_scanning' : 'filling',
    worker_id: workerId,
  });

  // Load candidate profile
  const profilePath = resolve(process.cwd(), 'config/profile.yml');
  const profile = await loadProfile(existsSync(profilePath) ? profilePath : null, { applywizzId });
  profile._applyWizzId = applywizzId;
  profile._canonicalJobUrl = jobUrl;
  profile._jobUrl = jobUrl;

  // If we have pre-resolved answers (scraped from blueprint), inject them directly into Tier 1 QA
  if (preResolvedAnswers && Object.keys(preResolvedAnswers).length > 0) {
    profile._supabaseQa = { ...(profile._supabaseQa || {}), ...preResolvedAnswers };
    profile._answerCache = profile._answerCache || new Map();
    for (const [k, v] of Object.entries(preResolvedAnswers)) {
      profile._answerCache.set(k, v);
    }
    console.log(`  ⚡ [${workerId}] Loaded ${Object.keys(preResolvedAnswers).length} scraped Q&A pairs into Tier 1 memory.`);
  }

  const candidateEmail = resolveCompanyEmail(profile.personal || profile, [profile.personal?.first_name, profile.personal?.last_name].filter(Boolean).join(' ') || profile.name || '');
  const workdayEmail = candidateEmail || profile.personal?.email || '';
  const workdayPassword = defaultPassword || process.env.WORKDAY_PASSWORD || '';

  if (!workdayEmail || !workdayPassword) {
    const err = `Missing credentials for ${applywizzId}`;
    console.log(`  ❌ [${workerId}] ${err}`);
    await updateDemoClientRow(jobUrl, applywizzId, { status: 'failed', error_message: err });
    return { status: 'failed', error: err, scrapedQa: {} };
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Step 1: Scan
    console.log(`  [${workerId}] Step 1: Connecting to job portal...`);
    const scan = await scanForm(jobUrl, { browser, context, page });

    // Step 2: Fill Form
    console.log(`  [${workerId}] Step 2: Executing form fill (Blueprint: ${isBlueprint})...`);
    const fillResult = await fillForm(jobUrl, {
      browser,
      context,
      page,
      profile,
      workdayEmail,
      workdayPassword,
      mode: 'signin',
      confirmSubmit,
      dryRun: !confirmSubmit,
      isBatch: true,
    });

    const isSuccess = (fillResult.status === 'submitted' || fillResult.status === 'reached-review' || fillResult.status === 'reached_review');
    const finalStatus = isSuccess ? (confirmSubmit ? 'submitted' : 'reached_review') : 'failed';

    // Step 3: Capture screenshot
    const bucket = isSuccess ? 'application-successes' : 'application-failures';
    const screenshotUrl = await captureAndSaveScreenshot(page, applywizzId, finalStatus, bucket);

    // Step 4: Extract scraped review map (only populated on Review page)
    const scrapedQa = profile._scrapedReviewMap || {};
    const qaCount = Object.keys(scrapedQa).length;

    if (isBlueprint && qaCount > 0) {
      console.log(`  🎯 [${workerId}] BLUEPRINT SUCCESS: Scraped ${qaCount} Q&A pairs from Review DOM!`);
    }

    // Step 5: Update Supabase row
    await updateDemoClientRow(jobUrl, applywizzId, {
      status: finalStatus,
      scraped_qa_json: isBlueprint ? scrapedQa : (Object.keys(preResolvedAnswers).length ? preResolvedAnswers : scrapedQa),
      screenshot_url: isSuccess ? screenshotUrl : null,
      failure_screenshot_url: !isSuccess ? screenshotUrl : null,
      error_message: isSuccess ? null : (fillResult.reason || fillResult.status),
    });

    console.log(`  ✅ [${workerId}] Finished ${applywizzId} -> Status: ${finalStatus} | Screenshot: ${screenshotUrl?.slice(0, 70)}...`);

    await browser.close().catch(() => {});
    return { status: finalStatus, scrapedQa, screenshotUrl };
  } catch (err) {
    console.log(`  ❌ [${workerId}] Error on ${applywizzId}: ${err.message}`);
    const failShot = await captureAndSaveScreenshot(page, applywizzId, 'error', 'application-failures');
    await updateDemoClientRow(jobUrl, applywizzId, {
      status: 'failed',
      failure_screenshot_url: failShot,
      error_message: err.message,
    });
    await browser.close().catch(() => {});
    return { status: 'failed', error: err.message, scrapedQa: {} };
  }
}

// ── Main Controller: Run 40 Clients with 5 Parallel Workers ──────────────────

/**
 * Run demo batch:
 *   1. Client 1 (Blueprint) runs first -> scrapes Q&A -> updates Supabase.
 *   2. Copies scraped Q&A to remaining 39 clients.
 *   3. 5 concurrent workers process clients 2-40 in parallel using that Q&A.
 */
export async function runDemoBatch({
  jobUrl,
  clientIds = [],
  concurrency = 5,
  headless = false,
  confirmSubmit = false,
  defaultPassword = '',
} = {}) {
  const cleanUrl = String(jobUrl || '').trim();
  if (!cleanUrl) {
    console.error('❌ Job URL is required for demo run.');
    return;
  }
  if (!clientIds.length) {
    console.error('❌ At least 1 client ID is required for demo run.');
    return;
  }

  const startTime = Date.now();
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🔥 40-CLIENT BLUEPRINT PRE-FILL CONTROLLER (5 WORKERS)`);
  console.log(`   Job URL:     ${cleanUrl}`);
  console.log(`   Clients:     ${clientIds.length} candidate(s)`);
  console.log(`   Concurrency: ${concurrency} parallel workers`);
  console.log(`   Mode:        ${headless ? 'Headless (Background)' : 'Headed (Visible Browser)'}`);
  console.log(`   Submission:  ${confirmSubmit ? 'AUTO-SUBMIT' : 'HALT AT REVIEW (Ready for Review)'}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Step 0: Ensure database rows exist
  await ingestDemoBatchRows(cleanUrl, clientIds);

  const blueprintId = clientIds[0];
  const followerIds = clientIds.slice(1);

  // ── Step 1: Run Blueprint Client (Client 1) ─────────────────────────────────
  console.log(`\n📍 PHASE 1: Running Blueprint Client (${blueprintId})...`);
  const blueprintResult = await runSingleDemoClient({
    jobUrl: cleanUrl,
    applywizzId: blueprintId,
    isBlueprint: true,
    preResolvedAnswers: {},
    headless,
    confirmSubmit,
    defaultPassword,
    workerId: 'Worker-Blueprint',
  });

  const scrapedQa = blueprintResult.scrapedQa || {};
  const qaCount = Object.keys(scrapedQa).length;

  if (blueprintResult.status === 'failed' && qaCount === 0) {
    console.error(`\n❌ Blueprint client failed before reaching Review page. Cannot pre-fill remaining clients.`);
    return;
  }

  // ── Step 2: Broadcast Scraped Q&A to Followers ──────────────────────────────
  console.log(`\n📍 PHASE 2: Broadcasting ${qaCount} Scraped Q&A pairs to remaining ${followerIds.length} clients...`);
  await broadcastScrapedQaToFollowers(cleanUrl, scrapedQa);

  if (followerIds.length === 0) {
    console.log(`\n✅ Blueprint run completed. No follower clients specified.`);
    return;
  }

  // ── Step 3: Run Remaining Clients with 5 Parallel Workers ───────────────────
  console.log(`\n📍 PHASE 3: Launching ${concurrency} Concurrent Workers for Clients 2 to ${clientIds.length}...`);

  let currentIndex = 0;
  const results = [blueprintResult];

  async function workerLoop(workerNum) {
    const workerId = `Worker-${workerNum}`;
    while (currentIndex < followerIds.length) {
      const myIdx = currentIndex++;
      if (myIdx >= followerIds.length) break;
      const targetAwlId = followerIds[myIdx];

      const res = await runSingleDemoClient({
        jobUrl: cleanUrl,
        applywizzId: targetAwlId,
        isBlueprint: false,
        preResolvedAnswers: scrapedQa,
        headless,
        confirmSubmit,
        defaultPassword,
        workerId,
      });
      results.push(res);
    }
  }

  const workerPromises = [];
  const effectiveConcurrency = Math.min(concurrency, followerIds.length);
  for (let w = 1; w <= effectiveConcurrency; w++) {
    workerPromises.push(workerLoop(w));
  }

  await Promise.all(workerPromises);

  // ── Step 4: Summary Report ──────────────────────────────────────────────────
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = results.filter((r) => r.status === 'submitted' || r.status === 'reached_review').length;
  const failCount = results.filter((r) => r.status === 'failed').length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏁 DEMO RUN COMPLETE in ${elapsedSec}s`);
  console.log(`   Total Clients:  ${clientIds.length}`);
  console.log(`   Successful:     ${successCount}`);
  console.log(`   Failed:         ${failCount}`);
  console.log(`   Scraped Q&A:    ${qaCount} fields stored in column 3`);
  console.log(`   Screenshots:    Captured for all applications in column 4`);
  console.log(`${'═'.repeat(70)}\n`);
}
