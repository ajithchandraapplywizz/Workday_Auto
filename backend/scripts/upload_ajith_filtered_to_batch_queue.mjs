

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

// Resolve CSV file location
const possiblePaths = [
  resolve(process.cwd(), 'data', 'workday links for ajith.csv'),
  resolve(process.cwd(), 'backend', 'data', 'workday links for ajith.csv'),
  resolve(__dirname, '..', 'data', 'workday links for ajith.csv'),
  resolve(__dirname, '..', '..', 'data', 'workday links for ajith.csv'),
];

const csvPath = possiblePaths.find((p) => existsSync(p));
if (!csvPath) {
  console.error('❌ CSV not found in any expected location:');
  possiblePaths.forEach((p) => console.error(`   - ${p}`));
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

function parseCompany(u) {
  try {
    const urlObj = new URL(u);
    const host = urlObj.hostname.toLowerCase();
    if (host.includes('myworkdaysite.com')) {
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const recruitingIdx = parts.indexOf('recruiting');
      if (recruitingIdx !== -1 && parts[recruitingIdx + 2]) {
        return parts[recruitingIdx + 2];
      }
      if (recruitingIdx !== -1 && parts[recruitingIdx + 1]) {
        return parts[recruitingIdx + 1].toUpperCase();
      }
    }
    const parts = host.split('.');
    return parts[0] || 'Unknown';
  } catch {
    return 'Unknown';
  }
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
    return clean || 'Unknown Position';
  } catch {
    return 'Unknown Position';
  }
}

const raw = readFileSync(csvPath, 'utf8');
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`🚀 WORKDAY LINKS UPLOADER TO SUPABASE (public.batch_job_queue)`);
console.log(`   Source CSV:    ${csvPath}`);
console.log(`   Total Lines:   ${lines.length}`);
console.log(`══════════════════════════════════════════════════════════════════════\n`);

// Aggregate unique clients per unique job_url
const urlToClientsMap = new Map();

for (let i = 1; i < lines.length; i++) {
  const parts = parseCSVLine(lines[i]);
  if (!parts.length || !parts[0]) continue;
  const jobUrl = parts[0].trim();
  const rawIds = parts[1] || '';
  const ids = rawIds
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^AWL-\d+/i.test(s));

  if (!urlToClientsMap.has(jobUrl)) {
    urlToClientsMap.set(jobUrl, new Set());
  }
  const clientSet = urlToClientsMap.get(jobUrl);
  for (const id of ids) {
    clientSet.add(id);
  }
}

console.log(`📊 Aggregated ${urlToClientsMap.size} unique job links across CSV.`);

// Filter ONLY links with > 5 clients
const qualifyingLinks = [];
let skippedLinksCount = 0;

for (const [jobUrl, clientSet] of urlToClientsMap.entries()) {
  const clientCount = clientSet.size;
  if (clientCount > 5) {
    qualifyingLinks.push({
      jobUrl,
      clientCount,
      clientIds: Array.from(clientSet),
      company: parseCompany(jobUrl),
      roleTitle: parseRole(jobUrl),
    });
  } else {
    skippedLinksCount++;
  }
}

// Sort descending by client count
qualifyingLinks.sort((a, b) => b.clientCount - a.clientCount);

console.log(`\n✅ Qualifying unique links with > 5 clients: ${qualifyingLinks.length}`);
console.log(`⏭️  Skipped links with <= 5 clients:        ${skippedLinksCount}\n`);

// Prepare tasks for batch ingestion
const allTasks = [];
for (const link of qualifyingLinks) {
  console.log(`  🔗 [${link.clientCount} clients] ${link.company} - "${link.roleTitle}"`);
  console.log(`     ${link.jobUrl}`);
  for (const clientId of link.clientIds) {
    allTasks.push({
      applywizz_id: clientId,
      job_url: link.jobUrl,
      company: link.company,
      role_title: link.roleTitle,
    });
  }
}

console.log(`\n📋 Total unique (applywizz_id, job_url) tasks to upload: ${allTasks.length}`);
console.log(`⏳ Uploading to public.batch_job_queue in batches...\n`);

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
