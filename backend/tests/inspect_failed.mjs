import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function check() {
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/failed_jobs?failure_reason=ilike.*human-required*&limit=2`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  console.log('human-required row:', JSON.stringify(res.json(), null, 2));
}

check();
