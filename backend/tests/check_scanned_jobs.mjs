import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();

async function run() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/scanned_jobs?select=id,company,role_title,client_count,scan_status,question_count&order=created_at.desc&limit=5`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    }
  });
  console.log('scanned_jobs rows:', await res.json());

  const dRes = await fetch(`${url}/rest/v1/job_distributions?select=id,applywizz_id,company,status,unanswered_count&order=created_at.desc&limit=5`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    }
  });
  console.log('job_distributions rows:', await dRes.json());
}
run();
