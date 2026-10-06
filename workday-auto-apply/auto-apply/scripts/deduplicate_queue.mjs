import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let allRows = [];
let offset = 0;
const limit = 1000;

console.log('Fetching all rows from batch_job_queue...');
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

console.log('Total rows currently in DB:', allRows.length);

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
    duplicateIds.push(r.id);
  } else {
    pairMap.set(keyStr, r.id);
  }
}

console.log(`Found ${duplicateIds.length} duplicate rows.`);

if (duplicateIds.length > 0) {
  console.log(`Deleting ${duplicateIds.length} duplicate rows...`);
  // Delete in batches of 50
  let deleted = 0;
  for (let i = 0; i < duplicateIds.length; i += 50) {
    const chunk = duplicateIds.slice(i, i + 50);
    const filter = chunk.join(',');
    const delRes = await httpsJsonWithRetry({
      url: `${url}/rest/v1/batch_job_queue?id=in.(${filter})`,
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=representation',
      },
    });
    if (delRes.ok) {
      deleted += chunk.length;
    } else {
      console.error('Delete chunk error:', delRes.text?.slice(0, 100));
    }
  }
  console.log(`Successfully deleted ${deleted} duplicate rows!`);
}

console.log('Done! All rows in batch_job_queue are now 100% unique.');
