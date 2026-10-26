import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { executeWorkerTask } from '../lib/workerPool.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import fs from 'fs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function runHeadfulSingleTask() {
  console.log('🚀 [Headful Single Test] Reading CSV for first task...');

  if (!fs.existsSync('expired_and_restarted_applications.csv')) {
    console.error('CSV expired_and_restarted_applications.csv not found!');
    process.exit(1);
  }

  const content = fs.readFileSync('expired_and_restarted_applications.csv', 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length <= 1) {
    console.error('No tasks found in CSV!');
    process.exit(1);
  }

  // Parse header and first row
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const parseRow = (line) => {
    // regex to parse CSV line handling quotes
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    values.push(current);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] || '';
    });
    return obj;
  };

  const firstRow = parseRow(lines[1]);
  console.log('📋 Selected Task 1:');
  console.log('   ID:', firstRow.id);
  console.log('   Distribution ID:', firstRow.distribution_id);
  console.log('   Candidate:', firstRow.applywizz_id);
  console.log('   Company:', firstRow.company);
  console.log('   Role:', firstRow.role_title);
  console.log('   Job URL:', firstRow.job_url);

  // Fetch full distribution data if available to pass resolved answers
  let resolvedAnswers = [];
  if (firstRow.distribution_id) {
    try {
      const dRes = await httpsJsonWithRetry({
        url: `${url}/rest/v1/job_distributions?id=eq.${firstRow.distribution_id}&select=*`,
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      const dist = dRes.json()?.[0];
      if (Array.isArray(dist?.resolved_answers)) {
        resolvedAnswers = dist.resolved_answers;
        console.log(`   * Loaded ${resolvedAnswers.length} pre-resolved answers from job_distributions`);
      }
    } catch (e) {
      console.warn('   Could not load job_distributions row:', e.message);
    }
  }

  const taskPayload = {
    id: firstRow.distribution_id || firstRow.id,
    distributionId: firstRow.distribution_id || null,
    taskId: firstRow.id,
    applywizzId: firstRow.applywizz_id,
    jobUrl: firstRow.job_url,
    company: firstRow.company,
    roleTitle: firstRow.role_title,
    status: 'approved_for_submission',
    resolvedAnswers,
    preResolvedAnswers: resolvedAnswers,
  };

  console.log('\n🖥️ Launching Playwright browser in HEADFUL mode (headless: false)...');

  const startTime = Date.now();
  const result = await executeWorkerTask({
    task: taskPayload,
    workerId: 'test_headful_worker',
    taskIndex: 1,
    totalTasks: 1,
    options: {
      headless: false,
      confirmSubmit: true,
      dryRun: false,
      taskId: firstRow.id,
    },
  });

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏁 [Headful Single Test] FINISHED in ${durationSec}s`);
  console.log('   Status:', result?.status);
  console.log('   Reason/Error:', result?.error || result?.reason || 'None');
  console.log('   Screenshot Path:', result?.screenshotPath || 'None');
  console.log('   Screenshot URL:', result?.screenshotUrl || 'None');
  console.log(`${'═'.repeat(70)}`);

  if (result?.status === 'submitted' || result?.status === 'success' || result?.status === 'already_applied') {
    console.log('\n🎉 TEST SUCCESSFUL!');
    process.exit(0);
  } else {
    console.log('\n⚠️ Task did not complete with submitted/already_applied status:', result?.status);
    process.exit(1);
  }
}

runHeadfulSingleTask().catch((err) => {
  console.error('\n❌ Fatal error running headful single task:', err);
  process.exit(1);
});
