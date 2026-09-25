/**
 * workerPool.mjs — 3-Worker Parallel Execution Engine
 *
 * Runs up to N (default 3) workers concurrently:
 * - Each worker processes an (applywizz_id, job_url) task.
 * - Isolated browser context & client profile per worker.
 * - Form schema caching in Supabase:
 *   - Unique links: scans & persists form schema to Supabase (job_form_schemas).
 *   - Repeat links: loads cached schema & pre-resolves candidate answers prior to filling.
 * - Updates batch_job_queue and applications tables in Supabase in real-time.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { scanForm, slugify } from './scanner.mjs';
import { fillForm } from './engine.mjs';
import { loadProfile, generatePlan, pickResume } from './planner.mjs';
import { extractJDText, detectATS, validateWorkdayUrl, extractWorkdayCompanyName, extractJobRoleFromDom, isWorkdayWizardVisible } from './discovery.mjs';
import { resolveCompanyEmail } from './applyWizzClient.mjs';
import { checkAndPreResolveJobForClient, recordDiscoveredJobForm, bulkPreResolveForJobUrl } from './jobFormCache.mjs';
import { upsertSupabaseApplication, updateQueueTaskStatus, leaseNextQueueTask, getBatchQueueStats } from './supabaseClient.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findFilePath(relPath) {
  const candidates = [
    resolve(process.cwd(), relPath),
    resolve(__dirname, '..', relPath),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

/**
 * Execute a single job application task within an isolated worker context.
 */
