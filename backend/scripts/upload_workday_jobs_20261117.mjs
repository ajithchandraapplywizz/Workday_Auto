/**
 * upload_workday_jobs_20261117.mjs
 *
 * Ingests Workday jobs CSV into Supabase public.batch_job_queue.
 * - 1 row per unique Workday job link
 * - All associated candidate AWL IDs stored in a single cell as JSON array string in applywizz_id
 * - Synchronizes with scanned_jobs and failed_jobs to assign correct initial status
 * - Updates created_at & updated_at to ensure getRecentBatchJobUrls includes this active batch
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const targetArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const defaultPath = process.env.CSV_PATH || 'Data/workday-jobs-2026-11-17.csv';
const csvPath = resolve(targetArg || defaultPath);

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
  console.log('🚀 INGESTING WORKDAY CSV TO batch_job_queue');
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(75));

  let raw = readFileSync(csvPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`\n📋 Loaded ${lines.length} lines from CSV (including header).`);

  // Map by unique job_url
  const urlMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 4) continue;

    const jobId = parts[0] ? parts[0].trim() : null;
    const company = parts[1] ? parts[1].trim() : '';
    const roleTitle = parts[2] ? parts[2].trim() : '';
    const jobUrl = parts[3] ? parts[3].trim() : '';
    const awlRaw = parts[5] || parts[4] || '';

    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

    const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
    const uniqueAwl = [...new Set(awlMatches)];

    if (!urlMap.has(jobUrl)) {
      urlMap.set(jobUrl, {
        job_id: jobId,
        company,
        role_title: roleTitle,
        job_url: jobUrl,
        awlIds: new Set(uniqueAwl),
      });
    } else {
      const existing = urlMap.get(jobUrl);
      if (jobId && !existing.job_id) existing.job_id = jobId;
      if (company && !existing.company) existing.company = company;
      if (roleTitle && !existing.role_title) existing.role_title = roleTitle;
      for (const a of uniqueAwl) {
        existing.awlIds.add(a);
      }
    }
  }

  console.log(`\n📊 Processed into ${urlMap.size} unique Workday job URLs.`);

  // Check existing scanned_jobs to link scanned_job_id if already scanned
  const scannedJobs = await request('scanned_jobs', { query: '?select=id,job_url,screenshot_path,scan_status' }).catch(() => []);
  const scannedMap = new Map();
  if (Array.isArray(scannedJobs)) {
    for (const sj of scannedJobs) {
      if (sj.job_url) scannedMap.set(sj.job_url.trim().toLowerCase(), sj);
    }
  }

  // Check existing failed_jobs to check for expired status
  const failedJobs = await request('failed_jobs', { query: '?select=id,job_url,failure_reason,failed_at_step,screenshot_path' }).catch(() => []);
  const expiredMap = new Map();
  if (Array.isArray(failedJobs)) {
    for (const fj of failedJobs) {
      if (fj.job_url) {
        const isExp = String(fj.failure_reason || '').toLowerCase().includes('expired') ||
                      String(fj.failed_at_step || '').toLowerCase().includes('expired');
        if (isExp) expiredMap.set(fj.job_url.trim().toLowerCase(), fj);
      }
    }
  }

  // Check existing batch_job_queue items to merge or update
  const existingQueue = await request('batch_job_queue', { query: '?select=id,job_url,status,screenshot_path,scanned_job_id,applywizz_id' }).catch(() => []);
  const existingQueueMap = new Map();
  if (Array.isArray(existingQueue)) {
    for (const eq of existingQueue) {
      if (eq.job_url) existingQueueMap.set(eq.job_url.trim().toLowerCase(), eq);
    }
  }

  const now = new Date().toISOString();
  const rowsToInsert = [];
  const rowsToUpdate = [];

  let totalCandidateAssociations = 0;
  for (const [url, item] of urlMap.entries()) {
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
      existing?.status === 'already_scanned' ||
      existing?.status === 'scanned' ||
      existing?.status === 'already_reached_review' ||
      existing?.status === 'reached_review' ||
      (matchedSj && matchedSj.scan_status === 'completed')
    ) {
      initialStatus = 'already_scanned';
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
      let currentAwl = [];
      try {
        currentAwl = JSON.parse(existing.applywizz_id);
      } catch {
        currentAwl = [existing.applywizz_id].filter(Boolean);
      }
      const mergedAwl = Array.from(new Set([...currentAwl, ...awlArray]));
      rowsToUpdate.push({
        id: existing.id,
        patch: {
          job_id: item.job_id || null,
          company: item.company || 'Workday Company',
          role_title: item.role_title || 'Workday Role',
          applywizz_id: JSON.stringify(mergedAwl),
          status: initialStatus,
          attempt_count: 0,
          worker_id: null,
          locked_at: null,
          scanned_job_id: scannedId,
          screenshot_path: screenshotPath,
          created_at: now,
          updated_at: now,
        },
      });
    } else {
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
  }

  console.log(`📋 Total unique job links to process: ${urlMap.size}`);
  console.log(`   - New rows to INSERT: ${rowsToInsert.length}`);
  console.log(`   - Existing rows to UPDATE/MERGE: ${rowsToUpdate.length}`);
  console.log(`👥 Total candidate associations across all links: ${totalCandidateAssociations}`);

  // Ingest inserts in chunks of 50
  if (rowsToInsert.length > 0) {
    const chunkSize = 50;
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      await request('batch_job_queue', {
        method: 'POST',
        prefer: 'return=representation',
        body: chunk,
      });
      console.log(`   ✓ Ingested insert chunk [${i + 1} - ${Math.min(i + chunkSize, rowsToInsert.length)} / ${rowsToInsert.length}]`);
    }
  }

  // Update existing rows
  if (rowsToUpdate.length > 0) {
    console.log(`   ⏳ Updating ${rowsToUpdate.length} existing rows...`);
    for (let i = 0; i < rowsToUpdate.length; i++) {
      const upd = rowsToUpdate[i];
      await request('batch_job_queue', {
        method: 'PATCH',
        query: `?id=eq.${upd.id}`,
        prefer: 'return=representation',
        body: upd.patch,
      });
    }
    console.log(`   ✓ Successfully updated ${rowsToUpdate.length} existing queue rows.`);
  }

  console.log(`\n🎉 Ingestion Complete! Successfully synced ${urlMap.size} unique job links into batch_job_queue.`);

  // Verify in database
  const countRes = await request('batch_job_queue', { query: '?select=id,company,role_title,job_url,status,applywizz_id' });
  console.log(`\n🔍 Verification: Currently in batch_job_queue: ${countRes ? countRes.length : 0} rows.`);

  // Status breakdown
  const statusCounts = {};
  for (const r of countRes || []) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }
  console.log(`   Status breakdown:`, statusCounts);

  console.log('\nSample Ingested Rows:');
  const sample = (countRes || []).slice(-5);
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    let parsedAwl = [];
    try { parsedAwl = JSON.parse(r.applywizz_id); } catch { parsedAwl = [r.applywizz_id]; }
    console.log(` [${i + 1}] ${r.company} — "${r.role_title}"`);
    console.log(`     URL: ${r.job_url}`);
    console.log(`     Candidates (${parsedAwl.length}): ${parsedAwl.slice(0, 8).join(', ')}${parsedAwl.length > 8 ? ` (+${parsedAwl.length - 8} more)` : ''}`);
    console.log(`     Status: ${r.status}`);
  }

  console.log('\n' + '═'.repeat(75));
  console.log('✅ UPLOAD FINISHED SUCCESSFULLY');
  console.log('═'.repeat(75));
}

upload().catch((err) => {
  console.error('❌ Fatal upload error:', err);
  process.exit(1);
});
