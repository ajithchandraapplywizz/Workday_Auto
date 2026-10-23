import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function verify() {
  console.log('=== PHASE 1 POST-MIGRATION VERIFICATION ===\n');

  // 1. Total rows in submission_tasks
  const { data: allTasks, error: errTasks } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, status, worker_leased_at, screenshot_path, application_submitted_screenshot_url');

  if (errTasks) {
    console.error('❌ Error querying submission_tasks:', errTasks.message);
    return;
  }

  console.log(`✅ submission_tasks total row count: ${allTasks.length}`);

  // 2. Status distribution in submission_tasks
  const statusCounts = {};
  for (const t of allTasks) {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  }
  console.log('✅ Status distribution in submission_tasks:', statusCounts);

  // 3. Proving no duplicate distribution_id
  const distSet = new Set();
  const dupes = [];
  for (const t of allTasks) {
    if (distSet.has(t.distribution_id)) {
      dupes.push(t.distribution_id);
    } else {
      distSet.add(t.distribution_id);
    }
  }

  if (dupes.length === 0) {
    console.log(`✅ Duplicate check: 0 duplicate distribution_ids across all ${allTasks.length} tasks! Unique distribution count: ${distSet.size}`);
  } else {
    console.error(`❌ Found ${dupes.length} duplicates in distribution_id:`, dupes);
  }

  // 4. Fully answered count in job_distributions
  const { count: jdFullyAnsweredCount, error: jdErr } = await supabase
    .from('job_distributions')
    .select('*', { count: 'exact', head: true })
    .eq('is_fully_answered', true);

  console.log(`✅ job_distributions (is_fully_answered = true) count: ${jdFullyAnsweredCount}`);
  console.log(`✅ Backfill parity check: ${allTasks.length === jdFullyAnsweredCount ? 'MATCH' : 'DIFFERENCE'} (${allTasks.length} in tasks vs ${jdFullyAnsweredCount} fully answered in job_distributions)`);
}

verify().catch(console.error);
