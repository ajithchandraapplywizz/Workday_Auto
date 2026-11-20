/**
 * push_new_csv_top_links.mjs
 *
 * Ingests top job links from Data/new_csv.csv where task_count > 10 into public.batch_job_queue.
 * Consolidates duplicate links (e.g. Unity with/without query params) into 1 unique row per link
 * with all AWL IDs merged in a single cell (applywizz_id JSON array).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured, supabase } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

const targetArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ingestAll = process.argv.includes('--all') || (targetArg && targetArg.includes('NewCsv_1'));
const csvPath = resolve(targetArg || 'Data/new_csv.csv');

let minCount = 10;
const minIdx = process.argv.indexOf('--min-count');
if (minIdx !== -1 && process.argv[minIdx + 1]) {
  minCount = parseInt(process.argv[minIdx + 1], 10) || 10;
} else if (targetArg && targetArg.includes('2026-11-20')) {
  minCount = 2;
}
const cleanupUnqualified = process.argv.includes('--cleanup-unqualified');

if (!existsSync(csvPath)) {
  console.error(`❌ CSV not found at: ${csvPath}`);
  process.exit(1);
}

function parseCSVStandard(text) {
  const rows = [];
  let row = [''];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nextCh = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && nextCh === '"') {
        row[row.length - 1] += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        row[row.length - 1] += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push('');
      } else if (ch === '\n' || (ch === '\r' && nextCh === '\n')) {
        if (ch === '\r') i++;
        if (row.length > 1 || row[0].trim() !== '') rows.push(row);
        row = [''];
      } else if (ch === '\r') {
        if (row.length > 1 || row[0].trim() !== '') rows.push(row);
        row = [''];
      } else {
        row[row.length - 1] += ch;
      }
    }
  }
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
  return rows;
}

function normalizeUrlKey(url) {
  try {
    const p = new URL(url);
    return (p.host + p.pathname).toLowerCase().replace(/\/+$/, '').replace(/\/apply$/, '');
  } catch {
    return String(url || '').toLowerCase().trim();
  }
}

async function run() {
  console.log('═'.repeat(80));
  if (ingestAll) {
    console.log('🚀 PUSHING ALL LINKS (COMPLETE CSV INGESTION) TO batch_job_queue');
  } else {
    console.log(`🚀 PUSHING TOP LINKS (task_count >= ${minCount}) TO batch_job_queue`);
  }
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(80));

  const raw = readFileSync(csvPath, 'utf8');
  const allRows = parseCSVStandard(raw);
  const dataRows = allRows.slice(1);

  console.log(`📁 Total rows in CSV: ${dataRows.length}`);

  // 1. Filter rows (complete links if ingestAll, else task_count >= minCount)
  const qualifyingRows = ingestAll
    ? dataRows.filter((r) => r[3] && r[3].trim().length > 0)
    : dataRows.filter((r) => {
        const tc = parseInt(r[4], 10);
        return !isNaN(tc) && tc >= minCount;
      });

  console.log(`🎯 Rows meeting criteria (${ingestAll ? 'ALL rows with URLs' : `task_count >= ${minCount}`}): ${qualifyingRows.length}`);

  // 2. Aggregate into unique links and merge AWLs
  const urlMap = new Map();

  for (const r of qualifyingRows) {
    const jobId = r[0] ? r[0].trim() : null;
    const company = r[1] ? r[1].trim() : '';
    const roleTitle = r[2] ? r[2].trim() : '';
    const jobUrl = r[3] ? r[3].trim() : '';
    const taskCount = parseInt(r[4], 10);
    const awlRaw = r[5] || '';

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
        sourceRowsCount: 1,
      });
    } else {
      const existing = urlMap.get(normKey);
      if (jobId && !existing.job_id) existing.job_id = jobId;
      if (company && !existing.company) existing.company = company;
      if (roleTitle && !existing.role_title) existing.role_title = roleTitle;
      for (const a of uniqueAwl) existing.awlIds.add(a);
      existing.sourceRowsCount += 1;
    }
  }

  console.log(`🔗 Deduplicated into ${urlMap.size} unique job links.`);

  // 3. Pre-fetch existing state (scanned_jobs, failed_jobs, batch_job_queue)
  const [scannedJobs, failedJobs, existingQueue] = await Promise.all([
    request('scanned_jobs', { query: '?select=id,job_url,screenshot_path&limit=5000' }).catch(() => []),
    request('failed_jobs', { query: '?select=id,job_url,failure_reason,failed_at_step,screenshot_path&limit=5000' }).catch(() => []),
    request('batch_job_queue', { query: '?select=id,job_url,applywizz_id,status,screenshot_path,scanned_job_id&limit=5000' }).catch(() => []),
  ]);

  const scannedMap = new Map();
  for (const sj of scannedJobs || []) {
    if (sj.job_url) scannedMap.set(normalizeUrlKey(sj.job_url), sj);
  }

  const expiredMap = new Map();
  for (const fj of failedJobs || []) {
    if (fj.job_url) {
      const isExp =
        String(fj.failure_reason || '').toLowerCase().includes('expired') ||
        String(fj.failed_at_step || '').toLowerCase().includes('expired');
      if (isExp) expiredMap.set(normalizeUrlKey(fj.job_url), fj);
    }
  }

  const existingQueueMap = new Map();
  for (const eq of existingQueue || []) {
    if (eq.job_url) existingQueueMap.set(normalizeUrlKey(eq.job_url), eq);
  }

  const now = new Date().toISOString();
  const toInsert = [];
  const toUpdate = [];

  let totalCandidateTasks = 0;
  let idx = 0;

  for (const [normKey, item] of urlMap.entries()) {
    idx++;
    const awlList = Array.from(item.awlIds);
    totalCandidateTasks += awlList.length;

    const matchedSj = scannedMap.get(normKey);
    const matchedFj = expiredMap.get(normKey);
    const existing = existingQueueMap.get(normKey);

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
        currentAwl = String(existing.applywizz_id || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const mergedAwl = Array.from(new Set([...currentAwl, ...awlList]));
      toUpdate.push({
        num: idx,
        id: existing.id,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        awlCount: mergedAwl.length,
        awlList: mergedAwl,
        patch: {
          job_id: item.job_id || existing.job_id || null,
          company: item.company || existing.company,
          role_title: item.role_title || existing.role_title,
          applywizz_id: JSON.stringify(mergedAwl),
          status: initialStatus,
          screenshot_path: screenshotPath,
          scanned_job_id: scannedId,
          updated_at: now,
        },
      });
    } else {
      toInsert.push({
        num: idx,
        company: item.company,
        roleTitle: item.role_title,
        jobUrl: item.job_url,
        awlCount: awlList.length,
        awlList,
        row: {
          job_id: item.job_id || null,
          company: item.company || 'Workday Company',
          role_title: item.role_title || 'Workday Role',
          job_url: item.job_url,
          applywizz_id: JSON.stringify(awlList),
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
  console.log(`   ➕ New links to INSERT:  ${toInsert.length}`);
  console.log(`   🔄 Existing links to UPDATE/MERGE: ${toUpdate.length}`);
  console.log(`   👥 Total unique candidate tasks across links: ${totalCandidateTasks}\n`);

  // 4. Perform Inserts
  if (toInsert.length > 0) {
    console.log(`⏳ Inserting ${toInsert.length} new links into batch_job_queue...`);
    const insertPayload = toInsert.map((t) => t.row);
    const CHUNK_SIZE = 25;
    for (let i = 0; i < insertPayload.length; i += CHUNK_SIZE) {
      const chunk = insertPayload.slice(i, i + CHUNK_SIZE);
      await request('batch_job_queue', {
        method: 'POST',
        prefer: 'return=representation',
        body: chunk,
      });
      console.log(`   ✅ Inserted chunk [${i + 1} - ${Math.min(i + CHUNK_SIZE, insertPayload.length)} / ${insertPayload.length}]`);
    }
  }

  // 5. Perform Updates
  if (toUpdate.length > 0) {
    console.log(`⏳ Updating/merging ${toUpdate.length} existing links...`);
    for (const u of toUpdate) {
      await request('batch_job_queue', {
        method: 'PATCH',
        query: `?id=eq.${u.id}`,
        body: u.patch,
      });
      console.log(`   ✅ Updated existing link id=${u.id} (${u.company}) with ${u.awlCount} candidates.`);
    }
  }

  // 5b. Optional Cleanup of Unqualified Links (e.g. task_count < minCount with status pending)
  if (cleanupUnqualified) {
    const unqualifiedUrls = dataRows
      .filter((r) => {
        const tc = parseInt(r[4], 10);
        return isNaN(tc) || tc < minCount;
      })
      .map((r) => r[3])
      .filter(Boolean);

    const normUnqualified = new Set(unqualifiedUrls.map(normalizeUrlKey));
    const toDeleteIds = [];
    for (const [key, eq] of existingQueueMap.entries()) {
      if (normUnqualified.has(key) && !urlMap.has(key) && eq.status === 'pending') {
        toDeleteIds.push(eq.id);
      }
    }

    if (toDeleteIds.length > 0) {
      console.log(`\n🧹 Cleaning up ${toDeleteIds.length} unqualified pending links (task_count < ${minCount})...`);
      for (let i = 0; i < toDeleteIds.length; i += 25) {
        const chunk = toDeleteIds.slice(i, i + 25);
        await supabase.from('batch_job_queue').delete().in('id', chunk);
      }
      console.log(`   ✅ Removed ${toDeleteIds.length} unqualified links from batch_job_queue.`);
    }
  }

  // 6. Verify and output detailed report
  console.log('\n' + '═'.repeat(80));
  console.log('📊 FINAL INGESTION REPORT');
  console.log('═'.repeat(80));

  const countRes = await supabase.from('batch_job_queue').select('*', { count: 'exact', head: true });
  console.log(`🎉 Total rows now in batch_job_queue: ${countRes.count}`);
  console.log(`🔗 Unique Links Uploaded / Updated: ${urlMap.size}`);
  console.log(`👥 Total Candidate Tasks Assigned: ${totalCandidateTasks}\n`);

  console.log('Detailed Link Breakdown:');
  let reportIdx = 0;
  for (const [normKey, item] of urlMap.entries()) {
    reportIdx++;
    const awlList = Array.from(item.awlIds);
    const existing = existingQueueMap.get(normKey);
    const op = existing ? `UPDATE (id=${existing.id})` : 'INSERT (new)';
    console.log(`\n[${reportIdx}] ${item.company} | ${item.role_title} (Job ID: ${item.job_id || 'N/A'}) [${op}]`);
    console.log(`    URL: ${item.job_url}`);
    console.log(`    Candidate Tasks (${awlList.length}): ${awlList.join(', ')}`);
  }

  console.log('\n' + '═'.repeat(80));
  console.log('✅ Ingestion Completed Successfully!');
  console.log('═'.repeat(80));

  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
