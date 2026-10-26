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
  console.log(`Checking current status of tasks in CSV...`);
  const taskIds = rows.filter(r => r.source === 'submission_tasks').map(r => r.id);
  const distIds = rows.map(r => r.distId).filter(Boolean);

  const { data: subTasks } = await supabase
    .from('submission_tasks')
    .select('id, status, error_message, applywizz_id, company, role_title, job_url, distribution_id')
    .in('id', taskIds);

  const statusMap = new Map();
  for (const st of subTasks || []) {
    statusMap.set(st.id, st);
  }

  // Filter tasks that are not yet 'submitted' or 'already_applied'
  const pending = [];
  for (const r of rows) {
    const live = statusMap.get(r.id);
    const liveStatus = live?.status || r.status;
    if (liveStatus !== 'submitted' && liveStatus !== 'already_applied') {
      pending.push({
        ...r,
        liveStatus,
      });
    }
  }

  console.log(`Total rows in CSV: ${rows.length}`);
  console.log(`Pending / eligible to apply: ${pending.length}`);
  console.log(`First 12 pending tasks:`);
  for (let i = 0; i < Math.min(12, pending.length); i++) {
    const p = pending[i];
    console.log(`${i+1}. [${p.source}] id: ${p.id} | ${p.awlId} @ ${p.company} | ${p.role} | status: ${p.liveStatus} | URL: ${p.url}`);
  }
}

main().catch(console.error);