export async function executeWorkerTask({
  task,
  workerId = 'Worker-1',
  taskIndex = 1,
  totalTasks = 1,
  options = {},
}) {
  const {
    headless = true,
    confirmSubmit = false,
    dryRun = false,
    defaultPassword = process.env.WORKDAY_PASSWORD || '',
  } = options;

  const applywizzId = task.applywizzId || task.applywizz_id || task.candidateId || '';
  const rawJobUrl = task.jobUrl || task.job_url || task.url || '';
  const jobUrl = String(rawJobUrl).replace(/\s+/g, '').trim();
  const queueTaskId = task.queueTaskId || task.queue_task_id || task.id || '';
  const company = task.company || extractWorkdayCompanyName(jobUrl);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`🚀 [${workerId}] [${taskIndex}/${totalTasks}] Starting task for ${applywizzId}`);
  console.log(`   🏢 Company: ${company || 'Workday'}`);
  console.log(`   🔗 URL: ${jobUrl}`);
  console.log(`${'─'.repeat(70)}`);

  // 1. Validate Workday URL
  const check = validateWorkdayUrl(jobUrl);
  if (!check.valid) {
    console.error(`   ❌ [${workerId}] Invalid Workday URL: ${check.reason}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: check.reason });
    return { status: 'invalid_url', error: check.reason };
  }

  // 2. Load isolated Client Profile for this applywizzId
  let profile;
  try {
    const profilePath = findFilePath('config/profile.yml');
    profile = await loadProfile(existsSync(profilePath) ? profilePath : null, { applywizzId });
    profile._applyWizzId = applywizzId;
    profile._canonicalJobUrl = jobUrl;
    profile._jobUrl = jobUrl;
    if (company) profile._company = company;
  } catch (err) {
    console.error(`   ❌ [${workerId}] Failed to load profile for ${applywizzId}: ${err.message}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: err.message });
    return { status: 'profile_load_failed', error: err.message };
  }

  // 3. Resolve Workday credentials for this candidate
  const candidateEmail = resolveCompanyEmail(profile.personal || profile, [profile.personal?.first_name, profile.personal?.last_name].filter(Boolean).join(' ') || profile.name || '');
  const workdayEmail = candidateEmail || profile.personal?.email || '';
  const workdayPassword = defaultPassword || process.env.WORKDAY_PASSWORD || '';

  console.log(`   📧 [${workerId}] Using candidate credentials: ${workdayEmail} for ${applywizzId}`);

  if (!workdayEmail || !workdayPassword) {
    const err = `Missing credentials for ${applywizzId} (${workdayEmail || 'no-email'})`;
    console.error(`   ❌ [${workerId}] ${err}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: err });
    return { status: 'auth_missing', error: err };
  }

  // 4. Check Job Form Cache in Supabase (Duplicate Link Detection & Pre-Resolved Cell)
  let cacheHit = false;
  const queuePreResolved = task.pre_resolved_answers || task.preResolvedAnswers;
  if (queuePreResolved && typeof queuePreResolved === 'object' && Object.keys(queuePreResolved).length > 0) {
    cacheHit = true;
    profile._supabaseQa = { ...(profile._supabaseQa || {}), ...queuePreResolved };
    profile._answerCache = profile._answerCache || new Map();
    for (const [k, v] of Object.entries(queuePreResolved)) {
      profile._answerCache.set(k, v);
    }
    console.log(`   ⚡ [${workerId}] Queue Pre-Resolved Hit: ${Object.keys(queuePreResolved).length} answers loaded directly from queue cell for instant fill.`);
  } else {
    try {
      const cacheResult = await checkAndPreResolveJobForClient({ jobUrl, profile });
      cacheHit = cacheResult.hit;
      if (cacheHit) {
        console.log(`   ⚡ [${workerId}] Cache Hit: Stored form structure loaded from Supabase.`);
      } else {
        console.log(`   🔍 [${workerId}] Cache Miss: First time encountering this job. Form will be scanned & cached.`);
      }
    } catch (err) {
      console.log(`   ⚠️ [${workerId}] Form cache check skipped: ${err.message}`);
    }
  }

  // 5. Launch isolated Playwright browser context
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Step A: Scan Form
    console.log(`   [${workerId}] Step 1: Scanning form fields...`);
    const scan = await scanForm(jobUrl, {
      browser,
      context,
      page,
      keepOpen: true,
      workdayEmail,
      workdayPassword,
      mode: 'signin',
      profile,
    });

    const roleTitle = await extractJobRoleFromDom(page, jobUrl);
    if (roleTitle) {
      profile._jobTitle = roleTitle;
      profile._roleTitle = roleTitle;
      console.log(`   [${workerId}] 💼 Role: ${roleTitle}`);
    }

    if (scan.authFailed || (scan.field_count === 0 && !await isWorkdayWizardVisible(page))) {
      const wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
      if (!wizardNow) {
        console.log(`   ❌ [${workerId}] Authentication failed for ${workdayEmail}.`);
        await browser.close();
        if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: 'auth_failed' });
        return { status: 'auth_failed' };
      }
    }

    // Step B: Pick resume for candidate
    console.log(`   [${workerId}] Step 2: Preparing resume...`);
    let jdText = '';
    try { jdText = await extractJDText(page); } catch {}
    const resumesYml = findFilePath('config/resumes.yml');
    let resumePath = null;
    if (existsSync(resumesYml)) {
      resumePath = await pickResume(jdText, resumesYml);
    }
    if (resumePath) profile._resumePath = resumePath;

    // Step C: Generate fill plan
    console.log(`   [${workerId}] Step 3: Generating plan...`);
    const plan = await generatePlan(scan, profile, { resumePath, jdText, url: jobUrl });
    if (company) plan.company = company;
    if (roleTitle) plan.role = roleTitle;

    // Save local plan backup
    try {
      const slug = slugify(jobUrl);
      const planOut = resolve(process.cwd(), 'forms', `${slug}-${applywizzId}-plan.json`);
      await writeFile(planOut, JSON.stringify(plan, null, 2));
    } catch {}

    // Step D: Fill & Submit
    console.log(`   [${workerId}] Step 4: Filling application...`);
    const status = await fillForm(jobUrl, plan, {
      browser,
      context,
      page,
      profile,
      workdayEmail,
      workdayPassword,
      mode: 'signin',
      confirmSubmit,
      dryRun,
      isBatch: true,
    });

    // Step E: Save newly discovered form schema to Supabase if unique link
    if (!cacheHit && Array.isArray(scan.fields) && scan.fields.length > 0) {
      try {
        const saved = await recordDiscoveredJobForm({
          jobUrl,
          profile,
          fields: scan.fields,
          stepNames: profile._discoveredSteps ? [...profile._discoveredSteps] : ['Application'],
          company,
          roleTitle,
        });

        // Immediately bulk-pre-resolve for all other pending clients sharing this URL.
        // loadProfileFn is injected here to avoid circular imports between jobFormCache ↔ planner.
        if (saved) {
          const { loadJobFormSchema: getSchema } = await import('./supabaseClient.mjs');
          const savedSchema = await getSchema(jobUrl).catch(() => null);
          if (savedSchema?.fields_schema?.length) {
            const profilePath = findFilePath('config/profile.yml');
            await bulkPreResolveForJobUrl({
              jobUrl,
              schema: savedSchema,
              loadProfileFn: async (awlId) => {
                const p = await loadProfile(existsSync(profilePath) ? profilePath : null, { applywizzId: awlId });
                p._applyWizzId = awlId;
                p._canonicalJobUrl = jobUrl;
                p._jobUrl = jobUrl;
                if (company) p._company = company;
                return p;
              },
            }).catch((err) => {
              console.log(`   ⚠️ [${workerId}] Bulk pre-resolve error (non-fatal): ${err.message}`);
            });
          }
        }
      } catch (err) {
        console.log(`   ⚠️ [${workerId}] Could not record job form schema to Supabase: ${err.message}`);
      }
    }

    // Step F: Record status to Supabase
    await upsertSupabaseApplication({
      applywizzId,
      jobUrl,
      company,
      roleTitle,
      status,
    }).catch(() => {});

    if (queueTaskId) {
      const finalStatus = (status === 'submitted') ? 'submitted' : (status === 'reached-review') ? 'reached_review' : 'completed';
      await updateQueueTaskStatus(queueTaskId, { status: finalStatus });
    }

    console.log(`   ✅ [${workerId}] Finished task for ${applywizzId} with status: "${status}"`);
    return { status, cacheHit };
  } catch (err) {
    console.error(`   ❌ [${workerId}] Error executing task: ${err.message}`);
    if (queueTaskId) {
      await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: err.message });
    }
    return { status: 'error', error: err.message, cacheHit };
  } finally {
    try { await browser.close(); } catch {}
  }
}

/**
 * Run tasks using a pool of N concurrent workers (default 10).
 */
export async function runWorkerPool(tasks = [], {
  concurrency = 10,
  headless = true,
  confirmSubmit = false,
  dryRun = false,
  defaultPassword = '',
} = {}) {
  const total = tasks.length;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`⚡ ${concurrency}-WORKER BATCH CONTROLLER: Running ${total} tasks with ${concurrency} parallel workers`);
  console.log(`${'═'.repeat(70)}\n`);

  const results = [];
  let currentIndex = 0;

  async function workerLoop(workerNumber) {
    const workerId = `Worker-${workerNumber}`;
    while (true) {
      const index = currentIndex++;
      if (index >= total) break;

      const task = tasks[index];
      const result = await executeWorkerTask({
        task,
        workerId,
        taskIndex: index + 1,
        totalTasks: total,
        options: {
          headless,
          confirmSubmit,
          dryRun,
          defaultPassword,
        },
      });

      results.push({
        applywizzId: task.applywizzId || task.applywizz_id,
        jobUrl: task.jobUrl || task.job_url,
        company: task.company,
        status: result.status,
        cacheHit: result.cacheHit || false,
        error: result.error,
      });
    }
  }

  // Launch parallel workers
  const workerPromises = [];
  for (let w = 1; w <= concurrency; w++) {
    workerPromises.push(workerLoop(w));
  }

  await Promise.all(workerPromises);

  // Print Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${concurrency}-WORKER EXECUTION SUMMARY`);
  console.log(`${'═'.repeat(70)}`);
  const submitted = results.filter((r) => r.status === 'submitted').length;
  const reachedReview = results.filter((r) => r.status === 'reached-review').length;
  const cacheHits = results.filter((r) => r.cacheHit).length;
  const failed = results.filter((r) => ['error', 'auth_failed', 'invalid_url', 'profile_load_failed', 'auth_missing'].includes(r.status)).length;
  const incomplete = results.length - (submitted + reachedReview + failed);

  console.log(`  Total Tasks Processed: ${results.length}`);
  console.log(`  ✅ Submitted:            ${submitted}`);
  console.log(`  🎯 Reached Review:       ${reachedReview}`);
  console.log(`  ⚡ Form Cache Hits:      ${cacheHits} (instant pre-resolved repeat links)`);
  console.log(`  🔍 Unique Form Scans:    ${results.length - cacheHits} (harvested to Supabase)`);
  console.log(`  ❌ Failed:               ${failed}`);
  if (incomplete > 0) console.log(`  ⚠️  Incomplete:           ${incomplete}`);
  console.log(`${'═'.repeat(70)}\n`);

  return results;
}

