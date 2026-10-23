import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('Querying job_distributions for fully_answered_count...');
  const { data, error } = await supabase
    .from('job_distributions')
    .select('applywizz_id, is_fully_answered');

  if (error) {
    console.error('Error fetching job_distributions:', error);
    process.exit(1);
  }

  const counts = new Map();
  for (const row of data || []) {
    const id = (row.applywizz_id || '').trim().toUpperCase();
    if (!id) continue;
    if (row.is_fully_answered === true) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }

  console.log(`Successfully aggregated counts for ${counts.size} candidates from ${data.length} total job rows:`);
  console.log(Object.fromEntries(counts));
}

run();
