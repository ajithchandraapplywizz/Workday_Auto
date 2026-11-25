import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

async function countStats() {
  // 1. Analyze the Nov 23 CSV
  const csvPath = resolve(homedir(), 'Downloads', 'workday-jobs-2026-11-25.csv');
  const content = readFileSync(csvPath, 'utf8');
  const clean = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const urlMap = new Map();
  let totalRawAwlOccurrences = 0;

  for (let i = 1; i < lines.length; i++) {
    const p = parseCSVLine(lines[i]);
    const jobUrl = p[3]?.trim();
    if (!jobUrl) continue;
    const awlMatches = [...(p[5] || '').matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
    totalRawAwlOccurrences += awlMatches.length;

    const normUrl = normalizeUrl(jobUrl);

    if (!urlMap.has(normUrl)) {
      urlMap.set(normUrl, {
        jobId: p[0],
        company: p[1],
        title: p[2],
        url: jobUrl,
        awlSet: new Set(awlMatches),
      });
    } else {
      const entry = urlMap.get(normUrl);
      for (const a of awlMatches) entry.awlSet.add(a);
    }
  }

  const uniqueLinksCsv = urlMap.size;
  let totalTasksInCsv = 0;
  for (const entry of urlMap.values()) {
    totalTasksInCsv += entry.awlSet.size;
  }

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('📊 NOV 23 CSV UPLOAD BREAKDOWN (workday-jobs-2026-11-23.csv)');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`- Raw Data Rows in CSV:          ${lines.length - 1}`);
  console.log(`- Unique Job Links in CSV:       ${uniqueLinksCsv}`);
  console.log(`- Total Candidate Tasks in CSV:  ${totalTasksInCsv}`);
  console.log(`- Raw AWL mentions (with dupes): ${totalRawAwlOccurrences}`);

  // 2. Query Supabase batch_job_queue
  console.log('\n🔍 Fetching batch_job_queue records from Supabase...');
  const allRows = [];
  const PAGE_SIZE = 1000;
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('batch_job_queue')
      .select('id, job_url, applywizz_id, status, created_at')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) {
      console.error('Fetch error:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  const uniqueQueueUrls = new Set(allRows.map((r) => normalizeUrl(r.job_url || '')));

  let totalTasksInEntireQueue = 0;
  const statusTasks = {};
  const statusLinks = {};

  for (const r of allRows) {
    let count = 0;
    try {
      const parsed = JSON.parse(r.applywizz_id);
      count = Array.isArray(parsed) ? parsed.length : 1;
    } catch {
      count = 1;
    }
    totalTasksInEntireQueue += count;
    statusTasks[r.status] = (statusTasks[r.status] || 0) + count;
    statusLinks[r.status] = (statusLinks[r.status] || 0) + 1;
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('🌐 ENTIRE BATCH_JOB_QUEUE IN SUPABASE (COMPLETE DATABASE STATE)');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`- Total Queue Rows (Unique Links):  ${allRows.length}`);
  console.log(`- Unique Normalized URLs:           ${uniqueQueueUrls.size}`);
  console.log(`- Total Candidate Tasks (All AWLs): ${totalTasksInEntireQueue}`);
  console.log('\nBreakdown by Link Status:');
  for (const [st, numLinks] of Object.entries(statusLinks)) {
    const numTasks = statusTasks[st] || 0;
    console.log(`  • ${st.padEnd(16)}: ${String(numLinks).padStart(4)} links  |  ${String(numTasks).padStart(5)} candidate tasks`);
  }

  // Specifically for the 66 newly uploaded CSV rows in DB
  const csvUrlSet = new Set(Array.from(urlMap.keys()));
  const uploadedInDb = allRows.filter((r) => csvUrlSet.has(normalizeUrl(r.job_url || '')));
  let uploadedTasksInDb = 0;
  for (const r of uploadedInDb) {
    try {
      const parsed = JSON.parse(r.applywizz_id);
      uploadedTasksInDb += Array.isArray(parsed) ? parsed.length : 1;
    } catch {
      uploadedTasksInDb += 1;
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('✅ VERIFICATION OF NEWLY UPLOADED CSV DATA IN SUPABASE');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`- Uploaded Unique Links in DB:       ${uploadedInDb.length}`);
  console.log(`- Uploaded Candidate Tasks in DB:    ${uploadedTasksInDb}`);
}

countStats().catch(console.error);
