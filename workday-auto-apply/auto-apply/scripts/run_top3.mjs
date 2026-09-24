import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { runWorkerPool } from '../lib/workerPool.mjs';

loadLocalEnvOnce();

const rawJobUrl = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '';
const jobUrl = String(rawJobUrl).replace(/\s+/g, '').trim();
const dryRun = process.argv.includes('--dry-run');
const confirmSubmit = process.argv.includes('--confirm-submit');

if (!jobUrl) {
  console.log(`
Usage:
  node scripts/run_top3.mjs "<WORKDAY_JOB_URL>" [--dry-run] [--confirm-submit]

Example:
  node scripts/run_top3.mjs "https://company.wd3.myworkdayjobs.com/Careers/job/Engineer_JR123" --dry-run
`);
  process.exit(1);
}

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!url || !key) {
  console.error('❌ Supabase not configured in .env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)');
  process.exit(1);
}

console.log('🔍 Fetching first 3 clients from Supabase `clients` table...');

const res = await fetch(`${url}/rest/v1/clients?select=applywizz_id,client_name,company_email&limit=3`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
});

if (!res.ok) {
  console.error(`❌ Failed to fetch clients from Supabase: ${res.statusText}`);
  process.exit(1);
}

const clients = await res.json();
if (!clients.length) {
  console.error('❌ No clients found in Supabase `clients` table.');
  process.exit(1);
}

console.log(`\n📋 Target Job URL: ${jobUrl}`);
console.log('👥 First 3 Clients to process concurrently:');
clients.forEach((c, idx) => {
  console.log(`   [Worker-${idx + 1}] ${c.applywizz_id} — ${c.client_name} (${c.company_email})`);
});
console.log('');

const tasks = clients.map((c) => ({
  applywizzId: c.applywizz_id,
  applywizz_id: c.applywizz_id,
  jobUrl: jobUrl,
  job_url: jobUrl,
  company: '',
  role: '',
}));

await runWorkerPool(tasks, {
  concurrency: 3,
  headless: process.argv.includes('--headless') || process.env.HEADLESS === 'true',
  confirmSubmit,
  dryRun,
  defaultPassword: process.env.WORKDAY_PASSWORD || '',
});
