import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = {};
fs.readFileSync('./backend/.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: jobDists } = await supabase.from('job_distributions').select('*');
  const { data: subTasks } = await supabase.from('submission_tasks').select('*');
  const { data: clients } = await supabase.from('clients').select('applywizz_id, current_ca_email, ca_email');
  const { data: ops } = await supabase.from('operators').select('id, name, email, manager_id');

  const taskMap = new Map();
  subTasks.forEach(t => { if (t.distribution_id) taskMap.set(t.distribution_id, t); });

  const clientMap = new Map();
  clients.forEach(c => { if (c.applywizz_id) clientMap.set(c.applywizz_id, c); });

  const opMap = new Map();
  ops.forEach(o => { if (o.email) opMap.set(String(o.email).toLowerCase().trim(), o); });

  const balajiManagerId = '9dc9376e-fbc5-440b-932f-38da10b89a70';
  const rkManagerId = 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744';

  let bSub = 0, bFail = 0;
  let rkSub = 0, rkFail = 0;
  let unSub = 0, unFail = 0;

  const rows = [];

  for (const jd of jobDists) {
    const task = taskMap.get(jd.id);
    const effStatus = (task ? task.status : jd.status) || 'unknown';
    if (effStatus !== 'submitted' && effStatus !== 'failed') continue;

    const client = clientMap.get(jd.applywizz_id);
    const caEmail = (client?.current_ca_email || client?.ca_email || '').toLowerCase().trim();
    const op = caEmail ? opMap.get(caEmail) : null;
    const mgrId = op?.manager_id || null;

    if (mgrId === balajiManagerId) {
      if (effStatus === 'submitted') bSub++; else bFail++;
    } else if (mgrId === rkManagerId) {
      if (effStatus === 'submitted') rkSub++; else rkFail++;
    } else {
      if (effStatus === 'submitted') unSub++; else unFail++;
    }

    rows.push({
      status: effStatus,
      applywizz_id: jd.applywizz_id,
      company: jd.company,
      ca: op?.name || caEmail || 'UNASSIGNED',
      manager: mgrId === balajiManagerId ? 'Balaji' : (mgrId === rkManagerId ? 'Ramakrishna' : 'Unassigned'),
      time: task?.completed_at || task?.updated_at || jd.updated_at
    });
  }

  console.log('--- SUBMITTED BREAKDOWN ---');
  console.log(`Balaji: ${bSub} | Ramakrishna: ${rkSub} | Unassigned: ${unSub} | Total: ${bSub + rkSub + unSub}`);

  console.log('--- FAILED BREAKDOWN ---');
  console.log(`Balaji: ${bFail} | Ramakrishna: ${rkFail} | Unassigned: ${unFail} | Total: ${bFail + rkFail + unFail}`);

  console.log('\n--- ALL 19 ROWS ---');
  rows.forEach((r, i) => {
    console.log(`${i+1}. [${r.status.toUpperCase()}] ${r.applywizz_id} | ${r.company} | Mgr: ${r.manager} | CA: ${r.ca} | Time: ${r.time}`);
  });
}

run().catch(console.error);
