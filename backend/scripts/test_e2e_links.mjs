import dotenv from 'dotenv';
dotenv.config();

import { executeWorkerTask } from '../lib/workerPool.mjs';

const JOBS = [
  {
    name: 'Link 1 (Monotype)',
    company: 'Monotype',
    role: 'Sr. Full Stack AI Engineer',
    url: 'https://monotype.wd1.myworkdayjobs.com/en-US/Monotype/job/Woburn-MA/Sr-Full-Stack-AI-Engineer_R0004965',
    // Candidate list from batch queue: AWL-1568 (not in Zoho) followed by AWL-29927 (active in Zoho)
    candidates: ['AWL-1568', 'AWL-29927'],
  },
  {
    name: 'Link 2 (NASCAR)',
    company: 'NASCAR',
    role: 'Junior Data Scientist',
    url: 'https://nascar.wd1.myworkdayjobs.com/NASCAR/job/Daytona-Beach-FL/Junior-Data-Scientist_JR14445',
    candidates: ['AWL-29927'],
  },
];

async function runE2ETest() {
  console.log('═'.repeat(80));
  console.log('🧪 HUMAN-LIKE E2E WORKFLOW TEST: ZOHO AUTH CASCADE + ATOMIC RESCAN');
  console.log('═'.repeat(80));

  const results = [];

  for (let jIdx = 0; jIdx < JOBS.length; jIdx++) {
    const job = JOBS[jIdx];
    console.log(`\n\n${'▶'.repeat(40)}`);
    console.log(`E2E TEST [${jIdx + 1}/${JOBS.length}]: ${job.name} - ${job.company}`);
    console.log(`URL: ${job.url}`);
    console.log(`Candidate Queue: ${job.candidates.join(' ➔ ')}`);
    console.log(`${'▶'.repeat(40)}\n`);

    let jobCompleted = false;
    let finalResult = null;

    for (let cIdx = 0; cIdx < job.candidates.length; cIdx++) {
      const candidateId = job.candidates[cIdx];
      console.log(`\n--- Attempting Candidate [${cIdx + 1}/${job.candidates.length}]: ${candidateId} ---`);

      const task = {
        id: `e2e_task_${Date.now()}_${jIdx}_${cIdx}`,
        applywizz_id: candidateId,
        applywizzId: candidateId,
        job_url: job.url,
        jobUrl: job.url,
        company: job.company,
        roleTitle: job.role,
      };

      const startTime = Date.now();
      try {
        const res = await executeWorkerTask({
          task,
          workerId: `e2e_worker_${jIdx + 1}`,
          taskIndex: jIdx + 1,
          totalTasks: JOBS.length,
          options: {
            headless: true,
            dryRun: true,
            confirmSubmit: false,
            isClusterBlueprint: true,
            isScanOnly: false, // Run full wizard page traversal
          },
        });

        const durationSec = Math.round((Date.now() - startTime) / 1000);
        finalResult = res;

        const isSuccess = res && (
          res.status === 'submitted' ||
          res.status === 'reached-review' ||
          res.status === 'reached_review' ||
          res.status === 'ready_for_review' ||
          String(res.stoppedAtStep || '').toLowerCase().includes('review')
        );

        if (isSuccess) {
          console.log(`\n🎉 [SUCCESS] Candidate ${candidateId} completed application wizard for ${job.name}! Reached: ${res.stoppedAtStep}`);
          jobCompleted = true;
          results.push({
            job: job.name,
            company: job.company,
            url: job.url,
            candidateUsed: candidateId,
            status: res.status || 'reached_review',
            step: res.stoppedAtStep || 'Review & Submit',
            durationSec,
            error: null,
          });
          break;
        }

        // Check if candidate failed due to Zoho verification not connected:
        const isZohoIssue =
          res?.status === 'auth-failed' ||
          res?.status === 'zoho_not_connected' ||
          res?.reason === 'mailbox_not_connected' ||
          res?.reason === 'zoho mail not connected' ||
          res?.isZohoNotConnected ||
          String(res?.failureReason || '').toLowerCase().includes('zoho') ||
          String(res?.failureReason || '').toLowerCase().includes('verification');

        if (isZohoIssue && cIdx < job.candidates.length - 1) {
          console.log(`\n⚠️  [ZOHO FALLBACK TRIGGERED] Candidate ${candidateId} requires email verification but is NOT connected in Zoho.`);
          console.log(`    ❌ Rejecting candidate ${candidateId} ONLY — keeping job link ALIVE.`);
          console.log(`    ➡️  Cascading immediately to sibling candidate: ${job.candidates[cIdx + 1]}...\n`);
          continue;
        }

        // If dead job or other error
        results.push({
          job: job.name,
          company: job.company,
          url: job.url,
          candidateUsed: candidateId,
          status: res?.status || 'failed',
          step: res?.stoppedAtStep || 'Unknown Step',
          durationSec,
          error: res?.failureReason || res?.reason || null,
        });
        break;
      } catch (err) {
        console.error(`❌ Exception testing ${candidateId}:`, err);
        if (cIdx < job.candidates.length - 1) {
          console.log(`    ➡️  Cascading to next candidate ${job.candidates[cIdx + 1]}...`);
          continue;
        }
        results.push({
          job: job.name,
          company: job.company,
          url: job.url,
          candidateUsed: candidateId,
          status: 'exception',
          step: 'Exception',
          durationSec: Math.round((Date.now() - startTime) / 1000),
          error: err.message,
        });
        break;
      }
    }
  }

  console.log('\n\n' + '═'.repeat(80));
  console.log('📊 FINAL E2E RESULTS SUMMARY:');
  console.log('═'.repeat(80));
  console.table(results);
}

runE2ETest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
