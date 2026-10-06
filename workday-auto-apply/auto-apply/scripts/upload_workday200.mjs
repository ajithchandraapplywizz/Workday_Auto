/**
 * upload_workday200.mjs
 * 
 * Ingests workday200.csv into Supabase.
 * Supports:
 *   1. Upload to `scanned_jobs` (Universal Job Catalog / Form Discovery)
 *      node workday-auto-apply/auto-apply/scripts/upload_workday200.mjs --target scanned_jobs
 * 
 *   2. Upload to `batch_job_queue` (Candidate Application Tasks)
 *      node workday-auto-apply/auto-apply/scripts/upload_workday200.mjs --target queue --awl AWL-1568
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

// Parse CLI flags
const args = process.argv.slice(2);
let targetArg = 'scanned_jobs';
let awlArg = 'AWL-1568';
let csvPath = 'data/workday200.csv';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target' && args[i + 1]) {
    targetArg = args[i + 1];
    i++;
  } else if (args[i] === '--awl' && args[i + 1]) {
    awlArg = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    csvPath = args[i];
  }
}

const fullCsvPath = resolve(process.cwd(), csvPath);
if (!existsSync(fullCsvPath)) {
  console.error(`❌ CSV file not found at: ${fullCsvPath}`);
  process.exit(1);
}

const raw = readFileSync(fullCsvPath, 'utf8');
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const urls = [];
for (const line of lines) {
  if (line.toLowerCase().startsWith('job_url')) continue;
  const match = line.match(/https?:\/\/[^\s"'<>]+/);
  if (match) urls.push(match[0]);
}

const uniqueUrls = [...new Set(urls)];
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`🚀 WORKDAY CSV SUPABASE UPLOADER`);
console.log(`   Source:  ${fullCsvPath}`);
console.log(`   Target:  ${targetArg === 'queue' ? 'batch_job_queue' : 'scanned_jobs'}`);
if (targetArg === 'queue') {
  console.log(`   AWL ID:  ${awlArg}`);
}
console.log(`   Jobs:    ${uniqueUrls.length} unique Workday URLs found`);
console.log(`══════════════════════════════════════════════════════════════════════\n`);

function parseCompany(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    const parts = host.split('.');
    return parts[0] || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function parseRole(u) {
  try {
    const path = new URL(u).pathname;
    const segments = path.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';
    return decodeURIComponent(lastSeg).replace(/_/g, ' ').replace(/-/g, ' ');
  } catch {
    return 'Unknown Position';
  }
}

if (targetArg === 'scanned_jobs') {
  console.log(`⏳ Uploading ${uniqueUrls.length} jobs to public.scanned_jobs...`);
  const rows = uniqueUrls.map((jobUrl) => ({
    job_url: jobUrl,
    company: parseCompany(jobUrl),
    role_title: parseRole(jobUrl),
    scan_status: 'completed',
    scraped_questions: [],
    question_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  // Chunk in batches of 50
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
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
    } else {
      console.error(`  ⚠️ Chunk ${i} error:`, res.text?.slice(0, 150));
    }
  }

  console.log(`\n✅ Ingest complete!`);
  console.log(`   Processed: ${uniqueUrls.length} URLs`);
  console.log(`   Inserted/Available in scanned_jobs table.`);
} else {
  console.log(`⏳ Uploading ${uniqueUrls.length} tasks to public.batch_job_queue for ${awlArg}...`);
  const rows = uniqueUrls.map((jobUrl) => ({
    applywizz_id: awlArg,
    job_url: jobUrl,
    company: parseCompany(jobUrl),
    role_title: parseRole(jobUrl),
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const res = await httpsJsonWithRetry({
      url: `${url}/rest/v1/batch_job_queue?on_conflict=applywizz_id,job_url`,
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
    } else {
      console.error(`  ⚠️ Chunk ${i} error:`, res.text?.slice(0, 150));
    }
  }

  console.log(`\n✅ Ingest complete!`);
  console.log(`   Processed: ${uniqueUrls.length} URLs`);
  console.log(`   Inserted into batch_job_queue for ${awlArg}.`);
}
