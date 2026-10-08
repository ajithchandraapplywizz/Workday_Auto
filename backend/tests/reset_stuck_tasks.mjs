import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function run() {
  console.log('--- RESETTING STUCK QUEUE TASKS ---');
  // 1. Reset any 'processing' tasks back to 'pending'
  const patchRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?status=eq.processing`,
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      status: 'pending',
      worker_id: null,
      locked_at: null,
      updated_at: new Date().toISOString()
    })
  });

  console.log(`PATCH response: status=${patchRes.status}, ok=${patchRes.ok}, text=${patchRes.text?.slice(0, 100)}`);
  const resetCount = (patchRes.json() || []).length;
  console.log(`✅ Reset ${resetCount} stuck 'processing' tasks back to 'pending'.`);

  // 2. Count current queue by status
  const allRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?select=status&limit=10000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const counts = {};
  for (const r of allRes.json() || []) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  console.log('Current batch_job_queue counts:', counts);
}

run();
