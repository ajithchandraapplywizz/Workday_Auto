import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import fs from 'fs';
import path from 'path';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchExpiredAndInterrupted() {
  console.log('🔍 Querying Supabase for expired lease and daemon restarted applications...');

  // 1. Check submission_tasks
  const subTasksRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/submission_tasks?or=(error_message.ilike.*lease*expired*,error_message.ilike.*daemon*restart*,error_message.ilike.*interrupted*)&select=id,distribution_id,applywizz_id,job_url,company,role_title,status,error_message,created_at,updated_at&order=created_at.desc&limit=2000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const subTasks = subTasksRes.json() || [];
  console.log(`📋 Found ${subTasks.length} matching rows in submission_tasks`);

  // 2. Check failed_jobs
  const failedJobsRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/failed_jobs?or=(failure_reason.ilike.*lease*expired*,failure_reason.ilike.*daemon*restart*,failure_reason.ilike.*interrupted*)&select=id,applywizz_id,job_url,company,role_title,failure_reason,created_at&order=created_at.desc&limit=2000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const failedJobs = failedJobsRes.json() || [];
  console.log(`📋 Found ${failedJobs.length} matching rows in failed_jobs`);

  // Combine and deduplicate
  const rows = [];
  const seen = new Set();

  for (const t of subTasks) {
    const key = `${t.applywizz_id}_${t.job_url}`;
    if (!seen.has(key)) {
      seen.add(key);
      rows.push({
        source_table: 'submission_tasks',
        id: t.id,
        distribution_id: t.distribution_id || '',
        applywizz_id: t.applywizz_id,
        job_url: t.job_url,
        company: t.company || '',
        role_title: t.role_title || '',
        status: t.status,
        error_message: t.error_message || '',
        created_at: t.created_at,
      });
    }
  }

  for (const f of failedJobs) {
    const key = `${f.applywizz_id}_${f.job_url}`;
    if (!seen.has(key)) {
      seen.add(key);
      rows.push({
        source_table: 'failed_jobs',
        id: f.id,
        distribution_id: '',
        applywizz_id: f.applywizz_id,
        job_url: f.job_url,
        company: f.company || '',
        role_title: f.role_title || '',
        status: 'failed',
        error_message: f.failure_reason || '',
        created_at: f.created_at,
      });
    }
  }

  console.log(`\n📊 Total unique applications found: ${rows.length}`);

  // Generate CSV
  const csvHeaders = ['source_table', 'id', 'distribution_id', 'applywizz_id', 'company', 'role_title', 'status', 'error_message', 'created_at', 'job_url'];
  const csvLines = [csvHeaders.join(',')];

  for (const r of rows) {
    const line = csvHeaders.map(h => {
      const val = String(r[h] ?? '').replace(/"/g, '""');
      return `"${val}"`;
    }).join(',');
    csvLines.push(line);
  }

  const csvPath = path.resolve('expired_and_restarted_applications.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
  console.log(`💾 Saved CSV to: ${csvPath} (${rows.length} rows)`);

  if (rows.length > 0) {
    console.log('\nTop 5 sample applications:');
    rows.slice(0, 5).forEach((r, i) => {
      console.log(` ${i + 1}. [${r.applywizz_id}] ${r.company} - ${r.role_title}`);
      console.log(`    URL: ${r.job_url}`);
      console.log(`    Error: ${r.error_message?.slice(0, 80)}`);
    });
  }
}

fetchExpiredAndInterrupted().catch(err => {
  console.error('Error fetching expired/restarted applications:', err);
  process.exit(1);
});
