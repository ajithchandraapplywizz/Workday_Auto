import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('Querying job_distributions with status = applying...');
  const { data: jdApplying, error: jdErr } = await supabase
    .from('job_distributions')
    .select('*')
    .eq('status', 'applying');
  
  if (jdErr) {
    console.error('Error querying applying rows:', jdErr);
    return;
  }
  
  console.log(`Found ${jdApplying.length} applying rows:`);
  console.table(jdApplying.map(r => ({
    id: r.id,
    applywizz_id: r.applywizz_id,
    job_url: r.job_url?.slice(0, 40) + '...',
    status: r.status,
    worker_id: r.worker_id,
    worker_leased_at: r.worker_leased_at,
    updated_at: r.updated_at,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at
  })));
}

run().catch(console.error);
