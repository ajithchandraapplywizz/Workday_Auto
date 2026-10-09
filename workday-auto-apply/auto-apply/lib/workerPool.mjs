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
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { scanForm, slugify } from './scanner.mjs';
import { fillForm } from './engine.mjs';
import { loadProfile, generatePlan, pickResume } from './planner.mjs';
import { extractJDText, detectATS, validateWorkdayUrl, extractWorkdayCompanyName, extractJobRoleFromDom, isWorkdayWizardVisible } from './discovery.mjs';
import { inferStandardOptions } from './workdayScanHarvest.mjs';
import { resolveCompanyEmail } from './applyWizzClient.mjs';
import { checkAndPreResolveJobForClient, recordDiscoveredJobForm, bulkPreResolveForJobUrl } from './jobFormCache.mjs';
import { upsertSupabaseApplication, updateQueueTaskStatus, leaseNextQueueTask, leaseSpecificQueueTask, fetchPendingTasksForActiveCAs, getBatchQueueStats, updateWorkerStatus, getActiveCaCandidateIds, getTotalApplicationCountForCandidates, uploadStorageScreenshot, getActiveOperators, logAutomationTrace } from './supabaseClient.mjs';
import { isGlobalStopRequested, setGlobalStop, registerActiveBrowser, unregisterActiveBrowser } from './browserLifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEAD_JOB_URLS = new Set();

async function purgeDeadJobUrlAcrossQueue(jobUrl, workerId, screenshotUrl = null) {
  DEAD_JOB_URLS.add(jobUrl);
  console.log(`   🚫 [${workerId}] Purging dead job URL from queue for ALL clients: "${jobUrl}"`);
  try {
    const { purgeDeadJobUrlFromQueue } = await import('./supabaseClient.mjs');
    const expiredReason = `Link Expired: The page you are looking for doesn't exist [step: Link Expired]${screenshotUrl ? ` [screenshot: ${screenshotUrl}]` : ''}`;
    await purgeDeadJobUrlFromQueue(jobUrl, { expiredReason, screenshotUrl });
  } catch (err) {
    console.log(`   ⚠️ [${workerId}] Queue purge notice: ${err.message}`);
  }
}

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

let workerPoolStopRequested = false;
export function setWorkerPoolStop(val) {
  workerPoolStopRequested = Boolean(val);
  setGlobalStop(val);
}
export function getWorkerPoolStop() {
  return workerPoolStopRequested || isGlobalStopRequested();
}

export async function isWorkerPoolStopRequested() {
  return workerPoolStopRequested || isGlobalStopRequested();
}

/**
 * Execute a single job application task within an isolated worker context.
 */
