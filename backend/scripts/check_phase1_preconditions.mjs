import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data: allTasks, error: taskErr } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, status');
  console.log('Current submission_tasks rows:', { count: allTasks?.length, error: taskErr });

  if (allTasks && allTasks.length > 0) {
    const distMap = new Map();
    const dupes = [];
    for (const t of allTasks) {
      if (!t.distribution_id) continue;
      if (distMap.has(t.distribution_id)) {
        dupes.push({ distId: t.distribution_id, taskId1: distMap.get(t.distribution_id), taskId2: t.id });
      } else {
        distMap.set(t.distribution_id, t.id);
      }
    }
    console.log('Duplicates in submission_tasks(distribution_id):', dupes);
  } else {
    console.log('No rows in submission_tasks, 0 duplicates exist.');
  }

  // Check job_distributions fully answered count
  const { data: fullyAnswered, error: faErr } = await supabase
    .from('job_distributions')
    .select('id, status, is_fully_answered')
    .eq('is_fully_answered', true);
  console.log('job_distributions is_fully_answered = true count:', { count: fullyAnswered?.length, error: faErr });

  if (fullyAnswered) {
    const counts = {};
    for (const r of fullyAnswered) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log('Statuses among fully answered:', counts);
  }
}

check().catch(console.error);
