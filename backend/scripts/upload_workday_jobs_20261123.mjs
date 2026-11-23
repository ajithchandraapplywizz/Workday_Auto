/**
 * upload_workday_jobs_20261123.mjs
 *
 * Ingests jobs from workday-jobs-2026-11-23.csv into Supabase public.batch_job_queue.
 * - Stores all AWL IDs for each job in one cell (applywizz_id as JSON array string).
 * - Matches respective columns (job_id, company, role_title, job_url).
 * - Skips jobs that already exist in batch_job_queue (by job_url or job_id).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const fileArg = args.find((a) => !a.startsWith('--'));
const defaultCsvPath = process.env.CSV_PATH || resolve(process.cwd(), 'data', 'workday-jobs-2026-11-23.csv');
const userDownloadsPath = resolve(homedir(), 'Downloads', 'workday-jobs-2026-11-23.csv');

const csvPath = fileArg || (existsSync(userDownloadsPath) ? userDownloadsPath : defaultCsvPath);

if (!existsSync(csvPath)) {
  console.error(`❌ CSV not found at: ${csvPath}`);
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

function normalizeUrl(rawUrl = '') {
  try {
    const u = new URL(rawUrl.trim());
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

async function run() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🚀 INGESTING CSV TO BATCH JOB QUEUE`);
  console.log(`   Source:   ${csvPath}`);
  console.log(`   Mode:     ${isDryRun ? 'DRY RUN (no DB writes)' : 'LIVE INSERT'}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const rawContent = readFileSync(csvPath, 'utf8');
  // Strip UTF-8 BOM if present
  const cleanContent = rawContent.charCodeAt(0) === 0xFEFF ? rawContent.slice(1) : rawContent;
  const lines = cleanContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`📁 Loaded ${lines.length} non-empty lines from CSV.`);

  if (lines.length <= 1) {
    console.error('❌ CSV contains no data rows.');
    return;
  }

  const header = parseCSVLine(lines[0]);
  console.log(`📋 Header: ${header.join(' | ')}`);

  // Aggregate CSV rows by normalized job URL so all AWL IDs for the same link are merged into one cell
  const urlToJobMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length || parts.length < 4) continue;

    const jobId = parts[0] ? parts[0].trim() : null;
    const company = parts[1] ? parts[1].trim() : null;
    const jobTitle = parts[2] ? parts[2].trim() : null;
    const jobUrl = parts[3] ? parts[3].trim() : null;
    const taskCount = parseInt(parts[4], 10) || 0;
    const awlIdsRaw = parts[5] || '';

    if (!jobUrl) continue;

    const awlMatches = [...awlIdsRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
    const normUrl = normalizeUrl(jobUrl);

    if (!urlToJobMap.has(normUrl)) {
      urlToJobMap.set(normUrl, {
        firstLine: i + 1,
        jobId,
        company,
        jobTitle,
        jobUrl,
        normUrl,
        awlSet: new Set(awlMatches),
      });
    } else {
      const existing = urlToJobMap.get(normUrl);
      if (!existing.jobId && jobId) existing.jobId = jobId;
      if (!existing.company && company) existing.company = company;
      if (!existing.jobTitle && jobTitle) existing.jobTitle = jobTitle;
      for (const awl of awlMatches) {
        existing.awlSet.add(awl);
      }
    }
  }

  const parsedJobs = Array.from(urlToJobMap.values()).map((item) => ({
    line: item.firstLine,
    jobId: item.jobId,
    company: item.company,
    jobTitle: item.jobTitle,
    jobUrl: item.jobUrl,
    normUrl: item.normUrl,
    awlIds: Array.from(item.awlSet),
  }));

  console.log(`📊 Aggregated CSV into ${parsedJobs.length} unique job links with merged AWL IDs.`);

async function fetchBatchPageWithRetry(page, pageSize, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await supabase
        .from('batch_job_queue')
        .select('id, job_url, job_id, company, role_title, status')
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (!res.error) return res;
      console.warn(`  ⚠️ Attempt ${attempt}/${retries} fetch error: ${res.error.message}. Retrying...`);
    } catch (err) {
      console.warn(`  ⚠️ Attempt ${attempt}/${retries} exception: ${err.message}. Retrying...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { data: null, error: new Error(`Failed to fetch page ${page} after ${retries} attempts`) };
}
  // Load existing rows from batch_job_queue to check for existing entries
  console.log(`🔍 Fetching existing batch_job_queue items from Supabase...`);
  const existingRows = [];
  const PAGE_SIZE = 1000;
  let page = 0;
  while (true) {
    const { data, error } = await fetchBatchPageWithRetry(page, PAGE_SIZE);

    if (error) {
      console.error('❌ Error fetching existing batch_job_queue:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    existingRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`   Found ${existingRows.length} existing records in batch_job_queue.`);

  const existingNormalizedUrls = new Set(existingRows.map((r) => normalizeUrl(r.job_url || '')));
  const existingJobIds = new Set(existingRows.filter((r) => r.job_id).map((r) => String(r.job_id).trim()));

  // Also load scanned_jobs to link scanned_job_id if already scanned
  const { data: scannedJobsData } = await supabase
    .from('scanned_jobs')
    .select('id, job_id, job_url');

  const scannedMapByJobId = new Map();
  const scannedMapByUrl = new Map();
  if (Array.isArray(scannedJobsData)) {
    for (const sj of scannedJobsData) {
      if (sj.job_id) scannedMapByJobId.set(String(sj.job_id).trim(), sj.id);
      if (sj.job_url) scannedMapByUrl.set(normalizeUrl(sj.job_url), sj.id);
    }
  }

  // Filter out jobs that already exist
  const alreadyExistingJobs = [];
  const jobsToInsert = [];
  const seenNewUrls = new Set();

  for (const job of parsedJobs) {
    const existsByUrl = existingNormalizedUrls.has(job.normUrl);
    const existsByJobId = job.jobId && existingJobIds.has(String(job.jobId).trim());

    if (existsByUrl || existsByJobId) {
      alreadyExistingJobs.push({
        ...job,
        reason: existsByUrl ? 'Matched existing job_url' : 'Matched existing job_id',
      });
      continue;
    }

    // In case the CSV itself contains duplicate links
    if (seenNewUrls.has(job.normUrl)) {
      alreadyExistingJobs.push({
        ...job,
        reason: 'Duplicate URL within the same CSV',
      });
      continue;
    }
    seenNewUrls.add(job.normUrl);

    // Link scanned_job_id if exists
    const linkedScannedId =
      (job.jobId && scannedMapByJobId.get(String(job.jobId).trim())) ||
      scannedMapByUrl.get(job.normUrl) ||
      null;

    jobsToInsert.push({
      job_id: job.jobId,
      company: job.company,
      role_title: job.jobTitle,
      job_url: job.jobUrl,
      applywizz_id: JSON.stringify(job.awlIds),
      status: 'pending',
      attempt_count: 0,
      scanned_job_id: linkedScannedId,
      worker_id: null,
      locked_at: null,
      screenshot_path: null,
    });
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`📈 COMPARISON BREAKDOWN:`);
  console.log(`   - Total jobs in CSV:               ${parsedJobs.length}`);
  console.log(`   - Already existing (SKIPPED):       ${alreadyExistingJobs.length}`);
  console.log(`   - New qualifying jobs to INSERT:    ${jobsToInsert.length}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  if (alreadyExistingJobs.length > 0) {
    console.log(`⏭️  Sample skipped jobs (first 5):`);
    alreadyExistingJobs.slice(0, 5).forEach((j) => {
      console.log(`   - [${j.jobId || 'NO-ID'}] ${j.company} | ${j.jobTitle} (${j.reason})`);
    });
  }

  if (jobsToInsert.length === 0) {
    console.log(`\n⚠️ No new jobs to insert. All jobs from CSV already exist in batch_job_queue!`);
    return;
  }

  console.log(`\n📋 Preview of new jobs to be inserted (first 5):`);
  jobsToInsert.slice(0, 5).forEach((j, idx) => {
    const awls = JSON.parse(j.applywizz_id);
    console.log(`   ${idx + 1}. [${j.job_id}] ${j.company} - ${j.role_title}`);
    console.log(`      URL: ${j.job_url}`);
    console.log(`      AWL Count: ${awls.length} candidates (${awls.slice(0, 3).join(', ')}...)`);
  });

  if (isDryRun) {
    console.log(`\n🔒 DRY RUN complete. No records were written to Supabase.`);
    return;
  }

  // Live insertion in chunks
  const CHUNK_SIZE = 50;
  let insertedCount = 0;
  let errorCount = 0;

  console.log(`\n⏳ Inserting ${jobsToInsert.length} jobs into public.batch_job_queue (chunks of ${CHUNK_SIZE})...`);

  for (let i = 0; i < jobsToInsert.length; i += CHUNK_SIZE) {
    const chunk = jobsToInsert.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(jobsToInsert.length / CHUNK_SIZE);

    const { data, error } = await supabase
      .from('batch_job_queue')
      .insert(chunk)
      .select('id, job_id, company, role_title');

    if (error) {
      console.error(`  ❌ Chunk ${chunkNum}/${totalChunks} failed:`, error.message);
      errorCount++;
    } else {
      insertedCount += data.length;
      console.log(`  ✅ Chunk ${chunkNum}/${totalChunks} inserted (${insertedCount}/${jobsToInsert.length})`);
    }
  }

  console.log(`\n🎉 Ingestion Finished!`);
  console.log(`   Successfully inserted: ${insertedCount}`);
  console.log(`   Chunk errors:         ${errorCount}`);

  // Final count check
  const { count: finalCount } = await supabase
    .from('batch_job_queue')
    .select('*', { count: 'exact', head: true });

  console.log(`\n📊 Total rows now in batch_job_queue: ${finalCount}`);
}

run().catch((err) => {
  console.error('Fatal error during execution:', err);
  process.exit(1);
});