export async function executeWorkerTask({
  task,
  workerId = 'submitting_worker_1',
  taskIndex = 1,
  totalTasks = 1,
  options = {},
}) {
  const {
    headless = true,
    dryRun = false,
    confirmSubmit = !dryRun,
    defaultPassword = process.env.WORKDAY_PASSWORD || '',
    allowedCandidateIds = null,
  } = options;

  const isApprovedForSubmission = task.status === 'approved_for_submission' || task.status === 'approved_by_ca' || task.status === 'queued_for_submission';
  const effectiveConfirmSubmit = isApprovedForSubmission ? true : confirmSubmit;

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

  if (await isWorkerPoolStopRequested()) {
    console.log(`   🛑 [${workerId}] Stop requested! Aborting task execution.`);
    return { status: 'stopped', error: 'Stopped by user' };
  }

  // Ensure application record exists in Supabase so trace events are linked to the application ID
  let liveApplicationId = null;
  try {
    const initApp = await upsertSupabaseApplication({
      applywizzId,
      jobUrl,
      company,
      roleTitle: 'Workday Application',
      status: isApprovedForSubmission ? 'in_progress' : 'in_progress',
    });
    if (initApp?.id) liveApplicationId = initApp.id;
  } catch {}

  const appLog = (stepIndex, msg) => {
    logAutomationTrace({
      applicationId: liveApplicationId,
      applywizzId,
      stepIndex,
      message: `[${workerId}] ${msg}`
    }).catch(() => {});
  };

  appLog(1, `Supabase: Fetched queue task ${queueTaskId ? `(${queueTaskId.slice(0, 8)})` : ''} for candidate ${applywizzId}. Initializing worker session.`);

  // 1. Validate Workday URL
  const check = validateWorkdayUrl(jobUrl);
  if (!check.valid) {
    console.error(`   ❌ [${workerId}] Invalid Workday URL: ${check.reason}`);
    appLog(1, `Validation Error: Invalid Workday URL: ${check.reason}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: check.reason });
    return { status: 'invalid_url', error: check.reason };
  }

  if (DEAD_JOB_URLS.has(jobUrl)) {
    console.log(`   ⚡ [${workerId}] Skipping ${applywizzId} for "${jobUrl}" — URL verified dead/expired for all clients.`);
    const expiredReason = 'Link Expired: The page you are looking for doesn\'t exist [step: Link Expired]';
    appLog(1, `Job URL Expired: "${jobUrl.slice(0, 60)}" confirmed dead across all candidates.`);
    if (queueTaskId) {
      await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: expiredReason });
    }
    await upsertSupabaseApplication({
      applywizzId,
      jobUrl,
      company,
      roleTitle: 'Workday Application',
      status: 'failed',
      failureReason: expiredReason,
      stoppedAtStep: 'Link Expired',
    }).catch(() => {});
    return { status: 'failed', reason: 'Link Expired' };
  }

  // 2. Load isolated Client Profile for this applywizzId
  let profile;
  try {
    const profilePath = findFilePath('config/profile.yml');
    profile = await loadProfile(existsSync(profilePath) ? profilePath : null, { applywizzId });
    profile._applyWizzId = applywizzId;
    profile._canonicalJobUrl = jobUrl;
    profile._jobUrl = jobUrl;
    profile._applicationId = liveApplicationId;
    profile._onLog = (stepIndex, msg) => appLog(stepIndex, msg);
    if (company) profile._company = company;
  } catch (err) {
    console.error(`   ❌ [${workerId}] Failed to load profile for ${applywizzId}: ${err.message}`);
    appLog(1, `Supabase Profile Error: Failed loading profile for ${applywizzId}: ${err.message}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: err.message });
    return { status: 'profile_load_failed', error: err.message };
  }

  // 3. Resolve Workday credentials for this candidate from AWL ID client record in Supabase
  let candidateDbClient = null;
  if (applywizzId) {
    try {
      const { loadSupabaseClientSnapshot } = await import('./supabaseClient.mjs');
      const snap = await loadSupabaseClientSnapshot(applywizzId);
      if (snap?.client) {
        candidateDbClient = snap.client;
      }
    } catch {}
  }

  const candidateEmail = candidateDbClient?.company_email ||
    candidateDbClient?.email ||
    (candidateDbClient ? resolveCompanyEmail(candidateDbClient, candidateDbClient.client_name) : '') ||
    resolveCompanyEmail(profile.personal || profile, [profile.personal?.first_name, profile.personal?.last_name].filter(Boolean).join(' ') || profile.name || '');

  let workdayEmail = candidateEmail || profile.personal?.company_email || profile.personal?.email || profile.email || '';
  if (!workdayEmail && applywizzId) {
    const rawFirst = candidateDbClient?.first_name || profile.personal?.first_name || '';
    const rawLast = candidateDbClient?.last_name || profile.personal?.last_name || '';
    const rawName = [rawFirst, rawLast].filter(Boolean).join('.') || applywizzId.toLowerCase().replace(/[^a-z0-9]/g, '');
    workdayEmail = `${rawName}@applywizard.ai`;
  }
  if (!workdayEmail) {
    workdayEmail = process.env.WORKDAY_DEFAULT_USERNAME || 'Created@123';
  }
  const workdayPassword = defaultPassword || process.env.WORKDAY_PASSWORD || 'Applywizz@2026';

  const expCount = profile.experience?.length || profile.work_experience?.length || 0;
  const skillsCount = profile.skills?.length || 0;
  appLog(2, `Supabase Profile: Loaded candidate record for ${applywizzId} (${workdayEmail}). Indexed ${expCount} job experiences, ${skillsCount} verified skills.`);

  console.log(`   📧 [${workerId}] Using candidate credentials: ${workdayEmail} (Universal Password: ${workdayPassword}) for ${applywizzId}`);

  // Immediately notify Supabase & Frontend dashboard of Active / In-Progress status
  await updateWorkerStatus(workerId, { state: 'in_flight' }).catch(() => {});
  if (queueTaskId) {
    await updateQueueTaskStatus(queueTaskId, { status: 'processing', workerId }).catch(() => {});
  }
  await upsertSupabaseApplication({
    applywizzId,
    jobUrl,
    company,
    roleTitle: profile._roleTitle || profile._jobTitle || 'Workday Application',
    status: 'in_progress',
  }).catch(() => {});

  // Update status in job_distributions to 'applying'
  try {
    const { markJobDistributionApplying } = await import('./supabaseClient.mjs');
    await markJobDistributionApplying({ applywizzId, jobUrl, workerId });
  } catch {}

  // 4. Check Job Form Cache in Supabase (Duplicate Link Detection & Pre-Resolved Cell)
  let cacheHit = false;
  let cacheResult = null;
  const queuePreResolved = task.pre_resolved_answers || task.preResolvedAnswers;
  if (queuePreResolved && typeof queuePreResolved === 'object' && Object.keys(queuePreResolved).length > 0) {
    cacheHit = true;
    profile._supabaseQa = { ...(profile._supabaseQa || {}), ...queuePreResolved };
    profile._answerCache = profile._answerCache || new Map();
    for (const [k, v] of Object.entries(queuePreResolved)) {
      profile._answerCache.set(k, v);
    }
    const preCount = Object.keys(queuePreResolved).length;
    appLog(3, `Supabase QA Cache HIT: Loaded ${preCount} pre-resolved answers from queue cell for instant fill.`);
    console.log(`   ⚡ [${workerId}] Queue Pre-Resolved Hit: ${preCount} answers loaded directly from queue cell for instant fill.`);
  } else {
    // Also load pre-resolved answers from job_distributions table
    try {
      const { getResolvedAnswers } = await import('./supabaseClient.mjs');
      const distData = await getResolvedAnswers(applywizzId, jobUrl);
      if (distData?.resolved_answers && Array.isArray(distData.resolved_answers) && distData.resolved_answers.length > 0) {
        cacheHit = true;
        profile._supabaseQa = profile._supabaseQa || {};
        profile._answerCache = profile._answerCache || new Map();
        let loadedCount = 0;
        for (const item of distData.resolved_answers) {
          const q = item.question || item.label || item.question_label;
          const a = item.answer || item.value;
          if (q && a !== undefined && a !== null) {
            profile._supabaseQa[q] = a;
            profile._answerCache.set(q, a);
            loadedCount++;
          }
        }
        if (loadedCount > 0) {
          console.log(`   * [Worker ${workerId}] Loaded ${loadedCount} pre-resolved answers from job_distributions for ${applywizzId}!`);
        }
      }
    } catch {}

    try {
      cacheResult = await checkAndPreResolveJobForClient({ jobUrl, profile });
      cacheHit = cacheResult.hit;
      if (cacheHit) {
        appLog(3, `Supabase Cache HIT: Stored form structure loaded for ${company || 'Workday'}. Pre-resolved answers mapped.`);
        console.log(`   ⚡ [${workerId}] Cache Hit: Stored form structure loaded from Supabase.`);
      } else {
        appLog(3, `Supabase Cache: First encounter for ${company || 'Workday'}. Form fields will be scanned & cached.`);
        console.log(`   🔍 [${workerId}] Cache Miss: First time encountering this job. Form will be scanned & cached.`);
      }
    } catch (err) {
      console.log(`   ⚠️ [${workerId}] Form cache check skipped: ${err.message}`);
    }
  }

  // 5. Launch isolated Playwright browser context
  appLog(4, `Playwright: Initialized isolated browser context (1280x900) for ${workdayEmail}. Launching ${headless ? 'headless stealth' : 'headed'} Chrome.`);
  const browser = await chromium.launch({
    headless: Boolean(headless),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
    ],
  });
  registerActiveBrowser(browser);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => {});
  const page = await context.newPage();
  let roleTitle = profile._roleTitle || profile._jobTitle || 'Workday Application';

  try {
    // Step A: Scan Form
    appLog(5, `Playwright: Navigated to ${jobUrl.slice(0, 60)}... Scanning DOM inputs, questions, and auth state.`);
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

    if (scan.jobMissing || scan.jobExpired || scan.reason === 'job_expired_or_not_found' || scan.reason === 'no_apply_button' || scan.reason === 'job_expired' || scan.reason === 'empty_page') {
      // Patiently verify if the page actually displays an Apply button or is still loading!
      try {
        await page.waitForSelector('[data-automation-id="loadingSpinner"], [role="progressbar"], .loading-spinner, div[class*="loading" i], div[class*="spinner" i]', { state: 'detached', timeout: 10000 });
      } catch {}

      const hasApplyNow = await page.evaluate(() => {
        return Boolean(
          document.querySelector('a[data-automation-id*="apply" i], button[data-automation-id*="apply" i], a[data-automation-id="adventureButton"], a[data-automation-id="continueApplication"], button[data-automation-id="continueApplication"], [data-automation-id="jobPostingApplyButton"]') ||
          Array.from(document.querySelectorAll('a, button')).some(el => /^\s*(apply|apply now|apply for this job|continue application)\s*$/i.test((el.textContent || '').trim()))
        );
      }).catch(() => false);

      if (hasApplyNow) {
        console.log(`   🔎 [${workerId}] Page actually displays Apply button — NOT expired! Entering application wizard...`);
        const { ensureWorkdayApplicationWizard } = await import('./discovery.mjs');
        await ensureWorkdayApplicationWizard(page, { mode: 'signin', profile });
        scan.jobMissing = false;
        scan.jobExpired = false;
        delete scan.reason;
      } else {
        const genuineExpired = await page.evaluate(() => {
          const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          return /the page you are looking for doesn'?t exist|job (?:posting )?has (?:been )?(?:filled|closed|expired)|no longer accepting applications|\berror 404\b/i.test(text);
        }).catch(() => false);

        console.log(`   ❌ [${workerId}] Dead / expired job posting confirmed in DOM ("The page you are looking for doesn't exist" / "Job Expired").`);
        let expiredShotUrl = null;
        try {
          if (page && !page.isClosed()) {
            // Scroll to the error message so the screenshot captures exact proof of problem
            await page.evaluate(() => {
              const headings = Array.from(document.querySelectorAll('h1, h2, h3, p, [role="alert"], [data-automation-id*="error" i]'));
              const match = headings.find(h => /doesn'?t exist|expired|closed|filled|404/i.test(h.textContent || ''));
              if (match) match.scrollIntoView({ behavior: 'instant', block: 'center' });
            }).catch(() => {});
            await page.waitForTimeout(300);
            const buf = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
            if (buf) {
              expiredShotUrl = await uploadStorageScreenshot('application-failures', `${applywizzId}_${Date.now()}_job_expired.jpg`, buf);
            }
          }
        } catch {}

        await purgeDeadJobUrlAcrossQueue(jobUrl, workerId, expiredShotUrl);

        await browser.close().catch(() => {});
        if (queueTaskId) {
          await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: 'job_expired_or_not_found', screenshotPath: expiredShotUrl });
        }
        await upsertSupabaseApplication({
          applywizzId,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          status: 'failed',
          failureReason: 'Job page does not exist (dead/expired URL)',
          failureScreenshotUrl: expiredShotUrl,
        }).catch(() => {});

        try {
          const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
          await recordFailedJob({
            applywizzId,
            jobId: task.job_id || task.jobId || null,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            failureReason: 'Job page does not exist (dead/expired URL or no Apply button)',
            failedAtStep: 'Job Discovery / Link Expired',
            screenshotPath: expiredShotUrl,
          });
          await recordApplicationFailure({
            applywizzId,
            jobId: task.job_id || task.jobId || null,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            failureReason: 'Job page does not exist (dead/expired URL or no Apply button)',
            screenshotPath: expiredShotUrl,
          });
        } catch {}

        return { status: 'failed', reason: 'job_expired_or_not_found', screenshotUrl: expiredShotUrl, stoppedAtStep: 'Job Discovery / Link Expired' };
      }
    }

    const extractedRole = await extractJobRoleFromDom(page, jobUrl);
    if (extractedRole) {
      roleTitle = extractedRole;
      profile._jobTitle = roleTitle;
      profile._roleTitle = roleTitle;
      console.log(`   [${workerId}] 💼 Role: ${roleTitle}`);
    }

    if (scan.authFailed || (scan.field_count === 0 && !await isWorkdayWizardVisible(page))) {
      let wizardNow = await isWorkdayWizardVisible(page).catch(() => false);

      // Check if the page is still displaying an Apply button before jumping to auth failed!
      if (!wizardNow) {
        const stillHasApply = await page.$([
          'a[data-automation-id="adventureButton"]:visible',
          'button[data-automation-id="adventureButton"]:visible',
          'a[data-automation-id="applyButton"]:visible',
          'button[data-automation-id="applyButton"]:visible',
          '[data-automation-id="jobPostingApplyButton"]:visible',
          'button:has-text("Apply"):visible',
          'a:has-text("Apply"):visible',
        ].join(', ')).catch(() => null);

        if (stillHasApply) {
          console.log(`   🔎 [${workerId}] Page still displays Apply button — clicking Apply to enter application wizard...`);
          const { ensureWorkdayApplicationWizard } = await import('./discovery.mjs');
          await ensureWorkdayApplicationWizard(page, { mode: 'signin', profile });
          await page.waitForTimeout(1500);
          wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
        }
      }

      // Check if on login form or modal
      if (!wizardNow) {
        const isAuthScreen = await page.$('input[type="password"]:visible, input[data-automation-id="password"]:visible, button[data-automation-id="signInSubmitButton"]:visible').catch(() => null);
        if (isAuthScreen) {
          console.log(`   🔑 [${workerId}] Login screen detected — submitting credentials for ${workdayEmail}...`);
          const { handleWorkday } = await import('./workday.mjs');
          await handleWorkday(page, { email: workdayEmail, password: workdayPassword, mode: 'signin', profile });
          await page.waitForTimeout(1500);
          wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
        }
      }

      // Check if still loading
      if (!wizardNow) {
        try {
          await page.waitForSelector('[data-automation-id="loadingSpinner"], [role="progressbar"], .loading-spinner, div[class*="loading" i], div[class*="spinner" i]', { state: 'detached', timeout: 10000 });
        } catch {}
        await page.waitForTimeout(1000);
        wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
      }

      if (wizardNow) {
        // Application wizard reached! Refresh fields so we don't treat this as 0 fields
        const { discoverFields } = await import('./scanner.mjs');
        const freshFields = await discoverFields(page);
        scan.fields = freshFields;
        scan.field_count = freshFields.length;
        scan.authFailed = false;
        console.log(`   ✅ [${workerId}] Application wizard active — DOM scan discovered ${scan.field_count} fields.`);
      } else {
        // Attempt Zoho Mail email verification and password reset recovery
        console.log(`   🔐 [${workerId}] Auth gateway requires verification or password setup. Invoking Zoho Mail recovery...`);
        let recovered = false;
        try {
          const { resolveWorkdayVerification } = await import('./workdayVerification.mjs');
          const vRes = await resolveWorkdayVerification(page, {
            email: workdayEmail,
            password: workdayPassword,
            company,
            startTime: Date.now() - 120000,
            timeoutMs: 45000,
          });
          if (vRes?.success && (vRes?.onWizard || await isWorkdayWizardVisible(page))) {
            recovered = true;
            console.log(`   🎉 [${workerId}] Successfully verified and authenticated via Zoho Mail! Continuing form fill.`);
            scan = await scanForm(jobUrl, { browser, context, page, workdayEmail, workdayPassword, isBatch: true, candidateId: applywizzId });
            scan.authFailed = false;
          }
        } catch (zErr) {
          console.warn(`   ⚠️ [${workerId}] Zoho verification attempt notice: ${zErr.message}`);
        }

        if (!recovered) {
          const { getWorkdayAuthErrorMessage } = await import('./discovery.mjs');
          let authErrorMsg = await getWorkdayAuthErrorMessage(page);

          // Deep DOM error inspection for validation errors, alerts, and field blockers
          let domSpecificReason = null;
          try {
            domSpecificReason = await page.evaluate(() => {
              const alertEl = document.querySelector('[data-automation-id="errorMessage"], [role="alert"], [data-automation-id="formError"]');
              if (alertEl && alertEl.textContent?.trim()) {
                return alertEl.textContent.trim().replace(/\s+/g, ' ');
              }
              const invalidInput = document.querySelector('[aria-invalid="true"]');
              if (invalidInput) {
                const labelEl = invalidInput.closest('div')?.querySelector('label') || document.querySelector(`label[for="${invalidInput.id}"]`);
                const name = labelEl?.textContent?.trim() || invalidInput.getAttribute('aria-label') || invalidInput.name || 'field';
                return `Validation Error: Required ${name} is invalid or missing`;
              }
              const pageText = document.body ? document.body.innerText : '';
              if (/job (is no longer|has expired|not found|does not exist)/i.test(pageText)) {
                return 'Link Expired: Job no longer available on Workday';
              }
              return null;
            }).catch(() => null);
          } catch {}

          const effectiveReason = domSpecificReason || authErrorMsg || 'Authentication failed: Unable to access application wizard after credentials check';
          const failReasonText = `Authentication / Gateway check: ${effectiveReason}`;
          console.log(`   ❌ [${workerId}] ${failReasonText}`);

          let authShotUrl = null;
          try {
            if (page && !page.isClosed()) {
              await page.evaluate(() => {
                const err = document.querySelector('[data-automation-id="errorMessage"], [role="alert"], .error-message, div[class*="error" i], [aria-invalid="true"]');
                if (err) err.scrollIntoView({ behavior: 'instant', block: 'center' });
                else window.scrollTo(0, 0);
              }).catch(() => {});
              await page.waitForTimeout(400);
              const buf = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
              if (buf) {
                authShotUrl = await uploadStorageScreenshot('application-failures', `${applywizzId}_${Date.now()}_gateway_fail.jpg`, buf);
              }
            }
          } catch {}

          await browser.close().catch(() => {});
          if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: failReasonText, screenshotPath: authShotUrl });
          await upsertSupabaseApplication({
            applywizzId,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            status: 'failed',
            failureReason: failReasonText,
            failureScreenshotUrl: authShotUrl,
            stoppedAtStep: 'Auth Gateway (Sign In / Sign Up)',
          }).catch(() => {});

        try {
          const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
          await recordFailedJob({
            applywizzId,
            jobId: task.job_id || task.jobId || null,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            failureReason: failReasonText,
            failedAtStep: 'Auth Gateway (Sign In / Sign Up)',
            screenshotPath: authShotUrl,
          });
          await recordApplicationFailure({
            applywizzId,
            jobId: task.job_id || task.jobId || null,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            failureReason: failReasonText,
            screenshotPath: authShotUrl,
          });
        } catch {}

        return { status: 'auth_failed', screenshotUrl: authShotUrl, stoppedAtStep: 'Auth Gateway (Sign In / Sign Up)', failureReason: failReasonText };
      }
    }
  }

    // Step B: Pick resume for candidate
    console.log(`   [${workerId}] Step 2: Preparing resume...`);
    let jdText = '';
    try { jdText = await extractJDText(page); } catch {}
    const jdWords = jdText ? jdText.split(/\s+/).filter(Boolean).length : 0;
    const resumesYml = findFilePath('config/resumes.yml');
    let resumePath = null;
    if (existsSync(resumesYml)) {
      resumePath = await pickResume(jdText, resumesYml);
    }
    if (resumePath) profile._resumePath = resumePath;
    const resumeFile = resumePath ? basename(resumePath) : 'Candidate_ATS_Resume.pdf';
    appLog(6, `Job Description: Parsed ${jdText.length} characters (~${jdWords} words). Selected resume: "${resumeFile}" tailored to JD.`);

    // Step C: Generate fill plan
    console.log(`   [${workerId}] Step 3: Generating plan...`);
    const plan = await generatePlan(scan, profile, { resumePath, jdText, url: jobUrl });
    if (company) plan.company = company;
    if (roleTitle) plan.role = roleTitle;
    const questionsCount = plan.answers ? Object.keys(plan.answers).length : (scan.field_count || 12);
    appLog(7, `LLM Reasoning: Generating structured answers for ${questionsCount} form fields using candidate knowledge and JD context.`);

    // Hook wizard step changes for live frontend execution trace
    profile._onStepChange = (iteration, stepName) => {
      appLog(7 + iteration, `Workday Wizard: Step ${iteration} -> "${stepName}". Auto-filling fields & dispatching form events.`);
    };

    // Save local plan backup
    try {
      const slug = slugify(jobUrl);
      const planOut = resolve(process.cwd(), 'forms', `${slug}-${applywizzId}-plan.json`);
      await writeFile(planOut, JSON.stringify(plan, null, 2));
    } catch {}

    // Step D: Fill & Submit
    appLog(8, `Workday Wizard: Auto-filling application form steps 1–4 (${company || 'Workday'})...`);
    console.log(`   [${workerId}] Step 4: Filling application...`);
    const status = await fillForm(jobUrl, plan, {
      browser,
      context,
      page,
      profile,
      workdayEmail,
      workdayPassword,
      mode: 'signin',
      confirmSubmit: effectiveConfirmSubmit,
      dryRun,
      isBatch: true,
    });

    if (status === 'job_not_found') {
      console.log(`   ❌ [${workerId}] Job page does not exist (dead/expired URL) — capturing screenshot & purging queue for all clients.`);
      let expiredShotUrl = null;
      try {
        if (page && !page.isClosed()) {
          const buf = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
          if (buf) {
            expiredShotUrl = await uploadStorageScreenshot('application-failures', `${applywizzId}_${Date.now()}_link_expired.jpg`, buf);
          }
        }
      } catch {}

      await purgeDeadJobUrlAcrossQueue(jobUrl, workerId, expiredShotUrl);

      const expiredReason = `Link Expired: The page you are looking for doesn't exist [step: Link Expired]${expiredShotUrl ? ` [screenshot: ${expiredShotUrl}]` : ''}`;
      if (queueTaskId) {
        await updateQueueTaskStatus(queueTaskId, {
          status: 'failed',
          errorMessage: expiredReason,
          screenshotPath: expiredShotUrl,
        });
      }
      await upsertSupabaseApplication({
        applywizzId,
        jobUrl,
        company,
        roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
        status: 'failed',
        failureReason: expiredReason,
        failureScreenshotUrl: expiredShotUrl,
        stoppedAtStep: 'Link Expired',
      }).catch(() => {});

      try {
        const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
        await recordFailedJob({
          applywizzId,
          jobId: task.job_id || task.jobId || null,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          failureReason: expiredReason,
          failedAtStep: 'Job Discovery / Link Expired',
          screenshotPath: expiredShotUrl,
        });
        await recordApplicationFailure({
          applywizzId,
          jobId: task.job_id || task.jobId || null,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          failureReason: expiredReason,
          screenshotPath: expiredShotUrl,
        });
      } catch {}

      return { status: 'job_expired', reason: 'Link Expired', screenshotUrl: expiredShotUrl, stoppedAtStep: 'Job Discovery / Link Expired' };
    }

    // Step E: Save newly discovered form schema to Supabase if unique link
    const combinedFields = [
      ...(Array.isArray(scan.fields) ? scan.fields : []),
      ...(Array.isArray(profile._harvestedFields) ? profile._harvestedFields : []),
    ].filter((f) => f && f.type !== 'password' && !/password/i.test(f.name || '') && !/password/i.test(f.label || ''));

    const existingCount = cacheResult?.schema?.fields_schema?.length || 0;
    const existingSteps = cacheResult?.schema?.step_names || [];
    const isPartialCache = existingCount < 20 || existingSteps.length <= 1;
    const hasMoreFields = combinedFields.length > existingCount;

    if ((!cacheHit || isPartialCache || hasMoreFields) && combinedFields.length > 0) {
      try {
        const saved = await recordDiscoveredJobForm({
          jobUrl,
          profile,
          fields: combinedFields,
          stepNames: profile._discoveredSteps ? [...profile._discoveredSteps] : ['Application'],
          company,
          roleTitle,
        });

        // Immediately bulk-pre-resolve for all other pending clients sharing this URL (skipped in cluster mode where Phase 3 resolves in parallel)
        if (saved && !options.isClusterBlueprint) {
          const { loadJobFormSchema: getSchema } = await import('./supabaseClient.mjs');
          const savedSchema = await getSchema(jobUrl).catch(() => null);
          if (savedSchema?.fields_schema?.length) {
            const profilePath = findFilePath('config/profile.yml');
            bulkPreResolveForJobUrl({
              jobUrl,
              schema: savedSchema,
              allowedCandidateIds,
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
    let completionShotUrl = profile?._submissionScreenshotUrl || null;
    let detectedStep = null;
    try {
      if (!completionShotUrl) {
        let buf = profile?._submissionScreenshotBuffer || null;
        if (!buf && page && !page.isClosed()) {
          const { detectWorkdayStep } = await import('./stateDetector.mjs');
          detectedStep = await detectWorkdayStep(page).catch(() => null);
          if (status !== 'submitted' && status !== 'reached-review' && status !== 'reached_review') {
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            await page.waitForTimeout(500).catch(() => {});
          }
          buf = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: true, timeout: 8000 }).catch(() => null);
          if (!buf) {
            buf = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 5000 }).catch(() => null);
          }
        }
        if (buf) {
          const bucket = (status === 'submitted' || status === 'reached-review' || status === 'reached_review')
            ? 'application-successes'
            : 'application-failures';
          completionShotUrl = await uploadStorageScreenshot(bucket, `${applywizzId}_${Date.now()}_${status}.jpg`, buf);
        }
      }
    } catch {}

    const onReviewPage = String(detectedStep || profile._currentStep || '').toLowerCase().includes('review');
    const isSuccessStatus = (
      status === 'submitted' ||
      status === 'reached-review' ||
      status === 'reached_review' ||
      status === 'ready_for_review' ||
      (status === 'human-required' && onReviewPage) ||
      onReviewPage
    );
    const stoppedBlock = isSuccessStatus
      ? 'Step 5: Review & Submit'
      : (detectedStep && detectedStep !== 'Unknown' ? detectedStep : (profile._currentStep || 'Step 1: My Information'));

    let fullFailureReason = null;
    if (!isSuccessStatus) {
      fullFailureReason = `wizard_did_not_reach_review (stopped at ${stoppedBlock}) [step: ${stoppedBlock}]`;
      if (completionShotUrl) {
        fullFailureReason += ` [screenshot: ${completionShotUrl}]`;
      }
    } else if (completionShotUrl) {
      fullFailureReason = `[screenshot: ${completionShotUrl}]`;
    }

    const appStatus = (status === 'submitted')
      ? 'submitted'
      : (status === 'reached-review' || status === 'reached_review' || isSuccessStatus)
        ? 'ready_for_review'
        : status;

    await upsertSupabaseApplication({
      applywizzId,
      jobUrl,
      company,
      roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
      status: appStatus,
      failureReason: fullFailureReason,
      failureScreenshotUrl: completionShotUrl,
      stoppedAtStep: isSuccessStatus ? 'Step 5: Review & Submit' : stoppedBlock,
    }).catch(() => {});

    if (queueTaskId) {
      const finalStatus = (status === 'submitted')
        ? 'submitted'
        : (status === 'reached-review' || status === 'reached_review')
          ? 'ready_for_review'
          : (status === 'skipped' ? 'skipped' : 'failed');
      const answersMap = {
        ...(profile._scrapedReviewMap || {}),
        ...(profile._supabaseQa || {}),
        ...(profile._answerCache ? Object.fromEntries(profile._answerCache) : {})
      };
      await updateQueueTaskStatus(queueTaskId, {
        status: finalStatus,
        errorMessage: fullFailureReason,
        preResolvedAnswers: answersMap,
        screenshotPath: completionShotUrl,
      });
    }

    if (!isSuccessStatus) {
      const answeredSoFar = [];
      if (profile?._filledValues) {
        for (const [qLabel, qVal] of Object.entries(profile._filledValues)) {
          if (qLabel && qVal != null) {
            answeredSoFar.push({
              question: qLabel,
              answer: String(qVal),
              step: profile?._currentStep || stoppedBlock || 'Application',
              is_answered: true,
            });
          }
        }
      }
      if (profile?._answerCache && answeredSoFar.length === 0) {
        for (const [qLabel, qVal] of profile._answerCache.entries()) {
          if (qLabel && qVal != null) {
            answeredSoFar.push({
              question: qLabel,
              answer: String(qVal),
              step: profile?._currentStep || stoppedBlock || 'Application',
              is_answered: true,
            });
          }
        }
      }

      try {
        const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
        await recordFailedJob({
          applywizzId,
          jobId: task.job_id || task.jobId || null,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          failureReason: fullFailureReason || `Form stalled on "${stoppedBlock}" for >30s without moving forward`,
          failedAtStep: stoppedBlock,
          screenshotPath: completionShotUrl,
          resolvedAnswers: answeredSoFar,
        });
        await recordApplicationFailure({
          applywizzId,
          jobId: task.job_id || task.jobId || null,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          failureReason: fullFailureReason || `Form stalled on "${stoppedBlock}" for >30s without moving forward`,
          screenshotPath: completionShotUrl,
        });
      } catch {}
    }

    // Helper to infer clean field type and options for JSONB storage and dashboard rendering
    function inferQuestionTypeAndOptions(label = '', value = '', meta = {}) {
      const norm = String(label || '').toLowerCase();
      const valStr = String(value || '').trim();
      let fieldType = meta.fieldType || meta.field_type || meta.type || '';
      let options = Array.isArray(meta.options) && meta.options.length ? [...meta.options] : [];

      if (!fieldType || fieldType === 'review_question' || fieldType === 'unknown' || fieldType === 'wizard_question') {
        if (/^(yes|no)$/i.test(valStr) || /\b(yes\s*\/\s*no|authorized|sponsorship|require|consent|agree|over\s*18|felony)\b/i.test(norm)) {
          fieldType = 'radio';
          if (!options.length) options = ['Yes', 'No'];
        } else if (/\b(date|dob|birth|start\s*date|graduation)\b/i.test(norm) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(valStr)) {
          fieldType = 'date';
        } else if (/\b(phone|mobile|cell)\b/i.test(norm)) {
          fieldType = 'phone';
        } else if (/\b(describe|explain|why|tell\s*us|summary|cover\s*letter|comments?|bio)\b/i.test(norm) || valStr.length > 120) {
          fieldType = 'textarea';
        } else if (/\b(country|state|province|gender|ethnicity|race|veteran|disability|degree|level\s*of\s*education|hear\s*about|device\s*type)\b/i.test(norm)) {
          fieldType = 'dropdown';
          if (valStr && !options.includes(valStr)) options.push(valStr);
        } else {
          fieldType = 'text';
        }
      }

      return { fieldType, options };
    }

    // Format all scraped questions across ALL wizard steps and Review & Submit with precise types & options
    const questionMap = new Map();
    const getQKey = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    // 1. Ingest wizard fields discovered across all pages (My Information, My Experience, Application Questions, Voluntary Disclosures)
    const allWizardFields = [
      ...(Array.isArray(profile?._scrapedQuestions) ? profile._scrapedQuestions : []),
      ...(profile?._scrapedWizardQuestions instanceof Map ? Array.from(profile._scrapedWizardQuestions.values()) : []),
      ...(Array.isArray(combinedFields) ? combinedFields : []),
      ...(Array.isArray(profile?._harvestedFields) ? profile._harvestedFields : []),
      ...(Array.isArray(scan?.fields) ? scan.fields : []),
      ...(Array.isArray(cacheResult?.schema?.fields_schema) ? cacheResult.schema.fields_schema : []),
    ];

    for (const f of allWizardFields) {
      if (!f || !(f.label || f.question)) continue;
      const lbl = f.label || f.question;
      const qKey = getQKey(lbl);
      if (!qKey || qKey.length < 2) continue;

      const { fieldType, options } = inferQuestionTypeAndOptions(lbl, f.value || '', f);
      const val = (f.value != null && f.value !== '')
        ? String(f.value)
        : (profile?._filledValues?.[lbl] != null ? String(profile._filledValues[lbl]) : '');

      const isReq = Boolean(f.is_required ?? f.required ?? true);

      if (!questionMap.has(qKey)) {
        questionMap.set(qKey, {
          label: lbl,
          question: lbl,
          question_normalized: qKey,
          value: val,
          field_type: fieldType,
          type: fieldType,
          options: Array.isArray(options) && options.length ? options : (Array.isArray(f.options) ? f.options : []),
          required: isReq,
          is_required: isReq,
          important: true,
          step: (f.step && f.step !== 'Application' && f.step !== 'Review & Submit') ? f.step : (f.step || 'Application'),
        });
      } else {
        const existing = questionMap.get(qKey);
        if (!existing.value && val) existing.value = val;
        if ((!existing.options || !existing.options.length) && Array.isArray(options) && options.length) {
          existing.options = options;
        }
        if (f.step && (!existing.step || existing.step === 'Application' || existing.step === 'Review & Submit')) {
          existing.step = f.step;
        }
        if (isReq) {
          existing.required = true;
          existing.is_required = true;
        }
      }
    }

    // 2. Ingest / merge questions answered during wizard steps (profile._filledValues)
    if (profile?._filledValues) {
      for (const [lbl, val] of Object.entries(profile._filledValues)) {
        if (!lbl || val == null) continue;
        const qKey = getQKey(lbl);
        if (!qKey || qKey.length < 2) continue;

        if (questionMap.has(qKey)) {
          const existing = questionMap.get(qKey);
          if (!existing.value) existing.value = String(val);
        } else {
          const { fieldType, options } = inferQuestionTypeAndOptions(lbl, val);
          questionMap.set(qKey, {
            label: lbl,
            question: lbl,
            question_normalized: qKey,
            value: String(val),
            field_type: fieldType,
            type: fieldType,
            options,
            required: true,
            is_required: true,
            important: true,
            step: profile?._currentStep || 'Application',
          });
        }
      }
    }

    // 3. Ingest / merge questions from Review & Submit DOM (profile._scrapedReviewMap)
    if (profile?._scrapedReviewMap) {
      for (const [lbl, val] of Object.entries(profile._scrapedReviewMap)) {
        if (!lbl) continue;
        const qKey = getQKey(lbl);
        if (!qKey || qKey.length < 2) continue;

        if (questionMap.has(qKey)) {
          const existing = questionMap.get(qKey);
          if (!existing.value && val) existing.value = String(val);
        } else {
          const { fieldType, options } = inferQuestionTypeAndOptions(lbl, val);
          questionMap.set(qKey, {
            label: lbl,
            question: lbl,
            question_normalized: qKey,
            value: String(val || ''),
            field_type: fieldType,
            type: fieldType,
            options,
            required: true,
            is_required: true,
            important: true,
            step: 'Review & Submit',
          });
        }
      }
    }

    // Strictly filter to mandatory/required questions only and ensure options are filled
    const allQuestions = Array.from(questionMap.values());
    const requiredQuestions = allQuestions.filter((q) => q.is_required || q.required);
    const finalScrapedQuestions = (requiredQuestions.length > 0 ? requiredQuestions : allQuestions).map((q) => {
      if ((!q.options || !q.options.length) && /dropdown|select|radio|combobox/i.test(q.field_type)) {
        const inferred = inferStandardOptions(q.label || q.question, q.field_type);
        if (inferred.length) q.options = inferred;
      }
      return q;
    });

    if (status === 'submitted') {
      try {
        const { completeSubmittedTask } = await import('./supabaseClient.mjs');
        await completeSubmittedTask({
          applywizzId,
          jobUrl,
          screenshotUrl: completionShotUrl,
          workerId,
        });
      } catch {}
      appLog(16, `Playwright: Application submitted successfully! Verified confirmation screen ('Alright... Application Submitted'). Screenshot proof saved to Supabase Storage: ${completionShotUrl || 'Supabase'}`);
    } else if (status === 'reached-review' || status === 'reached_review') {
      const isClusterBlueprint = Boolean(options.isClusterBlueprint || options.skipJobDistribution);
      if (!isClusterBlueprint) {
        try {
          const { saveResolvedAnswers, saveScannedJob, recordJobDistributions } = await import('./supabaseClient.mjs');

          await saveScannedJob({
            applywizzId,
            jobId: task.job_id || task.jobId || null,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            scrapedQuestions: finalScrapedQuestions,
            resolvedAnswers: profile._scrapedReviewFields || [],
            stepNames: profile._discoveredSteps ? [...profile._discoveredSteps] : ['Application'],
            screenshotPath: completionShotUrl,
            scanStatus: 'completed',
          });
          const unansweredQuestions = [];

          // Check review questions that have empty / incomplete answers
          for (const q of reviewQuestionsFormatted) {
            const val = String(q.value || '').trim();
            if (!val || /^(select(\s*one)?|select\.\.\.|choose(\s*one)?|unanswered|please\s*select)$/i.test(val)) {
              unansweredQuestions.push({
                question: q.label,
                field_type: q.type || 'text',
                step: 'Review & Submit',
                options: q.options || [],
              });
            }
          }

          // Check wizard steps for blocked or unanswered required questions
          if (profile._stepBlocked) {
            for (const [step, items] of Object.entries(profile._stepBlocked)) {
              for (const item of (Array.isArray(items) ? items : [])) {
                const qText = typeof item === 'string' ? item : (item.label || item.id || item.question);
                if (qText && !unansweredQuestions.some(u => u.question.toLowerCase() === qText.toLowerCase())) {
                  unansweredQuestions.push({
                    question: qText,
                    field_type: item.type || item.controlType || 'unknown',
                    step,
                    options: item.options || [],
                  });
                }
              }
            }
          }

          if (Array.isArray(profile._unansweredQuestions)) {
            for (const item of profile._unansweredQuestions) {
              const qText = typeof item === 'string' ? item : (item.label || item.id || item.question);
              if (qText && !unansweredQuestions.some(u => u.question.toLowerCase() === qText.toLowerCase())) {
                unansweredQuestions.push({
                  question: qText,
                  field_type: item.type || item.controlType || 'unknown',
                  step: item.step || 'Application',
                  options: item.options || [],
                });
              }
            }
          }

          const unansweredCount = unansweredQuestions.length;

          if (finalScrapedQuestions.length > 0) {
            await recordJobDistributions({
              leadApplywizzId: applywizzId,
              jobId: task.job_id || task.jobId || null,
              jobUrl,
              company,
              roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
              scrapedQuestions: finalScrapedQuestions,
              resolvedAnswers: profile._scrapedReviewFields || [],
              unansweredQuestions,
              unansweredCount,
              screenshotUrl: completionShotUrl,
              status: unansweredCount > 0 ? 'needs_answers' : 'ready_for_review',
              clients: [{ applywizzId, jobId: task.job_id || task.jobId || null, jobUrl }],
            }).catch(() => {});
          }

          await saveResolvedAnswers({
            applywizzId,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            resolvedAnswersJson: profile._scrapedReviewFields || [],
            isFullyAnswered: unansweredCount === 0,
            unansweredCount,
            status: unansweredCount === 0 ? 'ready_for_review' : 'needs_answers',
            screenshotUrl: completionShotUrl,
          });
        } catch {}
      }
      appLog(15, `Playwright: Reached Step 5 (Review & Submit). Form paused for CA review. High-res verification screenshot saved: ${completionShotUrl || 'Supabase'}`);
    }

    console.log(`   ✅ [${workerId}] Finished task for ${applywizzId} with status: "${status}"`);
    return {
      status,
      cacheHit,
      screenshotUrl: completionShotUrl || profile._submissionScreenshotUrl || null,
      reviewScreenshotUrl: completionShotUrl || profile._submissionScreenshotUrl || null,
      stoppedAtStep: stoppedBlock,
      answersMap: {
        ...(profile._scrapedReviewMap || {}),
        ...(profile._filledValues || {}),
        ...(profile._answers || {}),
        ...(profile._resolvedAnswersMap || {}),
      },
      resolvedAnswers: finalScrapedQuestions.filter(q => q.value).map(q => ({
        question: q.label || q.question,
        answer: String(q.value),
        field_type: q.field_type || q.type || 'text',
        step: q.step || 'Application',
        is_answered: true,
      })),
      harvestedFields: finalScrapedQuestions,
      scrapedQuestionsCount: finalScrapedQuestions.length,
      scrapedQuestions: finalScrapedQuestions,
    };
  } catch (err) {
    console.error(`   ❌ [${workerId}] Error executing task: ${err.message}`);
    // Failed job: skipped saving schema to scanned_jobs
    let errShotUrl = null;
    let errStep = profile?._currentStep || 'Runtime Exception';
    try {
      if (page && !page.isClosed()) {
        const { detectWorkdayStep } = await import('./stateDetector.mjs');
        const liveStep = await detectWorkdayStep(page).catch(() => null);
        if (liveStep && liveStep !== 'Unknown') errStep = liveStep;
        const buf = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
        if (buf) {
          errShotUrl = await uploadStorageScreenshot('application-failures', `${applywizzId}_${Date.now()}_error.jpg`, buf);
        }
      }
    } catch {}

    let fullErrReason = `${err.message} (stopped at ${errStep}) [step: ${errStep}]`;
    if (errShotUrl) fullErrReason += ` [screenshot: ${errShotUrl}]`;

    appLog(99, `Task halted: ${fullErrReason}`);

    if (queueTaskId) {
      await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: fullErrReason, screenshotPath: errShotUrl });
    }
    await upsertSupabaseApplication({
      applywizzId,
      jobUrl,
      company,
      roleTitle: roleTitle || profile?._roleTitle || 'Workday Application',
      status: 'failed',
      failureReason: fullErrReason,
      failureScreenshotUrl: errShotUrl,
      stoppedAtStep: errStep,
    }).catch(() => {});

    const answeredSoFar = [];
    if (profile?._filledValues) {
      for (const [qLabel, qVal] of Object.entries(profile._filledValues)) {
        if (qLabel && qVal != null) {
          answeredSoFar.push({
            question: qLabel,
            answer: String(qVal),
            step: profile?._currentStep || errStep || 'Application',
            is_answered: true,
          });
        }
      }
    }
    if (profile?._answerCache && answeredSoFar.length === 0) {
      for (const [qLabel, qVal] of profile._answerCache.entries()) {
        if (qLabel && qVal != null) {
          answeredSoFar.push({
            question: qLabel,
            answer: String(qVal),
            step: profile?._currentStep || errStep || 'Application',
            is_answered: true,
          });
        }
      }
    }

    try {
      const { recordFailedJob, recordApplicationFailure } = await import('./supabaseClient.mjs');
      await recordFailedJob({
        applywizzId,
        jobId: task.job_id || task.jobId || null,
        jobUrl,
        company,
        roleTitle: roleTitle || profile?._roleTitle || 'Workday Application',
        failureReason: fullErrReason,
        failedAtStep: errStep,
        screenshotPath: errShotUrl,
        resolvedAnswers: answeredSoFar,
      });
      await recordApplicationFailure({
        applywizzId,
        jobId: task.job_id || task.jobId || null,
        jobUrl,
        company,
        roleTitle: roleTitle || profile?._roleTitle || 'Workday Application',
        failureReason: fullErrReason,
        screenshotPath: errShotUrl,
      });
    } catch {}

    return { status: 'error', error: err.message, cacheHit, screenshotUrl: errShotUrl, stoppedAtStep: errStep };
  } finally {
    try { await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null }); } catch {}
    try {
      unregisterActiveBrowser(browser);
      await browser.close();
    } catch {}
  }
}

