import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { readFileSync } from 'fs';

let supabaseUrl = '';
let supabaseKey = '';

try {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) {
      if (m[1] === 'SUPABASE_URL') supabaseUrl = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
      if (m[1] === 'SUPABASE_SERVICE_ROLE_KEY') supabaseKey = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
    }
  }
} catch {}

async function check() {
  const res = await httpsJsonWithRetry({
    url: `${supabaseUrl}/rest/v1/batch_job_queue?job_url=like.*Centric*&select=id,applywizz_id,company,status,pre_resolved_answers&limit=5`,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    }
  });

  if (res.ok && Array.isArray(res.json)) {
    console.log(`Found ${res.json.length} queue rows:`);
    for (const r of res.json) {
      const answers = r.pre_resolved_answers ? Object.keys(r.pre_resolved_answers).length : 0;
      console.log(`  Client: ${r.applywizz_id} | Status: ${r.status} | Pre-resolved fields: ${answers}`);
      if (answers > 0) {
        console.log('    Sample pre-resolved:', Object.entries(r.pre_resolved_answers).slice(0, 5));
      }
    }
  }
}

check().catch(console.error);
