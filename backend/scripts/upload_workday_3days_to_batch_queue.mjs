/**
 * upload_workday_3days_to_batch_queue.mjs
 *
 * Ingests jobs from workday_New_jobs_tasks_in_3_days_202610121601.csv with task_count >= 10
 * directly into Supabase public.batch_job_queue.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const args = process.argv.slice(2);
let minTaskCount = 20;
const minIdx = args.indexOf('--min-count');
if (minIdx !== -1 && args[minIdx + 1]) {
  minTaskCount = parseInt(args[minIdx + 1], 10) || 20;
} else if (args[0] && !isNaN(parseInt(args[0], 10))) {
  minTaskCount = parseInt(args[0], 10);
}

const fileArg = args.find((a) => !a.startsWith('--') && isNaN(parseInt(a, 10)));
const defaultCsvPath = "C:\\Users\\ajith\\OneDrive\\Desktop\\New_Auto_Workday\\data\\workday_New_jobs_tasks_in_3_days_202610121601.csv";
const csvPath = resolve(fileArg || defaultCsvPath);

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
    return clean || 'Unknown Position';
  } catch {
    return 'Unknown Position';
  }
}

async function run() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🚀 INGESTING CSV TO SUPABASE (public.batch_job_queue)`);
  console.log(`   Source:     ${csvPath}`);
  console.log(`   Condition:  task_count >= ${minTaskCount}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`📁 Loaded ${lines.length} lines from CSV.`);

  // Load any existing scanned_jobs to link scanned_job_id if available
  const { data: scannedJobsData } = await supabase
    .from('scanned_jobs')
    .select('id,job_id,job_url');
  
  const scannedJobMapByJobId = new Map();
  const scannedJobMapByUrl = new Map();
  if (Array.isArray(scannedJobsData)) {
    for (const sj of scannedJobsData) {
      if (sj.job_id) scannedJobMapByJobId.set(String(sj.job_id).trim(), sj.id);
      if (sj.job_url) scannedJobMapByUrl.set(String(sj.job_url).trim(), sj.id);
    }
  }

  let qualifyingJobCount = 0;
  let skippedJobCount = 0;
  const tasks = [];
  const seenKey = new Set();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length || parts.length < 5) continue;

    // Header: ,job_id,company_name,job_url,task_count,AWL IDs
    const jobId = parts[1] ? parts[1].trim() : null;
    const companyName = parts[2] ? parts[2].trim() : '';
    const jobUrl = parts[3] ? parts[3].trim() : '';
    const taskCount = parseInt(parts[4], 10) || 0;
    const awlIdsRaw = parts[5] || '';

    if (taskCount >= minTaskCount) {
      qualifyingJobCount++;
      const awlMatches = [...awlIdsRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
      const uniqueAwlForJob = [...new Set(awlMatches)];
      const derivedRole = parseRole(jobUrl);

      // Check for matching scanned_job_id
      const linkedScannedId = (jobId && scannedJobMapByJobId.get(jobId)) || scannedJobMapByUrl.get(jobUrl) || null;

      for (const awlId of uniqueAwlForJob) {
        const key = `${awlId}::${jobUrl}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          tasks.push({
            applywizz_id: awlId,
            job_url: jobUrl,
            company: companyName || null,
            role_title: derivedRole || null,
            status: 'pending',
            worker_id: null,
            locked_at: null,
            screenshot_path: null,
            scanned_job_id: linkedScannedId,
            job_id: jobId || null,
          });
        }
      }
    } else {
      skippedJobCount++;
    }
  }

  console.log(`📊 Analysis Summary:`);
  console.log(`   - Qualifying Job postings (task_count >= ${minTaskCount}): ${qualifyingJobCount}`);
  console.log(`   - Skipped Job postings (task_count < ${minTaskCount}):     ${skippedJobCount}`);
  console.log(`   - Total Unique Application Tasks to Upload:  ${tasks.length}\n`);

  if (!tasks.length) {
    console.log('⚠️ No tasks matched criteria. Exiting.');
    return;
  }

  const CHUNK_SIZE = 500;
  const totalChunks = Math.ceil(tasks.length / CHUNK_SIZE);
  let totalUploaded = 0;
  let errorsCount = 0;

  console.log(`⏳ Uploading ${tasks.length} tasks in ${totalChunks} chunks of ${CHUNK_SIZE}...`);

  const startTime = Date.now();

  for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
    const chunk = tasks.slice(i, i + CHUNK_SIZE);

    try {
      const { data, error } = await supabase
        .from('batch_job_queue')
        .upsert(chunk, {
          onConflict: 'applywizz_id,job_url',
          ignoreDuplicates: true,
        });

      if (error) {
        console.error(`  ❌ Chunk ${chunkIndex}/${totalChunks} error:`, error.message);
        errorsCount++;
      } else {
        totalUploaded += chunk.length;
        process.stdout.write(`  ✅ Chunk ${chunkIndex}/${totalChunks} ingested (${totalUploaded}/${tasks.length})\r`);
      }
    } catch (err) {
      console.error(`  ❌ Chunk ${chunkIndex}/${totalChunks} exception:`, err.message);
      errorsCount++;
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n🎉 Ingestion finished in ${elapsedSec}s!`);
  console.log(`   Processed tasks: ${totalUploaded}`);
  if (errorsCount > 0) {
    console.log(`   Failed chunks:  ${errorsCount}`);
  }

  // Verify DB state
  console.log(`\n🔍 Verifying batch_job_queue in Supabase...`);
  const { count: totalDbCount, error: countErr } = await supabase
    .from('batch_job_queue')
    .select('*', { count: 'exact', head: true });

  if (countErr) {
    console.error('Error fetching count:', countErr);
  } else {
    console.log(`   Total rows now in batch_job_queue: ${totalDbCount}`);
  }

  // Status breakdown
  const { data: statusBreakdown, error: statusErr } = await supabase
    .from('batch_job_queue')
    .select('status');

  if (!statusErr && Array.isArray(statusBreakdown)) {
    const counts = {};
    for (const r of statusBreakdown) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    console.log(`   Status breakdown:`, counts);
  }
}

run().catch(console.error);