/**
 * Run tasks using a pool of N concurrent workers (default 1).
 */
export async function runWorkerPool(tasks = [], {
  concurrency = 1,
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
 * ─────────────────────────────────────────────────────
 * Link-Clustered Fair-Share Scheduler
 * ─────────────────────────────────────────────────────
 * Strategy:
 *   1. Fetch ALL pending tasks for active CAs in one query.
 *   2. Group tasks by job_url (cluster).
 *   3. Sort into fair-share round-robin order across CA emails.
 *   4. Within each URL cluster: first task = "Blueprint Worker"
 *      (scans form, writes schema to Supabase job_form_schemas).
 *      Subsequent tasks = "Cache-Fill Workers" (wait for blueprint
 *      to populate cache, then fill instantly in 3-5s).
 *   5. Workers atomically claim their pre-assigned task by ID.
 */
export async function runQueueWorkerPool({
  concurrency = 1,
  headless = true,
  dryRun = false,
  confirmSubmit = !dryRun,
  defaultPassword = '',
  maxTasks = Infinity,
  activeCaOnly = false,
  caEmails = null,
} = {}) {
  setWorkerPoolStop(false);
  if (await isWorkerPoolStopRequested()) {
    console.log('🛑 [WORKER POOL] STOPPED: Active stop flag detected before pool start. Bot will NOT trigger.');
    return [];
  }

  // ── 1. Resolve active CA candidate scope ───────────────────────────
  let allowedCandidateIds = null;
  let activeEmails = [];
  let clientToCaMap = {};
  if (activeCaOnly || caEmails) {
    const caScope = await getActiveCaCandidateIds({ caEmails });
    allowedCandidateIds = caScope.candidateIds;
    activeEmails = caScope.activeEmails;
    clientToCaMap = caScope.clientToCaMap || {};
    console.log(`\n🔒 ACTIVE CA LEASING SCOPE:`);
    console.log(`   Active CA(s): ${activeEmails.length ? activeEmails.join(', ') : 'None'}`);
    console.log(`   Assigned Clients (${allowedCandidateIds.length}): ${allowedCandidateIds.join(', ') || 'None'}`);
    if (allowedCandidateIds.length === 0) {
      console.log('   🛑 [WORKER POOL] No candidates found for active CA(s). Bot will NOT trigger.');
      return [];
    }

    const totalApps = await getTotalApplicationCountForCandidates(allowedCandidateIds);
    if (totalApps === 0) {
      console.log('   🛑 [WORKER POOL] STOPPED: Application count is 0 for all clients of active CA(s). Bot will NOT trigger.');
      return [];
    }
  }

  // ── 2. Bulk-fetch all pending tasks for cluster analysis ────────────
  const allTasks = await fetchPendingTasksForActiveCAs(allowedCandidateIds);
  const pendingCount = allTasks.length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`⚡ ${concurrency}-WORKER LINK-CLUSTERED FAIR-SHARE QUEUE CONTROLLER`);
  console.log(`   Mode: ${headless ? 'Headless (background)' : 'Headful (visible browser windows)'}`);
  console.log(`   Active CA Filter: ${activeCaOnly || caEmails ? 'ENABLED' : 'ALL PENDING'}`);
  console.log(`   Auto-Submit: ${confirmSubmit && !dryRun ? 'ENABLED' : 'DISABLED (Review / Dry-Run)'}`);
  console.log(`   Total Pending Tasks: ${pendingCount}`);
  console.log(`${'═'.repeat(70)}\n`);

  if (pendingCount === 0) {
    console.log('🛑 [WORKER POOL] STOPPED: 0 pending tasks found. Bot will NOT trigger.');
    return [];
  }

  // ── 3. Build Link-Cluster Map ───────────────────────────────────────
  // urlClusterMap: normalizedUrl → [task, ...]  (first is blueprint)
  const urlClusterMap = new Map();
  for (const t of allTasks) {
    const url = String(t.job_url || '').replace(/\s+/g, '').trim();
    if (!urlClusterMap.has(url)) urlClusterMap.set(url, []);
    urlClusterMap.get(url).push(t);
  }

  const uniqueUrls = urlClusterMap.size;
  const repeatedUrls = [...urlClusterMap.values()].filter((g) => g.length > 1).length;
  console.log(`📊 Link-Cluster Analysis:`);
  console.log(`   Unique Job URLs: ${uniqueUrls}  |  Repeated URLs (cache-fill eligible): ${repeatedUrls}`);

  // ── 4. Fair-Share Round-Robin ordering across CAs AND Clients ───────
  // First group by CA email -> then round-robin across clients within each CA
  const caClientBuckets = new Map();
  for (const t of allTasks) {
    const awlId = String(t.applywizz_id || '').trim();
    const caEmail = (t.ca_email || clientToCaMap[awlId] || '').toLowerCase().trim() || 'unassigned';
    if (!caClientBuckets.has(caEmail)) caClientBuckets.set(caEmail, new Map());
    const clientMap = caClientBuckets.get(caEmail);
    if (!clientMap.has(awlId)) clientMap.set(awlId, []);
    clientMap.get(awlId).push(t);
  }

  // Within each CA, interleave across assigned clients so workers don't collide on the same client
  const caTaskBuckets = new Map();
  for (const [caEmail, clientMap] of caClientBuckets.entries()) {
    const interleavedClientTasks = [];
    const clientIters = [...clientMap.values()].map((arr) => arr[Symbol.iterator]());
    let hasMore = true;
    while (hasMore) {
      hasMore = false;
      for (const it of clientIters) {
        const nxt = it.next();
        if (!nxt.done) {
          interleavedClientTasks.push(nxt.value);
          hasMore = true;
        }
      }
    }
    caTaskBuckets.set(caEmail, interleavedClientTasks);
  }

  // Interleave across CAs in round-robin order
  const orderedTasks = [];
  const caIterators = [...caTaskBuckets.values()].map((b) => b[Symbol.iterator]());
  let progress = true;
  while (progress) {
    progress = false;
    for (const iter of caIterators) {
      const next = iter.next();
      if (!next.done) {
        orderedTasks.push(next.value);
        progress = true;
      }
    }
  }

  // Preserve round-robin order while placing each URL's blueprint task before its cache-fill tasks.
  // CRITICAL: Tasks that have been approved by CA ('approved_for_submission') receive top priority
  // so final submission triggers immediately when CA clicks Submit in the review modal!
  const approvedTasks = orderedTasks.filter((t) => t.status === 'approved_for_submission' || t.status === 'approved_by_ca' || t.status === 'queued_for_submission');
  const regularTasks = orderedTasks.filter((t) => t.status !== 'approved_for_submission' && t.status !== 'approved_by_ca' && t.status !== 'queued_for_submission');

  const urlOrder = new Map();
  const blueprintTasks = [];
  const cacheFillTasks = [];
  for (const t of regularTasks) {
    const url = String(t.job_url || '').replace(/\s+/g, '').trim();
    if (!urlOrder.has(url)) {
      urlOrder.set(url, 'blueprint');
      blueprintTasks.push(t);
    } else {
      cacheFillTasks.push(t);
    }
  }
  const fairTasks = [...approvedTasks, ...blueprintTasks, ...cacheFillTasks];

  console.log(`   Fair-Share Order Built: ${fairTasks.length} tasks (${approvedTasks.length} CA-approved for instant submit) across ${caTaskBuckets.size} active CA(s)\n`);

  // ── 5. Cluster Synchronization Primitives ──────────────────────────
  // urlCluster: URL → { state: 'scanning'|'cached'|'failed', resolve: fn }
  const urlCluster = new Map();

  function markUrlScanning(url) {
    if (!urlCluster.has(url)) {
      let resolveFn;
      const waitPromise = new Promise((res) => { resolveFn = res; });
      urlCluster.set(url, { state: 'scanning', waitPromise, resolveFn });
    }
  }

  function markUrlCached(url) {
    const entry = urlCluster.get(url);
    if (entry) {
      entry.state = 'cached';
      entry.resolveFn?.(); // release any waiting workers
    } else {
      urlCluster.set(url, { state: 'cached', waitPromise: Promise.resolve(), resolveFn: () => {} });
    }
  }

  async function waitForUrlCache(url, timeoutMs = 120_000) {
    const entry = urlCluster.get(url);
    if (!entry || entry.state === 'cached') return true;
    const timeout = new Promise((res) => setTimeout(() => res(false), timeoutMs));
    const cached = entry.waitPromise.then(() => true);
    return Promise.race([cached, timeout]);
  }

  // ── 6. Shared Task Queue (index pointer, atomic via closure) ────────
  const results = [];
  let taskPointer = 0;
  const taskLimit = Math.min(fairTasks.length, maxTasks);

  // ── 7. Worker Loop ──────────────────────────────────────────────────
  async function queueWorkerLoop(workerNumber) {
    const workerId = `submitting_worker_${workerNumber}`;

    while (taskPointer < taskLimit) {
      if (await isWorkerPoolStopRequested()) {
        console.log(`   🛑 [${workerId}] Stop requested! Halting worker loop.`);
        await updateWorkerStatus(workerId, {
          state: 'idle',
          current_application_id: null,
          stage: 'submitting',
          bot_name: `Submitting Worker ${workerNumber}`,
        }).catch(() => {});
        break;
      }

      // ── CA Session Lifecycle Watchdog (Immediate stop on Logout; 2-min grace on browser disconnect) ──
      if (activeCaOnly && caEmails?.length) {
        try {
          const ops = await getActiveOperators().catch(() => []);
          const ca = ops.find((o) => caEmails.some((e) => e.toLowerCase() === (o.email || '').toLowerCase().trim()));
          if (!ca || (ca.status || '').toLowerCase() === 'logged_out' || (ca.status || '').toLowerCase() === 'inactive') {
            console.log(`   ⏹ [${workerId}] CA has logged out or is inactive. Terminating worker pool.`);
            break;
          }
          const lastActivity = new Date(ca.updated_at || ca.last_sign_in || 0).getTime();
          if (Date.now() - lastActivity > 2 * 60 * 1000) {
            console.log(`   ⏹ [${workerId}] CA browser session disconnected for > 2 minutes. Terminating worker pool.`);
            break;
          }
        } catch {}
      }

      // Atomically grab next task index
      const myIndex = taskPointer++;
      if (myIndex >= taskLimit) break;

      const taskMeta = fairTasks[myIndex];
      if (!taskMeta) break;

      const url = String(taskMeta.job_url || '').replace(/\s+/g, '').trim();
      const clusterEntry = urlCluster.get(url);
      const isBlueprint = !clusterEntry; // first time we see this URL → blueprint role

      if (isBlueprint) {
        // Mark this URL as being scanned by this worker
        markUrlScanning(url);
        console.log(`   🔍 [${workerId}] BLUEPRINT  → ${taskMeta.applywizz_id} @ ${url.slice(0, 60)}`);
      } else {
        // Cache-fill: wait for blueprint to finish scanning
        console.log(`   ⏳ [${workerId}] CACHE-FILL → ${taskMeta.applywizz_id} @ ${url.slice(0, 60)} (waiting for blueprint...)`);
        const cacheReady = await waitForUrlCache(url, 120_000);
        if (cacheReady) {
          console.log(`   ⚡ [${workerId}] Cache ready! Proceeding with instant pre-resolved fill.`);
        } else {
          console.log(`   ⚠️  [${workerId}] Cache wait timeout for URL. Proceeding anyway (will scan independently).`);
        }
      }

      // Atomically claim this specific task by ID from Supabase
      const claimedTask = await leaseSpecificQueueTask(taskMeta.id, workerId);
      if (!claimedTask) {
        // Already claimed by another worker (race condition on restart, skip)
        console.log(`   ↩️  [${workerId}] Task ${taskMeta.id} already claimed by another worker. Skipping.`);
        if (isBlueprint) markUrlCached(url); // don't block cache-fill workers
        continue;
      }

      if (await isWorkerPoolStopRequested()) {
        console.log(`   🛑 [${workerId}] Stop requested before executing claimed task ${claimedTask.id}. Halting.`);
        await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null }).catch(() => {});
        break;
      }

      const result = await executeWorkerTask({
        task: {
          ...claimedTask,
          queueTaskId: claimedTask.id,
          applywizzId: claimedTask.applywizz_id,
          jobUrl: claimedTask.job_url,
        },
        workerId,
        taskIndex: myIndex + 1,
        totalTasks: taskLimit,
        options: {
          headless,
          confirmSubmit,
          dryRun,
          defaultPassword,
          allowedCandidateIds,
        },
      });

      // After blueprint finishes (success or failure), release cache-fill workers
      if (isBlueprint) {
        markUrlCached(url);
        if (result.status === 'submitted' || result.cacheHit === false) {
          console.log(`   ✅ [${workerId}] Blueprint DONE for ${url.slice(0, 60)} — cache-fill workers unblocked.`);
        }
      }

      results.push({
        applywizzId: claimedTask.applywizz_id,
        jobUrl: claimedTask.job_url,
        company: claimedTask.company,
        status: result.status,
        cacheHit: result.cacheHit || false,
        isBlueprint,
        error: result.error,
      });
    }

    await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null }).catch(() => {});
  }

  // ── 8. Launch Workers ───────────────────────────────────────────────
  const workerPromises = [];
  for (let w = 1; w <= concurrency; w++) {
    workerPromises.push(queueWorkerLoop(w));
  }
  await Promise.all(workerPromises);

  for (let w = 1; w <= concurrency; w++) {
    await updateWorkerStatus(`submitting_worker_${w}`, {
      state: 'idle',
      current_application_id: null,
      stage: 'submitting',
      bot_name: `Submitting Worker ${w}`,
    }).catch(() => {});
  }

  // ── 9. Summary ──────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${concurrency}-WORKER LINK-CLUSTERED FAIR-SHARE SUMMARY`);
  console.log(`${'═'.repeat(70)}`);
  const submitted = results.filter((r) => r.status === 'submitted').length;
  const reachedReview = results.filter((r) => r.status === 'reached_review' || r.status === 'reached-review').length;
  const cacheHits = results.filter((r) => r.cacheHit).length;
  const blueprints = results.filter((r) => r.isBlueprint).length;
  const cacheFills = results.filter((r) => !r.isBlueprint && r.cacheHit).length;
  const failed = results.filter((r) => ['error', 'auth_failed', 'invalid_url', 'profile_load_failed', 'auth_missing'].includes(r.status)).length;

  console.log(`  Total Tasks Processed: ${results.length}`);
  console.log(`  ✅ Submitted:            ${submitted}`);
  console.log(`  🎯 Reached Review:       ${reachedReview}`);
  console.log(`  🔍 Blueprint Scans:      ${blueprints} (unique URLs scanned & cached)`);
  console.log(`  ⚡ Cache-Fill Hits:      ${cacheFills} (instant fills from blueprint cache)`);
  console.log(`  ❌ Failed:               ${failed}`);
  console.log(`  🏆 Cache Efficiency:     ${results.length > 0 ? Math.round((cacheHits / results.length) * 100) : 0}%`);
  console.log(`${'═'.repeat(70)}\n`);

  return results;
}

