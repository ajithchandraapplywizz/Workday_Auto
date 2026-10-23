import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('Testing/Creating submission_tasks table...');
  // Check if table exists by selecting 1 row
  const { data, error } = await supabase.from('submission_tasks').select('id').limit(1);
  if (!error) {
    console.log('✅ submission_tasks table already exists and is queryable!');
    return;
  }
  console.log('Error querying submission_tasks:', error.message);
}

run();
