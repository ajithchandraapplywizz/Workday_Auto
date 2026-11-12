import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const csvPath = resolve('Data/wd_jobs_202611121809.csv');

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
  console.log('🚀 INGESTING 22 UNIQUE WORKDAY JOBS (TASK_COUNT >= 12) INTO batch_job_queue');
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(75));

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`📁 Loaded ${lines.length} lines from CSV (including header).`);

  // Build unique URL map for task_count >= 12 (the 22 unique links)
  const urlMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 5) continue;

    const taskCount = Number(parts[4]);
    if (Number.isNaN(taskCount) || taskCount < 12) continue;

    const jobId = parts[0] ? parts[0].trim() : null;
    let company = parts[1] ? parts[1].trim() : '';
    // Fix common encoding artifact for Avēsis
    if (company.includes('AvÄ“sis') || company.includes('AvÃ¨sis')) {
      company = 'Avēsis';
    }
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

  console.log(`\n📊 Aggregated into ${urlMap.size} unique Workday job URLs (task_count >= 12).`);

  if (urlMap.size !== 22) {
    console.warn(`⚠️  Expected 22 unique links, found ${urlMap.size}.`);
  }

  // 1. Check existing scanned_jobs
  const scannedJobs = await request('scanned_jobs', { query: '?select=id,job_url,screenshot_path' }).catch(() => []);
  const scannedMap = new Map();
  if (Array.isArray(scannedJobs)) {
    for (const sj of scannedJobs) {
      if (sj.job_url) scannedMap.set(sj.job_url.trim().toLowerCase(), sj);
    }
  }

  // 2. Check failed_jobs for expired
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

  // 3. Fetch existing batch_job_queue
  const existingQueue = await request('batch_job_queue', {
    query: '?select=id,job_url,applywizz_id,status,screenshot_path,scanned_job_id',
  }).catch(() => []);
  const existingQueueMap = new Map();
  if (Array.isArray(existingQueue)) {
    for (const eq of existingQueue) {
      if (eq.job_url) existingQueueMap.set(eq.job_url.trim().toLowerCase(), eq);
    }
  }
  console.log(`📦 Currently in batch_job_queue: ${existingQueueMap.size} rows.`);

  const now = new Date().toISOString();
  const rowsToInsert = [];
  const rowsToUpdate = [];

  let totalCandidateAssociations = 0;
  let idx = 0;

  for (const [url, item] of urlMap.entries()) {
    idx++;
    const awlArray = Array.from(item.awlIds);
    totalCandidateAssociations += awlArray.length;

    const urlKey = url.toLowerCase();
    const matchedSj = scannedMap.get(urlKey);
    const matchedFj = expiredMap.get(urlKey);
    const existing = existingQueueMap.get(urlKey);

    let initialStatus = 'pending';
    let scannedId = matchedSj?.id || null;
    let screenshotPath = matchedSj?.screenshot_path || null;

    if (
      existing?.status === 'already_reached_review' ||
      existing?.status === 'reached_review' ||
      matchedSj
    ) {
      initialStatus = 'already_reached_review';
      scannedId = matchedSj?.id || existing?.scanned_job_id || null;
      screenshotPath = matchedSj?.screenshot_path || existing?.screenshot_path || null;
    } else if (
      existing?.status === 'already_expired' ||
      existing?.status === 'expired' ||
      matchedFj
    ) {
      initialStatus = 'already_expired';
      screenshotPath = matchedFj?.screenshot_path || existing?.screenshot_path || null;
    }

    if (existing) {
      // Merge AWL IDs
      let currentAwl = [];
      try {
        currentAwl = JSON.parse(existing.applywizz_id);
      } catch {
        currentAwl = [existing.applywizz_id].filter(Boolean);
      }
      const mergedAwl = Array.from(new Set([...currentAwl, ...awlArray]));
      rowsToUpdate.push({
        num: idx,
        id: existing.id,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        taskCount: item.taskCount,
        awlCount: mergedAwl.length,
        patch: {
          job_id: item.job_id || null,
          company: item.company || 'Workday Company',
          role_title: item.role_title || 'Workday Role',
          applywizz_id: JSON.stringify(mergedAwl),
          status: initialStatus,
          screenshot_path: screenshotPath,
          scanned_job_id: scannedId,
          updated_at: now,
        },
      });
    } else {
      rowsToInsert.push({
        num: idx,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        taskCount: item.taskCount,
        awlCount: awlArray.length,
        row: {
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
        },
      });
    }
  }

  console.log(`\n📋 Ingestion breakdown:`);
  console.log(`   ➕ New jobs to INSERT: ${rowsToInsert.length}`);
  console.log(`   🔄 Existing jobs to UPDATE/MERGE: ${rowsToUpdate.length}`);
  console.log(`   👥 Total candidate associations in these 22 jobs: ${totalCandidateAssociations}`);

  if (rowsToInsert.length > 0) {
    console.log('\n➕ Inserting new jobs:');
    for (const r of rowsToInsert) {
      console.log(`   [${r.num}] ${r.company} | ${r.roleTitle} | tc=${r.taskCount} | AWLs: ${r.awlCount} | URL: ${r.jobUrl}`);
    }
    const insertPayload = rowsToInsert.map((r) => r.row);
    const chunkSize = 25;
    for (let i = 0; i < insertPayload.length; i += chunkSize) {
      const chunk = insertPayload.slice(i, i + chunkSize);
      await request('batch_job_queue', {
        method: 'POST',
        prefer: 'return=representation',
        body: chunk,
      });
      console.log(`   ✓ Inserted chunk [${i + 1} - ${Math.min(i + chunkSize, insertPayload.length)} / ${insertPayload.length}]`);
    }
  }

  if (rowsToUpdate.length > 0) {
    console.log('\n🔄 Updating / merging existing jobs:');
    for (const r of rowsToUpdate) {
      console.log(`   [${r.num}] (ID: ${r.id}) ${r.company} | ${r.roleTitle} | tc=${r.taskCount} | Merged AWLs: ${r.awlCount} | URL: ${r.jobUrl}`);
      await request('batch_job_queue', {
        method: 'PATCH',
        query: `?id=eq.${r.id}`,
        body: r.patch,
      });
      console.log(`   ✓ Updated queue item id=${r.id}`);
    }
  }

  // Final verification
  const finalQueue = await request('batch_job_queue', { query: '?select=id,status' }).catch(() => []);
  console.log('\n' + '═'.repeat(75));
  console.log(`🎉 Ingestion completed successfully!`);
  console.log(`🔍 Total rows now in batch_job_queue: ${finalQueue.length}`);
  console.log('═'.repeat(75));
}

upload().catch((err) => {
  console.error('Fatal upload error:', err);
  process.exit(1);
});

