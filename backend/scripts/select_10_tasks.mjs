import fs from 'fs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const content = fs.readFileSync('expired_and_restarted_applications.csv', 'utf8');
const lines = content.trim().split('\n').slice(1);
const rows = lines.map(l => {
  const parts = l.split('","').map(p => p.replace(/^"|"$/g, ''));
  return {
    source: parts[0],
    id: parts[1],
    distId: parts[2],
    awlId: parts[3],
    company: parts[4],
    role: parts[5],
    status: parts[6],
    error: parts[7],
    url: parts[9]
  };
});

async function main() {
  const { data: subTasks } = await supabase
    .from('submission_tasks')
    .select('id, status, error_message, applywizz_id, company, role_title, job_url, distribution_id')
    .in('id', rows.map(r => r.id));

  const statusMap = new Map();
  for (const st of subTasks || []) {
    statusMap.set(st.id, st);
  }

  // Filter tasks that are not yet submitted
  const pending = [];
  for (const r of rows) {
    const live = statusMap.get(r.id);
    const liveStatus = live?.status || r.status;
    if (liveStatus !== 'submitted' && liveStatus !== 'already_applied') {
      pending.push({
        ...r,
        liveStatus,
        taskId: r.id,
        distributionId: r.distId,
      });
    }
  }

  console.log(`Eligible pending tasks in CSV: ${pending.length}`);

  // Let's take the first 10 pending tasks
  const batch10 = pending.slice(0, 10);
  console.log(`\nSelected 10 tasks to apply:`);
  for (let i = 0; i < batch10.length; i++) {
    const t = batch10[i];
    console.log(`${i + 1}. [${t.awlId}] ${t.company} - ${t.role} (task: ${t.taskId}, dist: ${t.distributionId})`);
  }
}

main().catch(console.error);
