import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./backend/.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function redactEmail(em) {
  if (!em) return 'null';
  const parts = String(em).split('@');
  if (parts.length < 2) return '***';
  const user = parts[0];
  const domain = parts[1];
  const redUser = user.length > 2 ? user.slice(0, 2) + '***' : user[0] + '***';
  return `${redUser}@${domain}`;
}

async function runStep0() {
  console.log('================================================================');
  console.log('             STEP 0: READ-ONLY SYSTEMATIC AUDIT                 ');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Part (a): Answer sources all-time
  // -------------------------------------------------------------------------
  console.log('--- STEP 0.a: Answer Sources All-Time ---');
  const { data: jdRows } = await supabase
    .from('job_distributions')
    .select('id, resolved_answers')
    .not('resolved_answers', 'is', null);

  console.log(`Loaded ${jdRows.length} job_distributions with non-null resolved_answers.`);

  let totalAnswered = 0;
  let supabaseCount = 0;
  let resumeCount = 0;
  let apiCount = 0;
  let aiCount = 0;
  let otherCount = 0;

  const rawSourceMap = new Map();
  const sourceLabelMap = new Map();
  const tierMap = new Map();

  for (const row of jdRows) {
    const list = Array.isArray(row.resolved_answers)
      ? row.resolved_answers
      : (typeof row.resolved_answers === 'string' ? JSON.parse(row.resolved_answers) : []);

    for (const a of list) {
      if (!a || a.is_answered !== true) continue;
      totalAnswered++;

      const raw = String(a.raw_source || '').toLowerCase().trim();
      const tier = Number(a.tier);
      const label = String(a.source || '').toLowerCase().trim();

      rawSourceMap.set(raw, (rawSourceMap.get(raw) || 0) + 1);
      sourceLabelMap.set(label, (sourceLabelMap.get(label) || 0) + 1);
      tierMap.set(tier, (tierMap.get(tier) || 0) + 1);

      if (raw === 'supabase' || tier === 1 || label.includes('supabase') || label.includes('db')) {
        supabaseCount++;
      } else if (raw === 'resume' || tier === 2 || label.includes('resume')) {
        resumeCount++;
      } else if (raw === 'api' || raw === 'crm' || tier === 3 || label.includes('crm') || label.includes('api')) {
        apiCount++;
      } else if (raw === 'ai' || raw === 'llm' || tier === 4 || label.includes('ai') || label.includes('claude') || label.includes('llm')) {
        aiCount++;
      } else {
        otherCount++;
      }
    }
  }

  console.log(`Total answered questions: ${totalAnswered}`);
  console.log(`  Supabase: ${supabaseCount} (${Math.round((supabaseCount/totalAnswered)*100)}%)`);
  console.log(`  Resume:   ${resumeCount} (${Math.round((resumeCount/totalAnswered)*100)}%)`);
  console.log(`  API/CRM:  ${apiCount} (${Math.round((apiCount/totalAnswered)*100)}%)`);
  console.log(`  AI:       ${aiCount} (${Math.round((aiCount/totalAnswered)*100)}%)`);
  console.log(`  Other:    ${otherCount} (${Math.round((otherCount/totalAnswered)*100)}%)`);

  console.log('\nBreakdown of raw_source values:');
  for (const [k, v] of rawSourceMap.entries()) {
    console.log(`  raw_source: "${k}" -> count: ${v}`);
  }

  console.log('\nBreakdown of source label values:');
  for (const [k, v] of sourceLabelMap.entries()) {
    console.log(`  source: "${k}" -> count: ${v}`);
  }

  console.log('\nBreakdown of tier values:');
  for (const [k, v] of tierMap.entries()) {
    console.log(`  tier: ${k} -> count: ${v}`);
  }

  console.log('\nEarlier verified figures comparison:');
  console.log('  Earlier: Total: 4212 | Supabase: 3422 | Resume: 360 | API: 247 | AI: 183');
  console.log(`  Current: Total: ${totalAnswered} | Supabase: ${supabaseCount} | Resume: ${resumeCount} | API: ${apiCount} | AI: ${aiCount} | Other: ${otherCount}`);
  console.log(`  Difference: Total: ${totalAnswered - 4212} | Supabase: ${supabaseCount - 3422} | Resume: ${resumeCount - 360} | API: ${apiCount - 247} | AI: ${aiCount - 183}`);

  // -------------------------------------------------------------------------
  // Part (b): Manager identity mapping for real accounts
  // -------------------------------------------------------------------------
  console.log('\n--- STEP 0.b: Manager Identity for Real Accounts ---');
  const { data: realManagerAU } = await supabase
    .from('auth_users')
    .select('id, email, name, role, manager_id, status')
    .eq('role', 'manager');

  console.log('Real auth_users rows for managers:', realManagerAU.map(u => ({
    id: u.id,
    email: redactEmail(u.email),
    role: u.role,
    manager_id: u.manager_id,
    status: u.status,
  })));

  const { data: managersTable } = await supabase
    .from('managers')
    .select('id, name, email');
  console.log('managers table rows:', managersTable.map(m => ({
    id: m.id,
    name: m.name,
    email: redactEmail(m.email)
  })));

  // Test resolution function for real accounts
  const { resolveManagerIdFromToken } = await import('../lib/dashboardStats.mjs');
  for (const u of realManagerAU) {
    const resolvedId = await resolveManagerIdFromToken({ email: u.email, role: u.role });
    console.log(`Resolving for ${redactEmail(u.email)} (role: ${u.role}): resolved manager_id = ${resolvedId}`);
    
    // Check how many operators / CAs map to this manager_id
    const { data: ops } = await supabase
      .from('operators')
      .select('id, name, email, manager_id, count_in_dashboard')
      .eq('manager_id', resolvedId);
    console.log(`  -> Maps to ${ops.length} operators in operators table (active CAs with count_in_dashboard=true: ${ops.filter(o => o.count_in_dashboard).length})`);
  }

  // -------------------------------------------------------------------------
  // Part (c): The 45 unattributed applications
  // -------------------------------------------------------------------------
  console.log('\n--- STEP 0.c: The 45 Unattributed Applications ---');
  const { data: allJd } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, company, role_title, status, created_at, updated_at');

  const { data: allClients } = await supabase
    .from('clients')
    .select('id, applywizz_id, client_name, company_email, ca_email, current_ca_email, career_associate_manager_id, current_manager_id, created_at, assigned_at');

  const clientMap = new Map();
  allClients.forEach(c => clientMap.set(c.applywizz_id, c));

  const { data: allOps } = await supabase
    .from('operators')
    .select('id, email, manager_id');
  const opMap = new Map();
  allOps.forEach(o => opMap.set(String(o.email).toLowerCase().trim(), o));

  const unattributedJds = [];
  for (const j of allJd) {
    const client = clientMap.get(j.applywizz_id);
    const caEmail = (client?.current_ca_email || client?.ca_email || '').toLowerCase().trim();
    const op = caEmail ? opMap.get(caEmail) : null;
    const mId = op?.manager_id;
    if (!mId) {
      unattributedJds.push({ jd: j, client, caEmail, op });
    }
  }

  console.log(`Total unattributed applications found: ${unattributedJds.length}`);

  // Check assignment log for these clients
  const sample5 = unattributedJds.slice(0, 5);
  console.log('\n5 Samples of Unattributed Applications:');
  for (const s of sample5) {
    const awlId = s.jd.applywizz_id;
    const cl = s.client;

    // Check client_assignment_log for this client
    const { data: calRows } = await supabase
      .from('client_assignment_log')
      .select('*')
      .eq('applywizz_id', awlId);

    console.log(`Sample: JD #${s.jd.id}`);
    console.log(`  applywizz_id: ${awlId}`);
    console.log(`  company: ${s.jd.company} | status: ${s.jd.status}`);
    console.log(`  Client Record in clients table:`, cl ? {
      id: cl.id,
      applywizz_id: cl.applywizz_id,
      company_email: redactEmail(cl.company_email),
      ca_email: cl.ca_email,
      current_ca_email: cl.current_ca_email,
      current_manager_id: cl.current_manager_id,
      career_associate_manager_id: cl.career_associate_manager_id,
      assigned_at: cl.assigned_at,
    } : 'NOT FOUND IN clients TABLE');
    console.log(`  client_assignment_log entries count: ${calRows?.length || 0}`);
    if (calRows && calRows.length > 0) {
      console.log(`  client_assignment_log sample:`, calRows.map(r => ({
        id: r.id,
        operator_email: redactEmail(r.operator_email || r.ca_email),
        action: r.action,
        created_at: r.created_at,
      })));
    }
  }

  // Summary of all 45 unattributed clients
  const uniqueUnattrClients = [...new Set(unattributedJds.map(u => u.jd.applywizz_id))];
  console.log(`\nUnique clients among the 45 unattributed applications: ${uniqueUnattrClients.length}`);
  
  let withClientRow = 0;
  let withoutClientRow = 0;
  let withAnyCaEmailInClient = 0;
  let withAnyCalRows = 0;

  for (const awlId of uniqueUnattrClients) {
    const cl = clientMap.get(awlId);
    if (cl) {
      withClientRow++;
      if (cl.current_ca_email || cl.ca_email) withAnyCaEmailInClient++;
    } else {
      withoutClientRow++;
    }
    const { count } = await supabase
      .from('client_assignment_log')
      .select('*', { count: 'exact', head: true })
      .eq('applywizz_id', awlId);
    if (count > 0) withAnyCalRows++;
  }

  console.log(`  Clients with record in 'clients' table: ${withClientRow}/${uniqueUnattrClients.length}`);
  console.log(`  Clients without record in 'clients' table: ${withoutClientRow}/${uniqueUnattrClients.length}`);
  console.log(`  Clients with non-null ca_email or current_ca_email: ${withAnyCaEmailInClient}/${uniqueUnattrClients.length}`);
  console.log(`  Clients with history in 'client_assignment_log': ${withAnyCalRows}/${uniqueUnattrClients.length}`);
}

runStep0().catch(console.error);
