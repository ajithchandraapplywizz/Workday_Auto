/**
 * upload_workday_jobs_20261028.mjs
 *
 * Ingests the first 63 unique Workday jobs from:
 * "Data/workday_jobs_202610281746.csv" into Supabase `public.batch_job_queue`.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase credentials missing from .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const __dirname = dirname(fileURLToPath(import.meta.url));

const possiblePaths = [
  resolve(process.cwd(), 'Data', 'workday_jobs_202610281746.csv'),
  resolve(process.cwd(), '..', 'Data', 'workday_jobs_202610281746.csv'),
  resolve(__dirname, '..', '..', 'Data', 'workday_jobs_202610281746.csv'),
];
const targetCsvPath = possiblePaths.find((p) => existsSync(p));
if (!targetCsvPath) {
  console.error(`❌ CSV not found at: ${possiblePaths.join(' | ')}`);
  process.exit(1);
}

function parseCSVLine(line = '') {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function extractCleanWorkdayUrl(rawUrl = '') {
  let u = String(rawUrl || '').trim();
  if (!u) return '';

  // Extract nested workday url if wrapped in doubleclick, recruitics, etc.
  const innerWorkday = u.match(/https?:\/\/[a-zA-Z0-9_.-]+\.myworkdayjobs\.com[^\s"']*/i);
  if (innerWorkday) {
    u = innerWorkday[0];
  } else if (u.includes('rx_url=')) {
    try {
      const parsed = new URL(u);
      const target = parsed.searchParams.get('rx_url');
      if (target) {
        u = decodeURIComponent(target);
      }
    } catch {}
  }

  return u;
}

function parseRole(u) {
  try {
    const parsed = new URL(u);
    const pathname = parsed.pathname;
    const segments = pathname.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';
    const clean = decodeURIComponent(lastSeg)
      .replace(/_[A-Z0-9-]+$/i, '')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean || 'Workday Position';
  } catch {
    return 'Workday Position';
  }
}

async function run() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🚀 WORKDAY JOBS INGESTION TO SUPABASE (public.batch_job_queue)`);
  console.log(`   Source CSV:    ${targetCsvPath}`);
  console.log(`   Target Count:  First 63 Unique Jobs (Task Count >= 20 / Top Ranked)`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const raw = readFileSync(targetCsvPath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  console.log(`📄 Total lines in CSV: ${lines.length}`);
  const headerParts = parseCSVLine(lines[0]);
  console.log(`📋 Header: ${JSON.stringify(headerParts)}`);

  let jobIdIdx = 1;
  let companyIdx = 2;
  let jobUrlIdx = 3;
  let taskCountIdx = 4;
  let awlIdsIdx = 5;

  for (let i = 0; i < headerParts.length; i++) {
    const h = headerParts[i].toLowerCase().trim();
    if (h === 'job_id') jobIdIdx = i;
    else if (h === 'company_name' || h === 'company') companyIdx = i;
    else if (h === 'job_url' || h === 'url') jobUrlIdx = i;
    else if (h === 'task_count') taskCountIdx = i;
    else if (h.includes('awl')) awlIdsIdx = i;
  }

  const uniqueJobs = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length) continue;

    const rawJobUrl = parts[jobUrlIdx] || '';
    const cleanUrl = extractCleanWorkdayUrl(rawJobUrl);
    if (!cleanUrl || !cleanUrl.includes('myworkday')) continue;

    const jobId = parts[jobIdIdx] ? String(parts[jobIdIdx]).trim() : null;
    const company = parts[companyIdx] ? String(parts[companyIdx]).trim() : 'Workday Company';
    const taskCount = parseInt(parts[taskCountIdx], 10) || 0;
    const awlCol = parts[awlIdsIdx] || '';

    const awlMatches = awlCol.match(/AWL[-_]?\d+/gi) || [];
    const clientIds = Array.from(new Set(awlMatches.map((id) => id.toUpperCase().trim())));

    if (!uniqueJobs.has(cleanUrl)) {
      if (uniqueJobs.size >= 63) {
        break; // Reached exactly 63 unique jobs!
      }
      uniqueJobs.set(cleanUrl, {
        jobId,
        company,
        jobUrl: cleanUrl,
        taskCount,
        roleTitle: parseRole(cleanUrl),
        clientIds: new Set(clientIds),
      });
    } else {
      const entry = uniqueJobs.get(cleanUrl);
      for (const cid of clientIds) {
        entry.clientIds.add(cid);
      }
    }
  }

  console.log(`\n🔗 Captured ${uniqueJobs.size} unique jobs to ingest:`);
  let rank = 1;
  let totalCandidates = 0;
  for (const [url, info] of uniqueJobs.entries()) {
    totalCandidates += info.clientIds.size;
    console.log(`  ${String(rank++).padStart(2, ' ')}. [${String(info.taskCount).padStart(2, ' ')} tasks, ${String(info.clientIds.size).padStart(2, ' ')} clients] ${info.company} — "${info.roleTitle}"`);
  }

  console.log(`\n👥 Total unique candidate applications across ${uniqueJobs.size} jobs: ${totalCandidates}`);

  // Flatten into distinct batch_job_queue rows
  const taskRows = [];
  const seenPair = new Set();
  const now = new Date().toISOString();

  for (const [url, info] of uniqueJobs.entries()) {
    for (const clientId of info.clientIds) {
      const pairKey = `${clientId}::${url}`;
      if (!seenPair.has(pairKey)) {
        seenPair.add(pairKey);
        taskRows.push({
          applywizz_id: clientId,
          job_url: url,
          company: info.company,
          role_title: info.roleTitle,
          job_id: info.jobId,
          status: 'pending',
          created_at: now,
          updated_at: now,
        });
      }
    }
  }

  console.log(`\n⏳ Ingesting ${taskRows.length} tasks into public.batch_job_queue in batches of 100...\n`);

  const BATCH_SIZE = 100;
  let insertedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < taskRows.length; i += BATCH_SIZE) {
    const chunk = taskRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from('batch_job_queue')
      .upsert(chunk, {
        onConflict: 'applywizz_id,job_url',
        ignoreDuplicates: false,
      })
      .select('id');

    if (error) {
      console.error(`❌ Batch error [${i} - ${i + chunk.length}]:`, error.message);
      errorCount += chunk.length;
    } else {
      insertedCount += (data ? data.length : chunk.length);
      process.stdout.write(`⏳ Uploaded ${insertedCount} / ${taskRows.length} tasks...\r`);
    }
  }

  console.log(`\n\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🎉 INGESTION COMPLETE!`);
  console.log(`   Unique Jobs Uploaded:  ${uniqueJobs.size}`);
  console.log(`   Tasks Uploaded:        ${insertedCount} / ${taskRows.length}`);
  console.log(`   Errors Encountered:    ${errorCount}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  // Verify live status in batch_job_queue
  const { count: pendingCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  const { count: totalQueueCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true });

  console.log(`📊 LIVE Supabase batch_job_queue Status:`);
  console.log(`   Pending Tasks in Queue: ${pendingCount}`);
  console.log(`   Total Tasks in Queue:   ${totalQueueCount}\n`);
}

run().catch((err) => {
  console.error('Fatal error during upload:', err);
  process.exit(1);
});
