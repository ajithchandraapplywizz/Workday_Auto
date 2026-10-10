import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

async function main() {
  loadLocalEnvOnce();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const countRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?select=id&limit=1`,
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }
  });
  console.log('Total batch_job_queue count:', countRes.headers?.['content-range']);

  const qRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?select=*&limit=1`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!qRes.ok) {
    console.error('qRes error:', qRes.status, qRes.text);
    return;
  }
  const sample = qRes.json() || [];
  console.log('batch_job_queue columns:', Object.keys(sample[0] || {}));

  const allQRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?select=id,job_url,status,company&limit=10000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const qData = allQRes.json() || [];
  const statusCounts = {};
  const errorCounts = {};
  const failedJobsByUrl = {};

  for (const r of qData) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    if (r.error_message) {
      errorCounts[r.error_message] = (errorCounts[r.error_message] || 0) + 1;
    }
    if (r.status === 'failed') {
      const u = r.job_url ? r.job_url.split('?')[0] : 'unknown';
      failedJobsByUrl[u] = (failedJobsByUrl[u] || 0) + 1;
    }
  }

  console.log('--- BATCH_JOB_QUEUE STATUS COUNTS ---');
  console.log(statusCounts);
  console.log('\n--- ERROR MESSAGES & COUNTS ---');
  console.log(errorCounts);
  console.log('\n--- FAILED JOBS GROUPED BY URL ---');
  console.log(failedJobsByUrl);

  // 2. Check scanned_jobs
  const sRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/scanned_jobs?select=*&order=created_at.desc&limit=5`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  console.log('\n--- SCANNED_JOBS ROWS (Latest 5) ---');
  console.log(JSON.stringify(sRes.json(), null, 2));

  // 3. Check failed_jobs
  const fRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/failed_jobs?select=job_url,company,failure_reason,failed_at_step&limit=2000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const fData = fRes.json() || [];
  console.log('\n--- TOTAL FAILED_JOBS COUNT ---', fData.length);
  const byReason = {};
  const byUrl = {};
  for (const r of fData) {
    byReason[r.failure_reason] = (byReason[r.failure_reason] || 0) + 1;
    const u = `${r.company} | ${r.job_url}`;
    byUrl[u] = (byUrl[u] || 0) + 1;
  }
  console.log('\n--- FAILED_JOBS BY REASON ---');
  console.log(byReason);
  console.log('\n--- FAILED_JOBS BY URL (Top 10) ---');
  console.log(Object.entries(byUrl).slice(0, 10));
}

main().catch(console.error);