/**
 * Execute a single targeted application submission directly for a specific candidate.
 * Dispatched on-demand when a Career Associate clicks "Review & Submit" in the Slide Drawer.
 *
 * Guarantees:
 * 1. Runs strictly on an assigned submitting worker (submitting_worker_1, 2, or 3).
 * 2. Does NOT trigger the global batch runner; logs remain isolated to this single application.
 * 3. Immediately marks job_distributions.status = 'applying'.
 * 4. Navigates via Playwright, applies 4-tier resolved answers, handles Zoho Mail verification/reset if prompted.
 * 5. On submission success: captures final confirmation screenshot, uploads to Supabase Storage,
 *    saves to job_distributions.application_submitted_screenshot_url, and marks status = 'submitted'.
 * 6. On failure: captures failure screenshot, records to failed_jobs with resolved_answers,
 *    and marks job_distributions.status = 'failed'.
 */
export async function executeSingleTargetedSubmission({
  distributionId = null,
  applywizzId = '',
  jobUrl = '',
  workerId = 'submitting_worker_1',
  headless = true,
  defaultPassword = process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
} = {}) {
  const cleanId = String(applywizzId || '').trim().toUpperCase();
  const cleanUrl = String(jobUrl || '').trim();
  const now = new Date().toISOString();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎯 [TARGETED SUBMISSION TRIGGERED]`);
  console.log(`   • Worker:        ${workerId}`);
  console.log(`   • Candidate:     ${cleanId}`);
  console.log(`   • Job URL:       ${cleanUrl}`);
  console.log(`   • Distribution:  ${distributionId || 'Lookup by AWL + URL'}`);
  console.log(`${'═'.repeat(70)}\n`);

  // 1. Fetch task details from job_distributions
  const { createClient } = await import('@supabase/supabase-js');
  const { loadLocalEnvOnce } = await import('./supabaseClient.mjs');
  const env = loadLocalEnvOnce();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let distRow = null;
  try {
    if (distributionId) {
      const { data } = await supabase.from('job_distributions').select('*').eq('id', distributionId).maybeSingle();
      distRow = data;
    }
    if (!distRow && cleanId && cleanUrl) {
      const { data } = await supabase.from('job_distributions').select('*').eq('applywizz_id', cleanId).eq('job_url', cleanUrl).maybeSingle();
      distRow = data;
    }
  } catch (err) {
    console.warn(`   ⚠️ [${workerId}] Warning fetching distribution record: ${err?.message}`);
  }

  const finalApplywizzId = cleanId || distRow?.applywizz_id || '';
  const finalJobUrl = cleanUrl || distRow?.job_url || '';
  const company = distRow?.company || extractWorkdayCompanyName(finalJobUrl);
  const roleTitle = distRow?.role_title || 'Workday Application';

  if (!finalApplywizzId || !finalJobUrl) {
    throw new Error(`Targeted submission requires both applywizzId and jobUrl (received: ${finalApplywizzId}, ${finalJobUrl})`);
  }

  // 2. Set worker status & job_distributions to applying
  await updateWorkerStatus(workerId, {
    state: 'in_flight',
    stage: 'submitting',
    current_application_id: distributionId || `${finalApplywizzId}:${finalJobUrl}`,
    bot_name: `Submitting Worker ${workerId.slice(-1)}`,
  }).catch(() => {});

  if (distributionId) {
    await supabase.from('job_distributions').update({
      status: 'applying',
      worker_id: workerId,
      reviewed_by: 'Career Associate',
      reviewed_at: now,
      updated_at: now,
    }).eq('id', distributionId).catch(() => {});
  } else {
    await supabase.from('job_distributions').update({
      status: 'applying',
      worker_id: workerId,
      reviewed_by: 'Career Associate',
      reviewed_at: now,
      updated_at: now,
    }).eq('applywizz_id', finalApplywizzId).eq('job_url', finalJobUrl).catch(() => {});
  }

  // 3. Execute submission task via Playwright
  let result = null;
  try {
    result = await executeWorkerTask({
      task: {
        id: distributionId,
        applywizzId: finalApplywizzId,
        jobUrl: finalJobUrl,
        company,
        roleTitle,
        status: 'approved_for_submission',
        pre_resolved_answers: distRow?.resolved_answers || [],
      },
      workerId,
      taskIndex: 1,
      totalTasks: 1,
      options: {
        headless: Boolean(headless),
        confirmSubmit: true,
        dryRun: false,
        defaultPassword,
      },
    });
  } catch (err) {
    result = {
      status: 'failed',
      error: err?.message || 'Execution error',
      failureReason: err?.message || 'Execution error',
    };
  }

  const isSubmitted = result?.status === 'submitted';
  const finalProofShot = result?.screenshotUrl || result?.proof_screenshot_url || null;

  // 4. Update job_distributions with final status and proof screenshot
  const completionTimestamp = new Date().toISOString();
  if (isSubmitted) {
    console.log(`\n🎉 [${workerId}] TARGETED SUBMISSION SUCCEEDED! Verified Workday confirmation proof saved: ${finalProofShot || 'Uploaded'}`);
    const updateBody = {
      status: 'submitted',
      application_submitted_screenshot_url: finalProofShot,
      worker_id: workerId,
      updated_at: completionTimestamp,
    };
    if (distributionId) {
      await supabase.from('job_distributions').update(updateBody).eq('id', distributionId).catch(() => {});
    } else {
      await supabase.from('job_distributions').update(updateBody).eq('applywizz_id', finalApplywizzId).eq('job_url', finalJobUrl).catch(() => {});
    }

    // Sync to applications table for Admin, Developer, and Manager dashboards
    const appRow = {
      applywizz_id: finalApplywizzId,
      job_url: finalJobUrl,
      company: company || 'Workday Tenant',
      role_title: roleTitle || 'Workday Position',
      status: 'submitted',
      screenshot_url: finalProofShot,
      applied_screenshot: finalProofShot,
      updated_at: completionTimestamp,
    };
    await supabase.from('applications').upsert(appRow, { onConflict: 'applywizz_id,job_url' }).catch(() => {});
  } else {
    console.log(`\n❌ [${workerId}] Targeted submission stopped (${result?.failureReason || result?.status || 'Failed'}).`);
    const updateBody = {
      status: 'failed',
      error_message: result?.failureReason || result?.error || 'Submission failed',
      worker_id: workerId,
      updated_at: completionTimestamp,
    };
    if (distributionId) {
      await supabase.from('job_distributions').update(updateBody).eq('id', distributionId).catch(() => {});
    } else {
      await supabase.from('job_distributions').update(updateBody).eq('applywizz_id', finalApplywizzId).eq('job_url', finalJobUrl).catch(() => {});
    }

    // Sync failure to applications table
    const appRow = {
      applywizz_id: finalApplywizzId,
      job_url: finalJobUrl,
      company: company || 'Workday Tenant',
      role_title: roleTitle || 'Workday Position',
      status: 'failed',
      failure_reason: result?.failureReason || result?.error || 'Submission failed',
      updated_at: completionTimestamp,
    };
    await supabase.from('applications').upsert(appRow, { onConflict: 'applywizz_id,job_url' }).catch(() => {});
  }

  // 5. Release worker back to idle
  await updateWorkerStatus(workerId, {
    state: 'idle',
    stage: 'submitting',
    current_application_id: null,
    bot_name: `Submitting Worker ${workerId.slice(-1)}`,
  }).catch(() => {});

  return {
    success: isSubmitted,
    status: result?.status || (isSubmitted ? 'submitted' : 'failed'),
    screenshotUrl: finalProofShot,
    workerId,
    applywizzId: finalApplywizzId,
    jobUrl: finalJobUrl,
  };
}


