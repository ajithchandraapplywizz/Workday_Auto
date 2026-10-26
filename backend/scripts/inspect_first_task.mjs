import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function getFirstWithDist() {
  const tRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/submission_tasks?or=(error_message.ilike.*lease*expired*,error_message.ilike.*daemon*restart*,error_message.ilike.*interrupted*)&limit=1&select=*`,
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const t = tRes.json()[0];
  console.log('Sample Task:', {
    id: t.id,
    distribution_id: t.distribution_id,
    applywizz_id: t.applywizz_id,
    company: t.company,
    role_title: t.role_title,
    job_url: t.job_url,
    status: t.status,
    error_message: t.error_message
  });

  if (t?.distribution_id) {
    const dRes = await httpsJsonWithRetry({
      url: `${url}/rest/v1/job_distributions?id=eq.${t.distribution_id}&select=*`,
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const dist = dRes.json()[0];
    console.log('\nDistribution Info:');
    console.log(' - ID:', dist?.id);
    console.log(' - Company:', dist?.company);
    console.log(' - Status:', dist?.status);
    console.log(' - Resolved answers count:', dist?.resolved_answers?.length);
    console.log(' - Sample resolved answers:\n', JSON.stringify(dist?.resolved_answers?.slice(0, 8), null, 2));
  }
}

getFirstWithDist().catch(console.error);
