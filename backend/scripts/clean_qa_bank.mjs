import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();

const url = String(process.env.SUPABASE_URL || '').replace(/[\"']/g, '').replace(/\/+$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/[\"']/g, '');

export function isEligibleForQaBank(question = '', answer = '') {
  if (!question || answer === undefined || answer === null || String(answer).trim() === '') return false;
  const q = String(question).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3) return false;

  // 1. Reject DOM / UI artifacts
  if (
    q.includes('utilitymenubutton') ||
    q.includes('menubutton') ||
    q.includes('dropdown') ||
    q.includes('regionsubdivision') ||
    q.includes('legalname') ||
    q.includes('widget') ||
    q.includes('current value is') ||
    q.includes('terms and conditions') ||
    q.includes('click here') ||
    q.includes('select one')
  ) {
    return false;
  }

  // 2. Reject personal information
  const personalPatterns = [
    'first name', 'given name', 'last name', 'family name', 'middle name',
    'legal name', 'preferred name', 'prefix', 'suffix', 'full name',
    'local given', 'local family', 'local middle', 'local name',
    'email', 'email address', 'work email', 'personal email',
    'phone', 'phone number', 'mobile phone', 'contact phone', 'country phone code',
    'phone extension', 'phone device', 'device type',
    'address', 'address line 1', 'address line 2', 'address line 3',
    'street address', 'street', 'city', 'postal code', 'zip code', 'zip',
    'state', 'province', 'country', 'region', 'county',
    'how did you hear', 'hear about us', 'source', 'referral source'
  ];

  for (const p of personalPatterns) {
    if (q === p || q.startsWith(`${p} `) || q.endsWith(` ${p}`) || q.includes(` ${p} `)) {
      return false;
    }
  }

  // 3. Reject transient signature / date companion fields
  if (
    q.includes('signature') ||
    q.includes('todays date') ||
    q.includes('today s date') ||
    q.includes('date of application') ||
    q.includes('submission date') ||
    /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(q)
  ) {
    return false;
  }

  return true;
}

async function main() {
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/qa_bank?select=id,applywizz_id,question,question_normalized,answer&limit=1000`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });

  const rows = res.json();
  console.log(`Total rows in qa_bank: ${rows?.length || 0}`);

  if (!Array.isArray(rows) || rows.length === 0) return;

  const toDelete = [];
  const kept = [];

  for (const r of rows) {
    if (!isEligibleForQaBank(r.question, r.answer)) {
      toDelete.push(r);
    } else {
      kept.push(r);
    }
  }

  console.log(`Unnecessary / repeated / personal info rows to purge: ${toDelete.length}`);
  console.log(`Valid unique unresolved custom questions to keep: ${kept.length}`);

  if (toDelete.length > 0) {
    console.log(`\nSample purged questions:`);
    for (const d of toDelete.slice(0, 15)) {
      console.log(`  - [${d.applywizz_id}] ${d.question} -> ${d.answer}`);
    }

    // Delete in chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const ids = toDelete.slice(i, i + CHUNK).map((r) => r.id).join(',');
      await httpsJsonWithRetry({
        url: `${url}/rest/v1/qa_bank?id=in.(${ids})`,
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    }
    console.log(`\n✅ Successfully purged ${toDelete.length} unnecessary/repeated rows from qa_bank!`);
  }
}

main().catch(console.error);
