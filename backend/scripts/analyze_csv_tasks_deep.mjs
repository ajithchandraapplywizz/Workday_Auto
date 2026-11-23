import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { supabase, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

const targetPath = process.env.CSV_PATH || (existsSync('Data/workday-jobs-2026-11-20.csv') ? 'Data/workday-jobs-2026-11-20.csv' : 'Data/workday-jobs-2026-11-18.csv');

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

async function fetchAll(tableName, selectCols) {
  let all = [];
  let from = 0;
  const step = 1000;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase.from(tableName).select(selectCols).range(from, from + step - 1);
    if (error) {
      console.error(`Error fetching ${tableName}:`, error.message);
      hasMore = false;
      break;
    }
    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }
    all = all.concat(data);
    if (data.length < step) {
      hasMore = false;
      break;
    }
    from += step;
  }
  return all;
}

async function analyze() {
  const raw = readFileSync(targetPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  console.log(`Loaded ${lines.length} lines from CSV.`);

  // Parse CSV
  const csvLinks = new Map(); // normKey -> details
  let totalCsvTasksSum = 0;
  const allCsvAwlSet = new Set();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 4) continue;
    const jobId = parts[0]?.trim();
    const company = parts[1]?.trim();
    const title = parts[2]?.trim();
    const jobUrl = parts[3]?.trim();
    const taskCount = parseInt(parts[4], 10) || 0;
    const awlRaw = parts[5] || '';
    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

    const normKey = normalizeUrlKey(jobUrl);
    const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map(m => m[1].toUpperCase());

    awlMatches.forEach(a => allCsvAwlSet.add(a));

    if (!csvLinks.has(normKey)) {
      csvLinks.set(normKey, {
        jobId,
        company,
        title,
        jobUrl,
        normKey,
        taskCount,
        awlIds: new Set(awlMatches),
        rowCount: 1,
      });
    } else {
      const existing = csvLinks.get(normKey);
      existing.rowCount += 1;
      // If taskCount in this row is higher, or if we need to see how task count is defined
      if (taskCount > existing.taskCount) existing.taskCount = taskCount;
      awlMatches.forEach(a => existing.awlIds.add(a));
    }
  }

  // Sum task counts across the 190 unique links
  let uniqueLinksTaskCountSum = 0;
  let uniqueLinksAwlCountSum = 0;
  for (const item of csvLinks.values()) {
    uniqueLinksTaskCountSum += item.taskCount;
    uniqueLinksAwlCountSum += item.awlIds.size;
  }

  console.log(`\n--- CSV LEVEL STATS ---`);
  console.log(`Total CSV Rows: ${lines.length - 1}`);
  console.log(`Total Unique Job Links: ${csvLinks.size}`);
  console.log(`Total Task Count (sum of task_count of 190 unique links): ${uniqueLinksTaskCountSum}`);
  console.log(`Total Unique AWL IDs per link sum: ${uniqueLinksAwlCountSum}`);

  // Fetch DB data
  console.log('\nFetching from Supabase...');
  const [bqRows, jdRows, scanRows, failRows] = await Promise.all([
    fetchAll('batch_job_queue', 'id, job_url, company, role_title, status, created_at, applywizz_id'),
    fetchAll('job_distributions', 'id, job_url, applywizz_id, status, is_fully_answered, unanswered_count, error_message'),
    fetchAll('scanned_jobs', 'id, job_url, scan_status, error_message'),
    fetchAll('failed_jobs', 'id, job_url, failure_reason, failed_at_step'),
  ]);

  console.log(`DB Counts:`);
  console.log(` - batch_job_queue: ${bqRows.length}`);
  console.log(` - job_distributions (tasks): ${jdRows.length}`);
  console.log(` - scanned_jobs: ${scanRows.length}`);
  console.log(` - failed_jobs: ${failRows.length}`);

  // Index DB by normKey
  const bqMap = new Map();
  bqRows.forEach(r => { if (r.job_url) bqMap.set(normalizeUrlKey(r.job_url), r); });

  const jdMap = new Map(); // normKey -> list of distributions
  jdRows.forEach(r => {
    if (r.job_url) {
      const k = normalizeUrlKey(r.job_url);
      if (!jdMap.has(k)) jdMap.set(k, []);
      jdMap.get(k).push(r);
    }
  });

  const scanMap = new Map();
  scanRows.forEach(r => { if (r.job_url) scanMap.set(normalizeUrlKey(r.job_url), r); });

  const failMap = new Map();
  failRows.forEach(r => { if (r.job_url) failMap.set(normalizeUrlKey(r.job_url), r); });

  // Separate Uploaded vs Not Uploaded
  const uploadedLinks = [];
  const notUploadedLinks = [];

  let uploadedTaskCountSum = 0;
  let notUploadedTaskCountSum = 0;

  for (const [normKey, rec] of csvLinks.entries()) {
    if (bqMap.has(normKey)) {
      uploadedLinks.push({ rec, bq: bqMap.get(normKey) });
      uploadedTaskCountSum += rec.taskCount;
    } else {
      notUploadedLinks.push(rec);
      notUploadedTaskCountSum += rec.taskCount;
    }
  }

  console.log(`\n--- UPLOADED VS NOT UPLOADED LINKS ---`);
  console.log(`Uploaded Links: ${uploadedLinks.length}`);
  console.log(` - Sum of task_count of Uploaded Links: ${uploadedTaskCountSum}`);
  console.log(`Not Uploaded Links: ${notUploadedLinks.length}`);
  console.log(` - Sum of task_count of Not Uploaded Links: ${notUploadedTaskCountSum}`);

  // Status breakdown of the 123 uploaded links in batch_job_queue
  const bqStatusCounts = {};
  uploadedLinks.forEach(u => {
    const st = u.bq.status || 'unknown';
    bqStatusCounts[st] = (bqStatusCounts[st] || 0) + 1;
  });
  console.log(`\nBatch Job Queue Link Status for the 123 uploaded links:`, bqStatusCounts);

  // Now let's inspect the EXACT candidate tasks in job_distributions for these 123 links
  let totalTasksInJdForCsvLinks = 0;
  const jdStatusCounts = {};
  const jdLinksWithStatus = {
    submitted: new Set(),
    ready_for_review: new Set(),
    needs_answers: new Set(),
    failed: new Set(),
    already_applied: new Set(),
    applying: new Set(),
    archived: new Set(),
  };

  for (const u of uploadedLinks) {
    const distributions = jdMap.get(u.rec.normKey) || [];
    totalTasksInJdForCsvLinks += distributions.length;
    for (const d of distributions) {
      const st = d.status || 'unknown';
      jdStatusCounts[st] = (jdStatusCounts[st] || 0) + 1;
      if (jdLinksWithStatus[st]) jdLinksWithStatus[st].add(u.rec.normKey);
    }
  }

  console.log(`\n--- EXACT CANDIDATE TASK STATS IN job_distributions FOR THESE CSV LINKS ---`);
  console.log(`Total candidate tasks distributed in DB for these CSV links: ${totalTasksInJdForCsvLinks}`);
  console.log(`Task status breakdown:`, jdStatusCounts);

  console.log(`\nUnique Links containing tasks of each status:`);
  for (const [st, linkSet] of Object.entries(jdLinksWithStatus)) {
    console.log(` - ${st}: ${linkSet.size} unique links`);
  }

  // Scanning status and failed scanning
  let scannedCount = 0;
  let failedScanCount = 0;
  const scanStatuses = {};
  for (const u of uploadedLinks) {
    const sc = scanMap.get(u.rec.normKey);
    if (sc) {
      scannedCount++;
      const sst = sc.scan_status || 'unknown';
      scanStatuses[sst] = (scanStatuses[sst] || 0) + 1;
    }
    const fl = failMap.get(u.rec.normKey);
    if (fl) {
      failedScanCount++;
    }
  }
  console.log(`\nScanning & Failure breakdown for the 123 uploaded links:`);
  console.log(` - Present in scanned_jobs: ${scannedCount}`);
  console.log(`   Scan statuses:`, scanStatuses);
  console.log(` - Present in failed_jobs: ${failedScanCount}`);

  // Write full detailed report to JSON file for precision
  const report = {
    summary: {
      totalCsvRows: lines.length - 1,
      uniqueNormalizedLinks: csvLinks.size,
      uploadedLinksCount: uploadedLinks.length,
      notUploadedLinksCount: notUploadedLinks.length,
      totalCsvTaskCountSum: uniqueLinksTaskCountSum,
      uploadedTaskCountSum,
      notUploadedTaskCountSum,
    },
    bqStatusCounts,
    jobDistributionTaskCounts: jdStatusCounts,
    totalCandidateTasksInDbForTheseLinks: totalTasksInJdForCsvLinks,
    notUploadedLinksList: notUploadedLinks.map(l => ({
      company: l.company,
      title: l.title,
      taskCount: l.taskCount,
      url: l.jobUrl,
    })),
  };

  import('fs').then(fs => {
    const outPath = resolve(process.cwd(), 'backend/scripts/csv_links_exact_stats.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log('\nSaved full stats to backend/scripts/csv_links_exact_stats.json');
  });
}

analyze().catch(console.error);
