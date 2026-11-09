/**
 * distribute_scanned_jobs.mjs
 *
 * Distributes all previously scanned and resolved jobs from `scanned_jobs`
 * into `job_distributions` for all allotted candidates.
 */

import {
  loadLocalEnvOnce,
  request,
  recordJobDistributions,
  findQueueTasksForJobUrl,
  getActiveCaCandidateIds,
} from '../lib/supabaseClient.mjs';
import { parseCandidateAwlIds } from '../lib/candidateParser.mjs';

loadLocalEnvOnce();

async function run() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🚀 [DISTRIBUTION SYNC] Verifying Database Preconditions...`);
  console.log(`${'═'.repeat(72)}\n`);

  // 1. Check if the dead submission_tasks trigger is still active in Supabase
  const testId = `AWL-PRECHECK-${Date.now()}`;
  let triggerActive = false;
  try {
    await request('job_distributions', {
      method: 'POST',
      body: [{
        applywizz_id: testId,
        job_url: 'https://precheck-test.example.com',
        company: 'Precheck Co',
        is_fully_answered: true,
        status: 'ready_for_review',
      }],
    });
    // Clean up test record
    await request('job_distributions', {
      method: 'DELETE',
      query: `?applywizz_id=eq.${testId}`,
    }).catch(() => {});
    console.log(`✅ Database trigger check: CLEAN (No legacy submission_tasks trigger blocking inserts)`);
  } catch (err) {
    if (err?.message?.includes('submission_tasks')) {
      triggerActive = true;
      console.error(`\n❌ [BLOCKER DETECTED] Dead trigger 'trg_job_distributions_on_fully_answered' is active in Supabase!`);
      console.error(`   Postgres Error: ${err.message}`);
      console.error(`\n👉 Please run the following SQL in your Supabase SQL Editor to drop the dead trigger:\n`);
      console.error(`   DROP TRIGGER IF EXISTS trg_job_distributions_on_fully_answered ON public.job_distributions;`);
      console.error(`   DROP FUNCTION IF EXISTS public.trg_job_distributions_insert_submission_task() CASCADE;`);
      console.error(`   NOTIFY pgrst, 'reload schema';\n`);
      console.error(`   (See file: migrations/052_drop_legacy_submission_tasks_trigger.sql)`);
      return;
    } else {
      console.warn(`⚠️ Precheck warning: ${err.message}`);
    }
  }

  // 2. Fetch all scanned jobs with discovered questions & resolved answers
  console.log(`\n🔍 Fetching scanned jobs from 'scanned_jobs' table...`);
  const scannedJobs = await request('scanned_jobs', {
    query: '?select=id,applywizz_id,job_id,job_url,company,role_title,scraped_questions,resolved_answers,screenshot_path&order=created_at.desc&limit=100',
  });

  if (!Array.isArray(scannedJobs) || scannedJobs.length === 0) {
    console.log(`ℹ️ No scanned jobs found in scanned_jobs.`);
    return;
  }
  console.log(`📋 Found ${scannedJobs.length} scanned jobs to distribute.`);

  // 3. Fetch active candidate pool
  const activeCandidatesRes = await getActiveCaCandidateIds().catch(() => ({}));
  let fallbackCandidates = Array.isArray(activeCandidatesRes)
    ? activeCandidatesRes
    : (Array.isArray(activeCandidatesRes?.candidateIds) ? activeCandidatesRes.candidateIds : []);

  let distributedTotal = 0;
  let skippedTotal = 0;

  for (let i = 0; i < scannedJobs.length; i++) {
    const sj = scannedJobs[i];
    const cleanUrl = String(sj.job_url || '').trim();
    const company = sj.company || 'Workday Partner';
    const roleTitle = sj.role_title || 'Application';
    const questions = sj.scraped_questions || [];
    const answers = sj.resolved_answers || [];

    console.log(`\n[${i + 1}/${scannedJobs.length}] Processing: ${company} — ${roleTitle}`);
    console.log(`   URL: ${cleanUrl}`);
    console.log(`   Discovered Questions: ${questions.length} | Resolved Answers: ${answers.length}`);

    // Find candidates specifically assigned to this URL in batch_job_queue
    let candidateIds = [];
    try {
      const qTasks = await findQueueTasksForJobUrl(cleanUrl);
      if (qTasks && qTasks.length > 0) {
        candidateIds = [...new Set(qTasks.flatMap(t => parseCandidateAwlIds(t.applywizz_id)))];
      }
    } catch {}

    // Fallback candidates if queue row not found
    if (candidateIds.length === 0) {
      if (sj.applywizz_id) candidateIds.push(sj.applywizz_id);
      if (fallbackCandidates.length > 0) {
        for (const cid of fallbackCandidates.slice(0, 20)) {
          if (!candidateIds.includes(cid)) candidateIds.push(cid);
        }
      }
    }

    console.log(`   Candidates to distribute: ${candidateIds.length} candidate(s)`);

    const clientRows = candidateIds.map(awl => ({
      applywizzId: awl,
      jobId: sj.job_id || sj.id,
      jobUrl: cleanUrl,
      company,
      roleTitle,
      resolvedAnswers: answers,
      unansweredQuestions: [],
      unansweredCount: 0,
      isFullyAnswered: true,
      screenshotUrl: null,
      status: 'ready_for_review',
    }));

    const ok = await recordJobDistributions({
      scannedJobId: sj.id,
      leadApplywizzId: sj.applywizz_id,
      jobId: sj.job_id || sj.id,
      jobUrl: cleanUrl,
      company,
      roleTitle,
      scrapedQuestions: questions,
      resolvedAnswers: answers,
      screenshotUrl: null,
      status: 'ready_for_review',
      clients: clientRows,
    });

    if (ok) {
      distributedTotal += clientRows.length;
    } else {
      skippedTotal += clientRows.length;
    }
  }

  // 4. Verification check
  const distCheck = await request('job_distributions', {
    query: '?select=id,status,applywizz_id,job_url&limit=10',
  });

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🎉 [DISTRIBUTION COMPLETE]`);
  console.log(`   • Total Candidates Distributed: ${distributedTotal}`);
  console.log(`   • Total Current Rows in job_distributions: ${distCheck?.length || 0}`);
  console.log(`${'═'.repeat(72)}\n`);
}

run().catch((err) => {
  console.error('Fatal error during distribution:', err);
  process.exit(1);
});
