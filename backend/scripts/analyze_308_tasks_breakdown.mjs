import { readFileSync, existsSync } from 'fs';
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

async function run() {
  const raw = readFileSync(targetPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const csvMap = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 4) continue;
    const company = parts[1]?.trim();
    const title = parts[2]?.trim();
    const jobUrl = parts[3]?.trim();
    const taskCount = parseInt(parts[4], 10) || 0;
    const awlRaw = parts[5] || '';
    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

    const normKey = normalizeUrlKey(jobUrl);
    const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map(m => m[1].toUpperCase());

    if (!csvMap.has(normKey)) {
      csvMap.set(normKey, {
        company,
        title,
        jobUrl,
        normKey,
        taskCount,
        awlIds: new Set(awlMatches),
      });
    } else {
      const existing = csvMap.get(normKey);
      if (taskCount > existing.taskCount) existing.taskCount = taskCount;
      awlMatches.forEach(a => existing.awlIds.add(a));
    }
  }

  const [bqRows, jdRows, scanRows, failRows] = await Promise.all([
    fetchAll('batch_job_queue', 'id, job_url, company, role_title, status, created_at, applywizz_id'),
    fetchAll('job_distributions', 'id, job_url, applywizz_id, status, is_fully_answered, unanswered_count'),
    fetchAll('scanned_jobs', 'id, job_url, scan_status'),
    fetchAll('failed_jobs', 'id, job_url, failure_reason, failed_at_step'),
  ]);

  const bqMap = new Map();
  bqRows.forEach(r => { if (r.job_url) bqMap.set(normalizeUrlKey(r.job_url), r); });

  const jdMap = new Map();
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

  // Filter down strictly to the 123 uploaded links
  const uploaded123 = [];
  for (const [normKey, rec] of csvMap.entries()) {
    if (bqMap.has(normKey)) {
      uploaded123.push({
        ...rec,
        bq: bqMap.get(normKey),
        scanned: scanMap.get(normKey) || null,
        failed: failMap.get(normKey) || null,
        distributions: jdMap.get(normKey) || [],
      });
    }
  }

  console.log(`Found exactly ${uploaded123.length} uploaded links.`);
  const totalTasks = uploaded123.reduce((acc, l) => acc + l.taskCount, 0);
  console.log(`Total tasks represented by these 123 links (from CSV task_count): ${totalTasks}\n`);

  // We want to analyze these 308 tasks across different dimensions:
  // Dimension 1: Based on the link's scanning lifecycle
  // A link is either:
  // - Scanned successfully (present in scanned_jobs or status already_scanned / already_reached_review)
  // - Scanning Failed / Expired (present in failed_jobs or status expired / already_expired)
  // - Not scanned yet / Pending (status pending or scanning)

  let scannedLinksCount = 0;
  let scannedTasksCount = 0;

  let failedExpiredLinksCount = 0;
  let failedExpiredTasksCount = 0;

  let pendingNotScannedLinksCount = 0;
  let pendingNotScannedTasksCount = 0;

  for (const item of uploaded123) {
    const isFailed = item.failed !== null || item.bq.status === 'expired' || item.bq.status === 'already_expired';
    const isScanned = item.scanned !== null || item.bq.status === 'already_scanned' || item.bq.status === 'already_reached_review';
    const isPending = item.bq.status === 'pending' || item.bq.status === 'scanning';

    if (isFailed) {
      failedExpiredLinksCount++;
      failedExpiredTasksCount += item.taskCount;
    } else if (isScanned) {
      scannedLinksCount++;
      scannedTasksCount += item.taskCount;
    } else if (isPending) {
      pendingNotScannedLinksCount++;
      pendingNotScannedTasksCount += item.taskCount;
    } else {
      console.log('Other status:', item.bq.status, item.taskCount);
    }
  }

  console.log('--- 1. SCANNING LIFECYCLE OF THE 308 TASKS (123 LINKS) ---');
  console.log(`Scanned Successfully:`);
  console.log(`  - Links: ${scannedLinksCount}`);
  console.log(`  - Tasks: ${scannedTasksCount}`);
  console.log(`Scanning Failed / Expired:`);
  console.log(`  - Links: ${failedExpiredLinksCount}`);
  console.log(`  - Tasks: ${failedExpiredTasksCount}`);
  console.log(`Not Scanned Yet / Pending:`);
  console.log(`  - Links: ${pendingNotScannedLinksCount}`);
  console.log(`  - Tasks: ${pendingNotScannedTasksCount}`);
  console.log(`Check sum: ${scannedTasksCount + failedExpiredTasksCount + pendingNotScannedTasksCount} === ${totalTasks}\n`);

  // Breakdown of failed/expired by exact reason
  console.log('--- 2. FAILED / EXPIRED BREAKDOWN ---');
  const failDetail = {};
  for (const item of uploaded123) {
    const isFailed = item.failed !== null || item.bq.status === 'expired' || item.bq.status === 'already_expired';
    if (isFailed) {
      const reason = item.failed?.failure_reason || item.bq.status || 'unknown';
      if (!failDetail[reason]) failDetail[reason] = { links: 0, tasks: 0 };
      failDetail[reason].links++;
      failDetail[reason].tasks += item.taskCount;
    }
  }
  for (const [r, stats] of Object.entries(failDetail)) {
    console.log(` - ${r}: ${stats.links} links, ${stats.tasks} tasks`);
  }

  // Dimension 2: For the SCANNED links (scannedTasksCount), what happened to the tasks?
  // Let's inspect the actual tasks generated in job_distributions
  console.log('\n--- 3. CANDIDATE TASK OUTCOMES IN job_distributions ---');
  let jdSubmitted = 0;
  let jdReadyReview = 0;
  let jdNeedsAnswers = 0;
  let jdFailed = 0;
  let jdOther = 0;

  for (const item of uploaded123) {
    for (const d of item.distributions) {
      if (d.status === 'submitted') jdSubmitted++;
      else if (d.status === 'ready_for_review') jdReadyReview++;
      else if (d.status === 'needs_answers') jdNeedsAnswers++;
      else if (d.status === 'failed') jdFailed++;
      else {
        jdOther++;
        console.log('JD other status:', d.status);
      }
    }
  }

  console.log(`Tasks recorded in job_distributions:`);
  console.log(` - Submitted: ${jdSubmitted}`);
  console.log(` - Ready for Review: ${jdReadyReview}`);
  console.log(` - Needs Answers: ${jdNeedsAnswers}`);
  console.log(` - Failed: ${jdFailed}`);
  console.log(` - Total in job_distributions: ${jdSubmitted + jdReadyReview + jdNeedsAnswers + jdFailed + jdOther}`);

  // Let's also check: For the 123 links, what is the CSV task_count vs job_distributions count?
  // Why did some scanned links have e.g. 2 tasks in CSV and 2 in JD?
  let totalJdTasks = uploaded123.reduce((acc, l) => acc + l.distributions.length, 0);
  console.log(`\nNote on task counts:`);
  console.log(`- In CSV, the 123 uploaded links had total task_count = ${totalTasks}`);
  console.log(`- For the ${scannedLinksCount} scanned links, CSV task_count = ${scannedTasksCount}`);
  console.log(`- In job_distributions table, there are ${totalJdTasks} candidate tasks for these scanned links.`);
}

run().catch(console.error);
