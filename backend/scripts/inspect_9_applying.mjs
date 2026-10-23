import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function inspect9Rows() {
  const { data: rows, error } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, status, worker_id, worker_leased_at, created_at, updated_at, is_fully_answered')
    .eq('status', 'applying');

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`--- 9 APPLYING ROWS IN JOB_DISTRIBUTIONS (${rows.length} total) ---`);
  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2));
  }
}

inspect9Rows().catch(console.error);
