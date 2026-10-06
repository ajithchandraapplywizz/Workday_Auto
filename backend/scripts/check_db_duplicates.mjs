import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let allRows = [];
let offset = 0;
const limit = 1000;

while (true) {
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/batch_job_queue?select=id,applywizz_id,job_url&offset=${offset}&limit=${limit}`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) break;
  allRows.push(...data);
  if (data.length < limit) break;
  offset += limit;
}

console.log('Total rows currently in batch_job_queue:', allRows.length);

function canonicalUrl(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return u.split('?')[0].replace(/\/+$/, '').toLowerCase();
  }
}

const pairMap = new Map();
const duplicateIds = [];

for (const r of allRows) {
  const keyStr = `${r.applywizz_id.trim().toUpperCase()}::${canonicalUrl(r.job_url)}`;
  if (pairMap.has(keyStr)) {
    duplicateIds.push({ id: r.id, applywizz_id: r.applywizz_id, url: r.job_url });
  } else {
    pairMap.set(keyStr, r.id);
  }
}

console.log('Unique candidate-job pairs:', pairMap.size);
console.log('Duplicate task rows found:', duplicateIds.length);
if (duplicateIds.length > 0) {
  console.log('Sample duplicates:', duplicateIds.slice(0, 5));
}
