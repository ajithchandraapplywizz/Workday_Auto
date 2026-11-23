/**
 * upload_workday_jobs_20261118.mjs
 *
 * Ingests Workday jobs CSV (2026-11-18) where task_count >= 15 (24 links) into Supabase batch_job_queue.
 * - 1 row per unique Workday job link
 * - All associated candidate AWL IDs stored in a single cell as JSON array string in applywizz_id
 * - Synchronizes with scanned_jobs and failed_jobs to assign correct initial status
 * - Appends & merges with existing records, preserving authentic submitted/scanned statuses
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured, supabase } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const args = process.argv.slice(2);
const targetArg = args.find((a) => !a.startsWith('--'));
const defaultPath = process.env.CSV_PATH || 'Data/workday-jobs-2026-11-18.csv';
const csvPath = resolve(targetArg || defaultPath);

const minCountArg = args.find((a) => a.startsWith('--min-count='))?.split('=')[1];
const minTaskCount = args.includes('--all') || minCountArg !== undefined
  ? (parseInt(minCountArg, 10) || 1)
  : (targetArg ? 1 : 15);

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

function normalizeUrlKey(url) {
  try {
    const p = new URL(url);
    return (p.host + p.pathname).toLowerCase().replace(/\/+$/, '').replace(/\/apply$/, '');
  } catch {
    return String(url || '').toLowerCase().trim();
  }
}

async function upload() {
  console.log('═'.repeat(80));
  console.log(`🚀 INGESTING WORKDAY CSV (task_count >= ${minTaskCount}) TO batch_job_queue`);
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(80));

  let raw = readFileSync(csvPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`\n📋 Loaded ${lines.length} lines from CSV (including header).`);

  // Map by normalized job URL
  const urlMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 5) continue;

    const jobId = parts[0] ? parts[0].trim() : null;
    const company = parts[1] ? parts[1].trim() : '';
    const roleTitle = parts[2] ? parts[2].trim() : '';
    const jobUrl = parts[3] ? parts[3].trim() : '';
    const taskCount = parseInt(parts[4], 10);
    const awlRaw = parts[5] || '';

    if (isNaN(taskCount) || taskCount < minTaskCount) {
      continue; // Filter for task_count >= minTaskCount
    }

    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

    const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
    const uniqueAwl = [...new Set(awlMatches)];

    const normKey = normalizeUrlKey(jobUrl);

    if (!urlMap.has(normKey)) {
      urlMap.set(normKey, {
        job_id: jobId,
        company,
        role_title: roleTitle,
        job_url: jobUrl,
        taskCount,
        awlIds: new Set(uniqueAwl),
        originalLine: i + 1,
      });
    } else {
      const existing = urlMap.get(normKey);
      if (jobId && !existing.job_id) existing.job_id = jobId;
      if (company && !existing.company) existing.company = company;
      if (roleTitle && !existing.role_title) existing.role_title = roleTitle;
      for (const a of uniqueAwl) {
        existing.awlIds.add(a);
      }
    }
  }

  console.log(`\n📊 Processed into ${urlMap.size} unique qualifying Workday job URLs (task_count >= 15).`);

  // Check existing scanned_jobs to link scanned_job_id if already scanned
  const scannedJobs = await request('scanned_jobs', { query: '?select=id,job_url,screenshot_path,scan_status&limit=5000' }).catch(() => []);
  const scannedMap = new Map();
  if (Array.isArray(scannedJobs)) {
    for (const sj of scannedJobs) {
      if (sj.job_url) scannedMap.set(normalizeUrlKey(sj.job_url), sj);
    }
  }

  // Check existing failed_jobs to check for expired status
  const failedJobs = await request('failed_jobs', { query: '?select=id,job_url,failure_reason,failed_at_step,screenshot_path&limit=5000' }).catch(() => []);
  const expiredMap = new Map();
  if (Array.isArray(failedJobs)) {
    for (const fj of failedJobs) {
      if (fj.job_url) {
        const isExp = String(fj.failure_reason || '').toLowerCase().includes('expired') ||
                      String(fj.failed_at_step || '').toLowerCase().includes('expired');
        if (isExp) expiredMap.set(normalizeUrlKey(fj.job_url), fj);
      }
    }
  }

  // Check existing batch_job_queue items to merge or update
  const existingQueue = await request('batch_job_queue', { query: '?select=id,job_url,status,screenshot_path,scanned_job_id,applywizz_id&limit=5000' }).catch(() => []);
  const existingQueueMap = new Map();
  if (Array.isArray(existingQueue)) {
    for (const eq of existingQueue) {
      if (eq.job_url) existingQueueMap.set(normalizeUrlKey(eq.job_url), eq);
    }
  }

  const now = new Date().toISOString();
  const rowsToInsert = [];
  const rowsToUpdate = [];

  let totalCandidateAssociations = 0;
  let itemIndex = 0;

  for (const [normKey, item] of urlMap.entries()) {
    itemIndex++;
    const awlArray = Array.from(item.awlIds);
    totalCandidateAssociations += awlArray.length;

    const matchedSj = scannedMap.get(normKey);
    const matchedFj = expiredMap.get(normKey);
    const existing = existingQueueMap.get(normKey);

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
      initialStatus = existing?.status || 'already_scanned';
      scannedId = matchedSj?.id || existing?.scanned_job_id || null;
      screenshotPath = matchedSj?.screenshot_path || existing?.screenshot_path || null;
    } else if (
      existing?.status === 'already_expired' ||
      existing?.status === 'expired' ||
      matchedFj
    ) {
      initialStatus = existing?.status || 'already_expired';
      screenshotPath = matchedFj?.screenshot_path || existing?.screenshot_path || null;
    }

    if (existing) {
      let currentAwl = [];
      try {
        currentAwl = JSON.parse(existing.applywizz_id);
      } catch {
        currentAwl = String(existing.applywizz_id || '').split(',').map((s) => s.trim()).filter(Boolean);
      }
      const mergedAwl = Array.from(new Set([...currentAwl, ...awlArray]));
      rowsToUpdate.push({
        num: itemIndex,
        id: existing.id,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        taskCount: item.taskCount,
        awlCount: mergedAwl.length,
        awlList: mergedAwl,
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
        num: itemIndex,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        taskCount: item.taskCount,
        awlCount: awlArray.length,
        awlList: awlArray,
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

  console.log(`\n📋 Execution Plan:`);
  console.log(`   ➕ New links to INSERT:  ${rowsToInsert.length}`);
  console.log(`   🔄 Existing links to UPDATE/MERGE: ${rowsToUpdate.length}`);
  console.log(`   👥 Total candidate associations: ${totalCandidateAssociations}\n`);

  // 1. Perform Inserts
  if (rowsToInsert.length > 0) {
    console.log(`⏳ Inserting ${rowsToInsert.length} new links into batch_job_queue...`);
    const insertPayload = rowsToInsert.map((t) => t.row);
    const chunkSize = 25;
    for (let i = 0; i < insertPayload.length; i += chunkSize) {
      const chunk = insertPayload.slice(i, i + chunkSize);
      await request('batch_job_queue', {
        method: 'POST',
        prefer: 'return=representation',
        body: chunk,
      });
      console.log(`   ✅ Inserted chunk [${i + 1} - ${Math.min(i + chunkSize, insertPayload.length)} / ${insertPayload.length}]`);
    }
  }

  // 2. Perform Updates
  if (rowsToUpdate.length > 0) {
    console.log(`⏳ Updating/merging ${rowsToUpdate.length} existing links...`);
    for (const u of rowsToUpdate) {
      await request('batch_job_queue', {
        method: 'PATCH',
        query: `?id=eq.${u.id}`,
        body: u.patch,
      });
      console.log(`   ✅ Updated existing link id=${u.id} (${u.company}) with ${u.awlCount} candidates.`);
    }
  }

  // 3. Final Verification and Breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📊 FINAL INGESTION REPORT (task_count >= 15)');
  console.log('═'.repeat(80));

  const countRes = await supabase.from('batch_job_queue').select('*', { count: 'exact', head: true });
  console.log(`🎉 Total rows now in batch_job_queue: ${countRes.count}`);
  console.log(`🔗 Qualifying Links Ingested / Updated: ${urlMap.size}`);
  console.log(`👥 Total Candidate Tasks Assigned: ${totalCandidateAssociations}\n`);

  let reportIdx = 0;
  for (const [normKey, item] of urlMap.entries()) {
    reportIdx++;
    const awlList = Array.from(item.awlIds);
    const existing = existingQueueMap.get(normKey);
    const op = existing ? `UPDATE (id=${existing.id})` : 'INSERT (new)';
    console.log(`[${reportIdx}] ${item.company} | ${item.role_title} (Job ID: ${item.job_id || 'N/A'}, tasks: ${item.taskCount}) [${op}]`);
    console.log(`    URL: ${item.job_url}`);
    console.log(`    AWL IDs (${awlList.length}): ${awlList.join(', ')}\n`);
  }

  console.log('═'.repeat(80));
  console.log('✅ Ingestion Completed Successfully!');
  console.log('═'.repeat(80));

  process.exit(0);
}

upload().catch((err) => {
  console.error('Fatal execution error during upload:', err);
  process.exit(1);
});
