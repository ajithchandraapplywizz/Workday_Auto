import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase credentials missing from .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const __dirname = dirname(fileURLToPath(import.meta.url));

const targetPath = resolve(process.cwd(), 'Data', 'workday_jobs_202610261247.csv');
if (!existsSync(targetPath)) {
  console.error(`❌ CSV not found at: ${targetPath}`);
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

function parseCompany(u, defaultComp) {
  if (defaultComp && defaultComp !== 'Unknown' && defaultComp !== 'Workday Company') {
    return defaultComp;
  }
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
    return parts[0] || defaultComp || 'Workday Company';
  } catch {
    return defaultComp || 'Workday Company';
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
    return clean || 'Workday Position';
  } catch {
    return 'Workday Position';
  }
}

async function run() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🚀 INGESTING 197 WORKDAY LINKS INTO batch_job_queue`);
  console.log(`   Source: ${targetPath}`);
  console.log(`${'═'.repeat(72)}\n`);

  const raw = readFileSync(targetPath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  console.log(`📄 Total lines in CSV: ${lines.length}`);
  const header = parseCSVLine(lines[0]);
  console.log(`📋 Header: ${JSON.stringify(header)}`);

  const uniqueLinks = new Map();
  let totalRawPairs = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length || !parts[2]) continue;

    const jobId = parts[0] ? String(parts[0]).trim() : null;
    const companyName = parts[1] ? String(parts[1]).trim() : '';
    const rawJobUrl = parts[2] ? String(parts[2]).trim() : '';
    const awlCol = parts[4] || '';

    if (!rawJobUrl || !rawJobUrl.startsWith('http')) continue;

    // Extract all AWL IDs in the AWL IDs column
    const awlMatches = awlCol.match(/AWL[-_]?\d+/gi) || [];
    const clientIds = Array.from(new Set(awlMatches.map((id) => id.toUpperCase().trim())));

    if (!uniqueLinks.has(rawJobUrl)) {
      uniqueLinks.set(rawJobUrl, {
        jobId,
        company: parseCompany(rawJobUrl, companyName),
        roleTitle: parseRole(rawJobUrl),
        jobUrl: rawJobUrl,
        clientIds: new Set(),
      });
    }

    const entry = uniqueLinks.get(rawJobUrl);
    for (const cid of clientIds) {
      entry.clientIds.add(cid);
      totalRawPairs++;
    }
  }

  console.log(`\n🔗 Unique Job Links found: ${uniqueLinks.size}`);
  console.log(`👥 Total Candidate Application Tasks: ${totalRawPairs}`);

  // Flatten into distinct batch_job_queue rows
  const taskRows = [];
  const seenPair = new Set();
  const now = new Date().toISOString();

  for (const [url, info] of uniqueLinks.entries()) {
    for (const clientId of info.clientIds) {
      const pairKey = `${clientId}::${url}`;
      if (!seenPair.has(pairKey)) {
        seenPair.add(pairKey);
        taskRows.push({
          applywizz_id: clientId,
          job_url: url,
          company: info.company,
          role_title: info.roleTitle,
          job_id: info.jobId,
          status: 'pending',
          created_at: now,
          updated_at: now,
        });
      }
    }
  }

  console.log(`✅ Unique (applywizz_id, job_url) tasks to insert: ${taskRows.length}\n`);

  // Insert into batch_job_queue in batches of 100
  const BATCH_SIZE = 100;
  let insertedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < taskRows.length; i += BATCH_SIZE) {
    const chunk = taskRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from('batch_job_queue')
      .upsert(chunk, {
        onConflict: 'applywizz_id,job_url',
        ignoreDuplicates: false,
      })
      .select('id');

    if (error) {
      console.error(`❌ Batch error [${i} - ${i + chunk.length}]:`, error.message);
      errorCount += chunk.length;
    } else {
      insertedCount += (data ? data.length : chunk.length);
      process.stdout.write(`⏳ Uploaded ${insertedCount} / ${taskRows.length} tasks...\r`);
    }
  }

  console.log(`\n\n${'═'.repeat(72)}`);
  console.log(`🎉 INGESTION SUMMARY:`);
  console.log(`   Unique Links:     ${uniqueLinks.size}`);
  console.log(`   Tasks Uploaded:   ${insertedCount}`);
  console.log(`   Errors Encountered: ${errorCount}`);
  console.log(`${'═'.repeat(72)}\n`);

  // Verify total count in Supabase batch_job_queue
  const { count: pendingCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  const { count: totalQueueCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true });

  console.log(`📊 LIVE Supabase batch_job_queue Status:`);
  console.log(`   Pending Tasks in Queue: ${pendingCount}`);
  console.log(`   Total Tasks in Queue:   ${totalQueueCount}`);
}

run().catch((err) => {
  console.error('Fatal error during upload:', err);
  process.exit(1);
});
