import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const csvPath = resolve('Data/Todays_jobs.csv');

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

async function upload() {
  console.log('═'.repeat(75));
  console.log('🚀 UPLOADING REMAINING WORKDAY JOBS (TASK_COUNT > 12, NOT ALREADY UPLOADED)');
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(75));

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`📁 Loaded ${lines.length} lines from CSV (including header).`);

  // Build unique URL map for task_count > 12 (strictly greater than 12)
  const urlMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 5) continue;

    const taskCount = Number(parts[4]);
    if (Number.isNaN(taskCount) || taskCount <= 12) continue;  // strictly > 12

    const jobId = parts[0] ? parts[0].trim() : null;
    const company = parts[1] ? parts[1].trim() : '';
    const roleTitle = parts[2] ? parts[2].trim() : '';
    const jobUrl = parts[3] ? parts[3].trim() : '';
    const awlRaw = parts[5] || '';

    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

    const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
    const uniqueAwl = [...new Set(awlMatches)];

    if (!urlMap.has(jobUrl)) {
      urlMap.set(jobUrl, {
        job_id: jobId,
        company,
        role_title: roleTitle,
        job_url: jobUrl,
        taskCount,
        awlIds: new Set(uniqueAwl),
      });
    } else {
      const existing = urlMap.get(jobUrl);
      if (jobId && !existing.job_id) existing.job_id = jobId;
      if (company && !existing.company) existing.company = company;
      if (roleTitle && !existing.role_title) existing.role_title = roleTitle;
      for (const a of uniqueAwl) existing.awlIds.add(a);
    }
  }

  console.log(`\n📊 Total unique URLs with task_count > 12: ${urlMap.size}`);

  // Fetch existing batch_job_queue to find what's already uploaded
  const existingQueue = await request('batch_job_queue', {
    query: '?select=id,job_url,applywizz_id,status,screenshot_path,scanned_job_id',
  }).catch(() => []);
  const existingQueueMap = new Map();
  if (Array.isArray(existingQueue)) {
    for (const eq of existingQueue) {
      if (eq.job_url) existingQueueMap.set(eq.job_url.trim().toLowerCase(), eq);
    }
  }
  console.log(`📦 Already in batch_job_queue: ${existingQueueMap.size} rows.`);

  // Filter to ONLY remaining (not yet in queue)
  const remainingMap = new Map();
  for (const [url, item] of urlMap.entries()) {
    const urlKey = url.toLowerCase();
    if (!existingQueueMap.has(urlKey)) {
      remainingMap.set(url, item);
    }
  }

  console.log(`✅ Already uploaded: ${urlMap.size - remainingMap.size} jobs (skipped)`);
  console.log(`🆕 Remaining to upload (task_count > 12, not yet in queue): ${remainingMap.size}`);

  if (remainingMap.size === 0) {
    console.log('\n⚠️  No new remaining jobs to upload. All qualifying jobs already in queue.');
    process.exit(0);
  }

  // Check scanned_jobs
  const scannedJobs = await request('scanned_jobs', { query: '?select=id,job_url,screenshot_path' }).catch(() => []);
  const scannedMap = new Map();
  if (Array.isArray(scannedJobs)) {
    for (const sj of scannedJobs) {
      if (sj.job_url) scannedMap.set(sj.job_url.trim().toLowerCase(), sj);
    }
  }

  // Check failed_jobs for expired
  const failedJobs = await request('failed_jobs', {
    query: '?select=id,job_url,failure_reason,failed_at_step,screenshot_path',
  }).catch(() => []);
  const expiredMap = new Map();
  if (Array.isArray(failedJobs)) {
    for (const fj of failedJobs) {
      if (fj.job_url) {
        const isExp =
          String(fj.failure_reason || '').toLowerCase().includes('expired') ||
          String(fj.failed_at_step || '').toLowerCase().includes('expired');
        if (isExp) expiredMap.set(fj.job_url.trim().toLowerCase(), fj);
      }
    }
  }

  const now = new Date().toISOString();
  const rowsToInsert = [];

  let totalCandidateAssociations = 0;
  for (const [url, item] of remainingMap.entries()) {
    const awlArray = Array.from(item.awlIds);
    totalCandidateAssociations += awlArray.length;

    const urlKey = url.toLowerCase();
    const matchedSj = scannedMap.get(urlKey);
    const matchedFj = expiredMap.get(urlKey);

    let initialStatus = 'pending';
    let scannedId = matchedSj?.id || null;
    let screenshotPath = matchedSj?.screenshot_path || null;

    if (matchedSj) {
      initialStatus = 'already_scanned';
    } else if (matchedFj) {
      initialStatus = 'already_expired';
      screenshotPath = matchedFj?.screenshot_path || null;
    }

    rowsToInsert.push({
      job_id: item.job_id || null,
      company: item.company || 'Workday Company',
      role_title: item.role_title || 'Workday Role',
      job_url: item.job_url,
      applywizz_id: JSON.stringify(awlArray),
      status: initialStatus,
      attempt_count: 0,
      worker_id: null,
      locked_at: null,
      screenshot_path: screenshotPath,
      scanned_job_id: scannedId,
      created_at: now,
      updated_at: now,
    });
  }

  console.log(`\n📋 Jobs to INSERT: ${rowsToInsert.length}`);
  console.log(`👥 Total candidate associations: ${totalCandidateAssociations}`);

  // Print summary
  console.log('\n📌 Remaining jobs being uploaded now:');
  let n = 0;
  for (const [url, v] of remainingMap) {
    n++;
    const awlArr = Array.from(v.awlIds);
    console.log(`  [${n}] ${v.company} (tc=${v.taskCount})`);
    console.log(`       URL: ${url}`);
    console.log(`       AWL IDs (${awlArr.length}): ${awlArr.join(', ')}`);
  }

  // Insert in chunks
  const chunkSize = 50;
  for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
    const chunk = rowsToInsert.slice(i, i + chunkSize);
    await request('batch_job_queue', {
      method: 'POST',
      prefer: 'return=representation',
      body: chunk,
    });
    console.log(`\n   ✓ Inserted chunk [${i + 1} - ${Math.min(i + chunkSize, rowsToInsert.length)} / ${rowsToInsert.length}]`);
  }

  console.log(`\n🎉 Done! Successfully inserted ${rowsToInsert.length} new jobs into batch_job_queue.`);

  // Verify total
  const countRes = await request('batch_job_queue', { query: '?select=id' });
  console.log(`🔍 Verification: Total rows now in batch_job_queue: ${countRes ? countRes.length : 0}`);

  console.log('\n' + '═'.repeat(75));
  console.log('✅ UPLOAD FINISHED SUCCESSFULLY');
  console.log('═'.repeat(75));
}

upload().catch((err) => {
  console.error('Fatal upload error:', err);
  process.exit(1);
});