/**
 * Run workers directly against Supabase batch_job_queue.
 * Concurrently leases and processes tasks until queue is empty.
 */
export async function runQueueWorkerPool({
  concurrency = 10,
  headless = true,
  confirmSubmit = false,
  dryRun = false,
  defaultPassword = '',
  maxTasks = Infinity,
} = {}) {
  const stats = await getBatchQueueStats();
  const pendingCount = (stats?.pending || 0) + (stats?.pre_resolved || 0);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`⚡ ${concurrency}-WORKER SUPABASE QUEUE CONTROLLER`);
  console.log(`   Pending/Pre-resolved Tasks in Queue: ${pendingCount}`);
  if (stats) {
    console.log(`   [Stats: Pending=${stats.pending} | Pre-resolved=${stats.pre_resolved} | Processing=${stats.processing} | Submitted=${stats.submitted}]`);
  }
  console.log(`   Parallel Workers: ${concurrency}`);
  console.log(`${'═'.repeat(70)}\n`);

  if (pendingCount === 0) {
    console.log('ℹ️  No pending or pre_resolved tasks found in Supabase batch_job_queue.');
    return [];
  }

  const results = [];
  let processedCount = 0;
  let activeWorkers = 0;

  async function queueWorkerLoop(workerNumber) {
    const workerId = `Worker-${workerNumber}`;
    activeWorkers++;

    while (processedCount < maxTasks) {
      const task = await leaseNextQueueTask(workerId);
      if (!task) {
        // Wait briefly and try one more time in case bulk pre-resolution is running
        await new Promise((r) => setTimeout(r, 1500));
        const retryTask = await leaseNextQueueTask(workerId);
        if (!retryTask) {
          console.log(`   💤 [${workerId}] Queue drained. Worker exiting.`);
          break;
        }
      }

      processedCount++;
      const currentTaskNumber = processedCount;

      const result = await executeWorkerTask({
        task: {
          ...task,
          queueTaskId: task.id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
        },
        workerId,
        taskIndex: currentTaskNumber,
        totalTasks: pendingCount,
        options: {
          headless,
          confirmSubmit,
          dryRun,
          defaultPassword,
        },
      });

      results.push({
        applywizzId: task.applywizz_id,
        jobUrl: task.job_url,
        company: task.company,
        status: result.status,
        cacheHit: result.cacheHit || false,
        error: result.error,
      });
    }

    activeWorkers--;
  }

  const workerPromises = [];
  for (let w = 1; w <= concurrency; w++) {
    workerPromises.push(queueWorkerLoop(w));
  }

  await Promise.all(workerPromises);

  // Print Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${concurrency}-WORKER QUEUE EXECUTION SUMMARY`);
  console.log(`${'═'.repeat(70)}`);
  const submitted = results.filter((r) => r.status === 'submitted').length;
  const reachedReview = results.filter((r) => r.status === 'reached-review').length;
  const cacheHits = results.filter((r) => r.cacheHit).length;
  const failed = results.filter((r) => ['error', 'auth_failed', 'invalid_url', 'profile_load_failed', 'auth_missing'].includes(r.status)).length;
  const incomplete = results.length - (submitted + reachedReview + failed);

  console.log(`  Total Tasks Processed: ${results.length}`);
  console.log(`  ✅ Submitted:            ${submitted}`);
  console.log(`  🎯 Reached Review:       ${reachedReview}`);
  console.log(`  ⚡ Form Cache Hits:      ${cacheHits} (instant pre-resolved repeat links)`);
  console.log(`  🔍 Unique Form Scans:    ${results.length - cacheHits} (harvested to Supabase)`);
  console.log(`  ❌ Failed:               ${failed}`);
  if (incomplete > 0) console.log(`  ⚠️  Incomplete:           ${incomplete}`);
  console.log(`${'═'.repeat(70)}\n`);

  return results;
}

