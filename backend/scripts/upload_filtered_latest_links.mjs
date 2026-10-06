import fs from 'fs';
import { resolve } from 'path';
import {
  loadLocalEnvOnce,
  isSupabaseConfigured,
  ingestCsvToBatchQueue,
} from '../lib/supabaseClient.mjs';
import { extractWorkdayCompanyName } from '../lib/discovery.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const csvPath = resolve(process.cwd(), 'data/workday links for ajith.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`❌ CSV file not found: ${csvPath}`);
  process.exit(1);
}

console.log(`\n======================================================================`);
console.log(`🚀 UPLOADING FILTERED LATEST LINKS (> 5 CLIENTS ONLY)`);
console.log(`   Source: ${csvPath}`);
console.log(`======================================================================\n`);

const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split(/\r?\n/).filter(Boolean);

function parseCsvLine(line) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

function extractMeta(url) {
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split('/').filter(Boolean);
    const lastPart = decodeURIComponent(pathParts[pathParts.length - 1] || '');
    let role = lastPart;
    let jobId = null;
    const lastUnderscore = lastPart.lastIndexOf('_');
    if (lastUnderscore > 0) {
      role = lastPart.slice(0, lastUnderscore);
      jobId = lastPart.slice(lastUnderscore + 1);
    }
    const cleanRole = role.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    let company = extractWorkdayCompanyName(url);
    if (u.hostname.includes('myworkdaysite.com')) {
      const siteMatch = u.pathname.match(/recruiting\/[^\/]+\/([^\/]+)/i);
      if (siteMatch) company = siteMatch[1];
    }
    return { company, roleTitle: cleanRole, jobId };
  } catch {
    return { company: 'Workday Employer', roleTitle: 'Position', jobId: null };
  }
}

// 1. Group clients by job_url across all CSV rows
const urlMap = new Map();

for (let i = 1; i < lines.length; i++) {
  const [jobUrl, awlIdsStr] = parseCsvLine(lines[i]);
  if (!jobUrl || !awlIdsStr) continue;
  const cleanUrl = jobUrl.trim().replace(/^["']|["']$/g, '');
  const awlIds = awlIdsStr
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toUpperCase())
    .filter(Boolean);

  if (!urlMap.has(cleanUrl)) {
    urlMap.set(cleanUrl, new Set());
  }
  const clientSet = urlMap.get(cleanUrl);
  for (const id of awlIds) {
    clientSet.add(id);
  }
}

// 2. Filter: ONLY links that appear for MORE THAN 5 clients (> 5)
const eligibleJobs = [];
const skippedJobs = [];

for (const [url, clientSet] of urlMap.entries()) {
  const count = clientSet.size;
  const meta = extractMeta(url);
  const item = {
    url,
    count,
    clients: Array.from(clientSet),
    ...meta,
  };

  if (count > 5) {
    eligibleJobs.push(item);
  } else {
    skippedJobs.push(item);
  }
}

// Sort descending by client count
eligibleJobs.sort((a, b) => b.count - a.count);

console.log(`📊 Filter Results:`);
console.log(`   • Total unique links in CSV: ${urlMap.size}`);
console.log(`   • Links with > 5 clients (ELIGIBLE): ${eligibleJobs.length}`);
console.log(`   • Links with <= 5 clients (SKIPPED):  ${skippedJobs.length}\n`);

console.log(`📋 Eligible Job Links to Upload:`);
let totalTaskRows = 0;
eligibleJobs.forEach((j, idx) => {
  totalTaskRows += j.count;
  console.log(`  ${idx + 1}. [${j.count} clients] ${j.company} | ${j.roleTitle} (${j.jobId || 'N/A'})`);
  console.log(`     Link: ${j.url}`);
});

console.log(`\n🚫 Skipped Job Links (<= 5 clients):`);
skippedJobs.forEach((j, idx) => {
  console.log(`  ${idx + 1}. [${j.count} clients] ${j.company} | ${j.roleTitle} | ${j.url}`);
});

// 3. Prepare task items for batch upload
const allTasks = [];
for (const job of eligibleJobs) {
  for (const awlId of job.clients) {
    allTasks.push({
      applywizz_id: awlId,
      job_url: job.url,
      company: job.company,
      role_title: job.roleTitle,
      job_id: job.jobId,
      status: 'pending',
    });
  }
}

console.log(`\n⏳ Ingesting ${allTasks.length} tasks into batch_job_queue...`);

const result = await ingestCsvToBatchQueue(allTasks, { chunkSize: 50 });

// Ensure job_id and role_title are synced on all matching rows
const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const job of eligibleJobs) {
  if (job.jobId) {
    await fetch(`${sbUrl}/rest/v1/batch_job_queue?job_url=eq.${encodeURIComponent(job.url)}`, {
      method: 'PATCH',
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: job.jobId,
        role_title: job.roleTitle,
        company: job.company,
      }),
    }).catch(() => {});
  }
}

console.log(`\n======================================================================`);
console.log(`✅ UPLOAD COMPLETE!`);
console.log(`   • Total client tasks active in batch_job_queue: ${allTasks.length}`);
console.log(`   • Unique job links uploaded: ${eligibleJobs.length}`);
console.log(`======================================================================\n`);
