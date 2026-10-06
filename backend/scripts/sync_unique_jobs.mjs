import fs from 'fs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const raw = fs.readFileSync('data/workday jobs(Sheet1).csv', 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);

function cleanJobUrl(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return u.split('?')[0].replace(/\/+$/, '');
  }
}

function parseCompany(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host.split('.')[0] || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function parseRole(u) {
  try {
    const path = new URL(u).pathname;
    const segs = path.split('/').filter(Boolean);
    const lastSeg = segs[segs.length - 1] || '';
    return decodeURIComponent(lastSeg).replace(/_/g, ' ').replace(/-/g, ' ');
  } catch {
    return 'Unknown Role';
  }
}

function extractJobId(u) {
  try {
    const match = u.match(/([A-Z0-9]+(?:[-_][A-Z0-9]+)+)$/i) || u.match(/(JR\d+|REQ[-_]?\d+|JOBREQ[-_]?\d+|R[-_]?\d+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const uniqueJobs = new Map();
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  const commaIdx = line.indexOf(',');
  if (commaIdx === -1) continue;
  const rawUrl = line.slice(0, commaIdx).trim();
  const cleanUrl = cleanJobUrl(rawUrl);
  if (!uniqueJobs.has(cleanUrl)) {
    uniqueJobs.set(cleanUrl, {
      job_url: cleanUrl,
      company: parseCompany(cleanUrl),
      role_title: parseRole(cleanUrl),
      job_id: extractJobId(cleanUrl),
      scan_status: 'completed',
      scraped_questions: [],
      question_count: 0,
      step_names: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

console.log(`Found ${uniqueJobs.size} unique jobs in sheet.`);

// Upsert all into scanned_jobs
const jobRows = [...uniqueJobs.values()];
let inserted = 0;
for (let i = 0; i < jobRows.length; i += 50) {
  const chunk = jobRows.slice(i, i + 50);
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/scanned_jobs?on_conflict=job_url`,
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: chunk,
  });
  if (res.ok) {
    inserted += (res.data || []).length;
  }
}

console.log(`All ${uniqueJobs.size} unique jobs synced to scanned_jobs!`);

// Fetch all from scanned_jobs to verify unique UUIDs
const fetchRes = await httpsJsonWithRetry({
  url: `${url}/rest/v1/scanned_jobs?select=id,job_id,company,role_title,job_url&limit=1000`,
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
const allScanned = await fetchRes.json();
console.log(`Verified: Total unique jobs in scanned_jobs table: ${allScanned.length}`);
console.log('Sample Unique Jobs:');
for (const sj of allScanned.slice(0, 3)) {
  console.log(`  🔑 [ID: ${sj.id}] [JobReq: ${sj.job_id || 'N/A'}] ${sj.company} -> ${sj.role_title}`);
}
