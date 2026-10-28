import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./backend/.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: jd, count: jdCount } = await supabase.from('job_distributions').select('*', { count: 'exact' });
  const { data: st, count: stCount } = await supabase.from('submission_tasks').select('*', { count: 'exact' });

  console.log('JD total count:', jdCount, 'ST total count:', stCount);

  // Group JD by status
  const jdStatus = {};
  jd.forEach(r => { jdStatus[r.status] = (jdStatus[r.status] || 0) + 1; });
  console.log('JD status counts:', jdStatus);

  // Group ST by status
  const stStatus = {};
  st.forEach(r => { stStatus[r.status] = (stStatus[r.status] || 0) + 1; });
  console.log('ST status counts:', stStatus);

  // Join on distribution_id
  const stByDist = new Map();
  st.forEach(r => { if (r.distribution_id) stByDist.set(r.distribution_id, r); });

  const joinedStatus = {};
  jd.forEach(j => {
    const task = stByDist.get(j.id);
    const eff = task ? task.status : j.status;
    joinedStatus[eff] = (joinedStatus[eff] || 0) + 1;
  });
  console.log('Joined effective_status counts:', joinedStatus);

  // Check tasks with no matching JD
  const jdIdSet = new Set(jd.map(j => j.id));
  const orphanTasks = st.filter(t => !jdIdSet.has(t.distribution_id));
  console.log('Orphan tasks count (no JD):', orphanTasks.length);

  // Check timestamp columns in submission_tasks and job_distributions
  console.log('\nST timestamp sample for submitted:');
  console.log(st.filter(r => r.status === 'submitted').slice(0, 3).map(r => ({
    id: r.id, completed_at: r.completed_at, updated_at: r.updated_at, created_at: r.created_at, started_at: r.started_at
  })));

  console.log('\nST timestamp sample for failed:');
  console.log(st.filter(r => r.status === 'failed').slice(0, 3).map(r => ({
    id: r.id, completed_at: r.completed_at, updated_at: r.updated_at, created_at: r.created_at
  })));

  console.log('\nJD timestamp sample for submitted without task:');
  console.log(jd.filter(r => r.status === 'submitted' && !stByDist.has(r.id)).map(r => ({
    id: r.id, updated_at: r.updated_at, created_at: r.created_at
  })));

  // Investigate Manager and CA mapping
  console.log('\n=== Investigating Manager & CA mapping ===');
  const { data: managers } = await supabase.from('managers').select('*');
  console.log('Managers table:', managers);

  const { data: authUsers } = await supabase.from('auth_users').select('id, email, role, status');
  console.log('Auth users sample (managers/admins):', authUsers.filter(u => u.role !== 'ca').map(u => ({ email: u.email, role: u.role })));

  const { data: ops } = await supabase.from('operators').select('id, name, email, role, manager_id').limit(10);
  console.log('Operators sample:', ops.slice(0, 5));

  // Check how applications link to clients
  const sampleAwl = jd.slice(0, 5).map(j => j.applywizz_id);
  const { data: clientsSample } = await supabase.from('clients').select('applywizz_id, ca_email, current_ca_email').in('applywizz_id', sampleAwl);
  console.log('Clients matching sample JD applywizz_ids:', clientsSample);

  // Check client_assignment_log
  const { data: calSample } = await supabase.from('client_assignment_log').select('*').limit(5);
  console.log('client_assignment_log sample:', calSample);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
