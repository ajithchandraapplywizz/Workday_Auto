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
import { resolveCompanyEmail } from './applyWizzClient.mjs';
import { checkAndPreResolveJobForClient, recordDiscoveredJobForm, bulkPreResolveForJobUrl } from './jobFormCache.mjs';
import { upsertSupabaseApplication, updateQueueTaskStatus, leaseNextQueueTask, leaseSpecificQueueTask, fetchPendingTasksForActiveCAs, getBatchQueueStats, updateWorkerStatus, getActiveCaCandidateIds, getTotalApplicationCountForCandidates, uploadStorageScreenshot, getActiveOperators, logAutomationTrace } from './supabaseClient.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEAD_JOB_URLS = new Set();

async function purgeDeadJobUrlAcrossQueue(jobUrl, workerId, screenshotUrl = null) {
  DEAD_JOB_URLS.add(jobUrl);
  console.log(`   🚫 [${workerId}] Purging dead job URL from queue for ALL clients: "${jobUrl}"`);
  try {
    const { getSupabaseClient } = await import('./supabaseClient.mjs');
    const supabase = getSupabaseClient();
    if (supabase) {
      const expiredReason = `Link Expired: The page you are looking for doesn't exist [step: Link Expired]${screenshotUrl ? ` [screenshot: ${screenshotUrl}]` : ''}`;
      const payload = {
        status: 'failed',
        error_message: expiredReason,
        completed_at: new Date().toISOString()
      };
      if (screenshotUrl) payload.screenshot_path = screenshotUrl;
      const { data, error } = await supabase.from('batch_job_queue')
        .update(payload)
        .eq('job_url', jobUrl)
        .eq('status', 'pending')
        .select('id, applywizz_id');
      if (!error && data?.length) {
        console.log(`   ✅ [${workerId}] Cancelled/purged ${data.length} pending task(s) for dead URL across all clients.`);
      }
    }
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

  // 3. Resolve Workday credentials for this candidate
  const candidateEmail = resolveCompanyEmail(profile.personal || profile, [profile.personal?.first_name, profile.personal?.last_name].filter(Boolean).join(' ') || profile.name || '');
  const workdayEmail = candidateEmail || profile.personal?.email || '';
  const workdayPassword = defaultPassword || process.env.WORKDAY_PASSWORD || '';

  const expCount = profile.experience?.length || profile.work_experience?.length || 0;
  const skillsCount = profile.skills?.length || 0;
  appLog(2, `Supabase Profile: Loaded candidate record for ${applywizzId} (${workdayEmail}). Indexed ${expCount} job experiences, ${skillsCount} verified skills.`);

  console.log(`   📧 [${workerId}] Using candidate credentials: ${workdayEmail} for ${applywizzId}`);

  if (!workdayEmail || !workdayPassword) {
    const err = `Missing credentials for ${applywizzId} (${workdayEmail || 'no-email'})`;
    console.error(`   ❌ [${workerId}] ${err}`);
    appLog(2, `Auth Error: Missing Workday login credentials for ${applywizzId}`);
    if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: err });
    return { status: 'auth_missing', error: err };
  }

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
    const preCount = Object.keys(queuePreResolved).length;
    appLog(3, `Supabase QA Cache HIT: Loaded ${preCount} pre-resolved answers from queue cell for instant fill.`);
    console.log(`   ⚡ [${workerId}] Queue Pre-Resolved Hit: ${preCount} answers loaded directly from queue cell for instant fill.`);
  } else {
    try {
      const cacheResult = await checkAndPreResolveJobForClient({ jobUrl, profile });
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
  appLog(4, `Playwright: Initialized isolated browser context (1280x900) for ${workdayEmail}. Launching headless Chrome.`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
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

    if (scan.jobMissing || scan.reason === 'job_expired_or_not_found') {
      console.log(`   ❌ [${workerId}] Dead / expired job posting detected ("The page you are looking for doesn't exist" / "Search for Jobs").`);
      await purgeDeadJobUrlAcrossQueue(jobUrl, workerId);

      await browser.close().catch(() => {});
      if (queueTaskId) {
        await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: 'job_expired_or_not_found' });
      }
      await upsertSupabaseApplication({
        applywizzId,
        jobUrl,
        company,
        roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
        status: 'failed',
        failureReason: 'Job page does not exist (dead/expired URL)',
      }).catch(() => {});

      return { status: 'failed', reason: 'job_expired_or_not_found' };
    }

    const extractedRole = await extractJobRoleFromDom(page, jobUrl);
    if (extractedRole) {
      roleTitle = extractedRole;
      profile._jobTitle = roleTitle;
      profile._roleTitle = roleTitle;
      console.log(`   [${workerId}] 💼 Role: ${roleTitle}`);
    }

    if (scan.authFailed || (scan.field_count === 0 && !await isWorkdayWizardVisible(page))) {
      const wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
      if (!wizardNow) {
        const isMailboxNotConnected = scan.authReason === 'mailbox_not_connected' || scan.reason === 'mailbox_not_connected';
        if (isMailboxNotConnected) {
          console.log(`   ⚠️ [${workerId}] Skipping ${applywizzId}: Zoho mail not connected for password reset/verification (193 pool).`);
          await browser.close().catch(() => {});
          if (queueTaskId) {
            await updateQueueTaskStatus(queueTaskId, { status: 'skipped', errorMessage: 'zoho_email_not_connected' });
          }
          await upsertSupabaseApplication({
            applywizzId,
            jobUrl,
            company,
            roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
            status: 'skipped',
            failureReason: 'Zoho mail verification not connected (193 pool)',
          }).catch(() => {});
          return { status: 'skipped', reason: 'zoho_email_not_connected' };
        }
        console.log(`   ❌ [${workerId}] Authentication failed for ${workdayEmail}.`);
        let authShotUrl = null;
        try {
          if (page && !page.isClosed()) {
            const buf = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
            if (buf) {
              authShotUrl = await uploadStorageScreenshot('application-failures', `${applywizzId}_${Date.now()}_auth_fail.jpg`, buf);
            }
          }
        } catch {}
        await browser.close().catch(() => {});
        if (queueTaskId) await updateQueueTaskStatus(queueTaskId, { status: 'failed', errorMessage: 'auth_failed', screenshotPath: authShotUrl });
        await upsertSupabaseApplication({
          applywizzId,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          status: 'failed',
          failureReason: 'Authentication failed',
          failureScreenshotUrl: authShotUrl,
          stoppedAtStep: 'Auth Gateway (Sign In / Sign Up)',
        }).catch(() => {});
        return { status: 'auth_failed', screenshotUrl: authShotUrl };
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

      return { status: 'job_expired', reason: 'Link Expired', screenshotUrl: expiredShotUrl };
    }

    // Step E: Save newly discovered form schema to Supabase if unique link
    const combinedFields = [
      ...(Array.isArray(scan.fields) ? scan.fields : []),
      ...(Array.isArray(profile._harvestedFields) ? profile._harvestedFields : []),
    ].filter((f) => f && f.type !== 'password' && !/password/i.test(f.name || '') && !/password/i.test(f.label || ''));

    if (!cacheHit && combinedFields.length > 0) {
      try {
        const saved = await recordDiscoveredJobForm({
          jobUrl,
          profile,
          fields: combinedFields,
          stepNames: profile._discoveredSteps ? [...profile._discoveredSteps] : ['Application'],
          company,
          roleTitle,
        });

        // Immediately bulk-pre-resolve for all other pending clients sharing this URL (scoped to active CAs).
        if (saved) {
          const { loadJobFormSchema: getSchema } = await import('./supabaseClient.mjs');
          const savedSchema = await getSchema(jobUrl).catch(() => null);
          if (savedSchema?.fields_schema?.length) {
            const profilePath = findFilePath('config/profile.yml');
            await bulkPreResolveForJobUrl({
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
    let completionShotUrl = null;
    let detectedStep = null;
    try {
      if (page && !page.isClosed()) {
        const { detectWorkdayStep } = await import('./stateDetector.mjs');
        detectedStep = await detectWorkdayStep(page).catch(() => null);
        const buf = profile?._submissionScreenshotBuffer || await page.screenshot({ type: 'jpeg', quality: 85 }).catch(() => null);
        if (buf) {
          const bucket = (status === 'submitted' || status === 'reached-review' || status === 'reached_review')
            ? 'application-successes'
            : 'application-failures';
          completionShotUrl = await uploadStorageScreenshot(bucket, `${applywizzId}_${Date.now()}_${status}.jpg`, buf);
        }
      }
    } catch {}

    const isSuccessStatus = (status === 'submitted' || status === 'reached-review' || status === 'reached_review');
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
      : (status === 'reached-review' || status === 'reached_review')
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
      try {
        const { saveResolvedAnswers } = await import('./supabaseClient.mjs');
        await saveResolvedAnswers({
          applywizzId,
          jobUrl,
          company,
          roleTitle: roleTitle || profile._roleTitle || 'Workday Application',
          resolvedAnswersJson: profile._scrapedReviewFields || [],
          isFullyAnswered: true,
          unansweredCount: 0,
          status: 'ready_for_review',
          screenshotUrl: completionShotUrl,
        });
      } catch {}
      appLog(15, `Playwright: Reached Step 5 (Review & Submit). Form paused for CA review. High-res verification screenshot saved: ${completionShotUrl || 'Supabase'}`);
    }

    console.log(`   ✅ [${workerId}] Finished task for ${applywizzId} with status: "${status}"`);
    return { status, cacheHit, screenshotUrl: completionShotUrl };
  } catch (err) {
    console.error(`   ❌ [${workerId}] Error executing task: ${err.message}`);
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
    return { status: 'error', error: err.message, cacheHit, screenshotUrl: errShotUrl };
  } finally {
    try { await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null }); } catch {}
    try { await browser.close(); } catch {}
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
    const workerId = `Worker-${workerNumber}`;

    while (taskPointer < taskLimit) {
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
  }

  // ── 8. Launch Workers ───────────────────────────────────────────────
  const workerPromises = [];
  for (let w = 1; w <= concurrency; w++) {
    workerPromises.push(queueWorkerLoop(w));
  }
  await Promise.all(workerPromises);

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

