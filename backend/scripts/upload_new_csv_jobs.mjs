import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { request, loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const csvPath = resolve('Data/wd_jobs_202611061113.csv');

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
  console.log('🚀 UPLOADING WORKDAY JOBS TO batch_job_queue (1 ROW PER UNIQUE LINK)');
  console.log(`   Source CSV: ${csvPath}`);
  console.log('═'.repeat(75));

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`\n📁 Loaded ${lines.length} lines from CSV (including header).`);

  // Map by unique job_url
  const urlMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 5) continue;

    const jobId = parts[1] ? parts[1].trim() : null;
    const company = parts[2] ? parts[2].trim() : '';
    const roleTitle = parts[3] ? parts[3].trim() : '';
    const jobUrl = parts[4] ? parts[4].trim() : '';
    const awlRaw = parts[6] || parts[5] || '';

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

  console.log(`\n📊 Aggregated into ${urlMap.size} unique Workday job URLs.`);

  // Check existing scanned_jobs to link scanned_job_id if already scanned
  const scannedJobs = await request('scanned_jobs', { query: '?select=id,job_url,screenshot_path' }).catch(() => []);
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

  // Check existing batch_job_queue items to check existing status
  const existingQueue = await request('batch_job_queue', { query: '?select=id,job_url,status,screenshot_path,scanned_job_id' }).catch(() => []);
  const existingQueueMap = new Map();
  if (Array.isArray(existingQueue)) {
    for (const eq of existingQueue) {
      if (eq.job_url) existingQueueMap.set(eq.job_url.trim().toLowerCase(), eq);
    }
  }

  const now = new Date().toISOString();
  const queueRows = [];

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

    queueRows.push({
      job_id: item.job_id || null,
      company: item.company || 'Workday Company',
      role_title: item.role_title || 'Workday Role',
      job_url: item.job_url,
      // Store all candidate AWL IDs for this link in a single cell as JSON array string
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

  console.log(`📋 Total unique job rows to insert: ${queueRows.length}`);
  console.log(`👥 Total candidate associations across all links: ${totalCandidateAssociations}`);

  // Ingest in chunks of 50
  const chunkSize = 50;
  let insertedCount = 0;

  for (let i = 0; i < queueRows.length; i += chunkSize) {
    const chunk = queueRows.slice(i, i + chunkSize);
    const res = await request('batch_job_queue', {
      method: 'POST',
      prefer: 'return=representation',
      body: chunk,
    });
    insertedCount += Array.isArray(res) ? res.length : chunk.length;
    console.log(`   ✓ Ingested chunk [${i + 1} - ${Math.min(i + chunkSize, queueRows.length)} / ${queueRows.length}]`);
  }

  console.log(`\n🎉 Ingestion Complete! Successfully inserted ${insertedCount} unique job links into batch_job_queue.`);

  // Verify in database
  const countRes = await request('batch_job_queue', { query: '?select=id,company,role_title,job_url,status,applywizz_id' });
  console.log(`\n🔍 Verification: Currently in batch_job_queue: ${countRes ? countRes.length : 0} rows.`);

  console.log('\nSample Ingested Rows:');
  for (let i = 0; i < Math.min(5, (countRes || []).length); i++) {
    const r = countRes[i];
    let parsedAwl = [];
    try { parsedAwl = JSON.parse(r.applywizz_id); } catch { parsedAwl = [r.applywizz_id]; }
    console.log(` [${i + 1}] ${r.company} — "${r.role_title}"`);
    console.log(`     URL: ${r.job_url}`);
    console.log(`     Candidates (${parsedAwl.length}): ${parsedAwl.slice(0, 8).join(', ')}${parsedAwl.length > 8 ? ` (+${parsedAwl.length - 8} more)` : ''}`);
    console.log(`     Status: ${r.status}`);
  }

  console.log('\n═'.repeat(75));
  console.log('✅ UPLOAD FINISHED SUCCESSFULLY');
  console.log('═'.repeat(75));
}

upload().catch((err) => {
  console.error('Fatal upload error:', err);
  process.exit(1);
});

