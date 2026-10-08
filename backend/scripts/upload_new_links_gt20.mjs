/**
 * upload_new_links_gt20.mjs
 *
 * Ingests "data/workday_jobs_created_as_tasks_202610081421_New_Links.csv" into Supabase `public.batch_job_queue`,
 * filtering ONLY unique job links where the client count is strictly GREATER THAN 20 (> 20).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadLocalEnvOnce,
  isSupabaseConfigured,
  ingestCsvToBatchQueue,
  getBatchQueueStats,
} from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const possiblePaths = [
  resolve(process.cwd(), 'data', 'workday_jobs_created_as_tasks_202610081421_New_Links.csv'),
  resolve(process.cwd(), 'backend', 'data', 'workday_jobs_created_as_tasks_202610081421_New_Links.csv'),
  resolve(__dirname, '..', 'data', 'workday_jobs_created_as_tasks_202610081421_New_Links.csv'),
  resolve(__dirname, '..', '..', 'data', 'workday_jobs_created_as_tasks_202610081421_New_Links.csv'),
];

const targetCsvPath = possiblePaths.find((p) => existsSync(p));
if (!targetCsvPath) {
  console.error(`❌ Target CSV not found at: ${possiblePaths.join(' | ')}`);
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

function extractWorkdayUrl(rawUrl = '') {
  let u = String(rawUrl || '').trim();
  if (!u) return '';
  // Check if it's a redirect wrapper (e.g. recruitics with rx_url)
  if (u.includes('rx_url=')) {
    try {
      const parsed = new URL(u);
      const target = parsed.searchParams.get('rx_url');
      if (target) {
        u = decodeURIComponent(target).split('?')[0];
      }
    } catch {}
  }
  return u;
}

function parseRole(u) {
  try {
    const pathname = new URL(u).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';
    const clean = decodeURIComponent(lastSeg)
      .replace(/_[A-Z0-9-]+$/i, '')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean || 'Position';
  } catch {
    return 'Position';
  }
}

const raw = readFileSync(targetCsvPath, 'utf8');
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`🚀 WORKDAY NEW LINKS UPLOADER TO SUPABASE (public.batch_job_queue)`);
console.log(`   Source CSV:    ${targetCsvPath}`);
console.log(`   Total Rows:    ${lines.length}`);
console.log(`   Filter Rule:   client count > 20`);
console.log(`══════════════════════════════════════════════════════════════════════\n`);

// Header check: ,job_id,company_name,job_url,task_count,AWL IDs
const headerParts = parseCSVLine(lines[0]);
let jobIdIdx = 1;
let companyIdx = 2;
let jobUrlIdx = 3;
let awlIdsIdx = 5;

for (let i = 0; i < headerParts.length; i++) {
  const h = headerParts[i].toLowerCase().trim();
  if (h === 'job_id') jobIdIdx = i;
  else if (h === 'company_name' || h === 'company') companyIdx = i;
  else if (h === 'job_url' || h === 'url') jobUrlIdx = i;
  else if (h.includes('awl')) awlIdsIdx = i;
}

// Map: cleanJobUrl -> { jobId, company, jobUrl, roleTitle, clientSet }
const linkMap = new Map();

for (let i = 1; i < lines.length; i++) {
  const parts = parseCSVLine(lines[i]);
  if (!parts.length) continue;
  const rawUrl = parts[jobUrlIdx] || '';
  const cleanUrl = extractWorkdayUrl(rawUrl);
  if (!cleanUrl || !cleanUrl.includes('myworkday')) continue;

  const jobId = parts[jobIdIdx] ? String(parts[jobIdIdx]).trim() : null;
  const company = parts[companyIdx] ? String(parts[companyIdx]).trim() : 'Workday Company';
  const rawAwl = parts[awlIdsIdx] || '';

  const ids = rawAwl
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^AWL-\d+/i.test(s));

  if (!linkMap.has(cleanUrl)) {
    linkMap.set(cleanUrl, {
      jobId,
      company,
      jobUrl: cleanUrl,
      roleTitle: parseRole(cleanUrl),
      clientSet: new Set(),
    });
  }

  const entry = linkMap.get(cleanUrl);
  for (const id of ids) {
    entry.clientSet.add(id);
  }
}

console.log(`📊 Discovered ${linkMap.size} unique Workday job links across CSV.`);

// Filter ONLY links with > 20 clients
const qualifyingLinks = [];
let skippedLinksCount = 0;

for (const entry of linkMap.values()) {
  const count = entry.clientSet.size;
  if (count > 20) {
    qualifyingLinks.push({
      jobId: entry.jobId,
      company: entry.company,
      jobUrl: entry.jobUrl,
      roleTitle: entry.roleTitle,
      clientCount: count,
      clientIds: Array.from(entry.clientSet),
    });
  } else {
    skippedLinksCount++;
  }
}

// Sort descending by client count
qualifyingLinks.sort((a, b) => b.clientCount - a.clientCount);

console.log(`\n✅ Qualifying unique links with > 20 clients: ${qualifyingLinks.length}`);
console.log(`⏭️  Skipped links with <= 20 clients:        ${skippedLinksCount}\n`);

// Prepare all candidate tasks for batch insertion
const allTasks = [];
for (const link of qualifyingLinks) {
  console.log(`  🔗 [${link.clientCount} clients] ${link.company} - "${link.roleTitle}"`);
  console.log(`     ${link.jobUrl}`);
  for (const clientId of link.clientIds) {
    allTasks.push({
      applywizz_id: clientId,
      job_id: link.jobId,
      job_url: link.jobUrl,
      company: link.company,
      role_title: link.roleTitle,
    });
  }
}

console.log(`\n📋 Total unique candidate tasks to upload: ${allTasks.length}`);
console.log(`⏳ Uploading to public.batch_job_queue in batches of 50...\n`);

const uploadResult = await ingestCsvToBatchQueue(allTasks, { chunkSize: 50 });

console.log(`\n🎉 Upload Complete!`);
console.log(`   Tasks successfully ingested: ${uploadResult.inserted} / ${allTasks.length}`);

try {
  const stats = await getBatchQueueStats();
  console.log(`\n📊 Current batch_job_queue status:`);
  console.log(`   Pending:   ${stats.pending ?? 0}`);
  console.log(`   Claimed:   ${stats.claimed ?? 0}`);
  console.log(`   Submitted: ${stats.submitted ?? 0}`);
  console.log(`   Failed:    ${stats.failed ?? 0}`);
  console.log(`   Total:     ${stats.total ?? 0}`);
} catch (e) {
  // stats check optional
}
