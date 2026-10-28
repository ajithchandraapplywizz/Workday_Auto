import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
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
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`🚀 INGESTING EXACTLY THE FIRST 20 WORKDAY LINKS INTO batch_job_queue`);
  console.log(`   Source: ${targetPath}`);
  console.log(`${'═'.repeat(78)}\n`);

  const raw = readFileSync(targetPath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  console.log(`📄 Total lines in CSV: ${lines.length}`);
  const header = parseCSVLine(lines[0]);
  console.log(`📋 Header: ${JSON.stringify(header)}\n`);

  // We only take the first 20 unique links
  const targetLinks = [];
  const TARGET_LINK_COUNT = 20;

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

    // Check if this link was already collected
    const existing = targetLinks.find(item => item.jobUrl === rawJobUrl);
    if (!existing) {
      if (targetLinks.length >= TARGET_LINK_COUNT) break; // Reached exactly 20 unique links!

      targetLinks.push({
        index: targetLinks.length + 1,
        linkId: `LINK-${String(targetLinks.length + 1).padStart(3, '0')}`,
        jobId,
        company: parseCompany(rawJobUrl, companyName),
        roleTitle: parseRole(rawJobUrl),
        jobUrl: rawJobUrl,
        clientIds: new Set(clientIds),
      });
    } else {
      for (const cid of clientIds) {
        existing.clientIds.add(cid);
      }
    }
  }

  console.log(`🔗 Successfully isolated first ${targetLinks.length} unique links from CSV.\n`);

  // Store each unique link as EXACTLY 1 row, with all client AWL IDs in a single cell
  const taskRows = [];
  const now = new Date().toISOString();

  for (const item of targetLinks) {
    const allClientIds = Array.from(item.clientIds);
    taskRows.push({
      applywizz_id: allClientIds.join(', '),
      job_url: item.jobUrl,
      company: item.company,
      role_title: item.roleTitle,
      job_id: item.jobId,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
  }

  console.log(`👥 Total Unique Link Rows to Insert: ${taskRows.length} (Each containing all candidate AWL IDs in a single cell)`);

  // Clean batch_job_queue first to guarantee ONLY these 20 unique links exist
  console.log(`🧹 Clearing previous records from batch_job_queue...`);
  await supabase.from('batch_job_queue').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Insert exactly 20 unique link rows
  let insertedCount = 0;
  let errorCount = 0;

  for (const row of taskRows) {
    const { data, error } = await supabase
      .from('batch_job_queue')
      .insert([row])
      .select('id');

    if (error) {
      console.error(`❌ Insert error for ${row.company}:`, error.message);
      errorCount++;
    } else {
      insertedCount += (data ? data.length : 1);
    }
  }

  console.log(`\n\n${'═'.repeat(78)}`);
  console.log(`🎉 UPLOAD COMPLETE:`);
  console.log(`   Unique Links Uploaded: ${insertedCount} rows (1 row per link)`);
  console.log(`   Candidates per link:   All AWL IDs combined into single 'applywizz_id' cell`);
  console.log(`   Errors Encountered:    ${errorCount}`);
  console.log(`${'═'.repeat(78)}\n`);

  // Print Detailed Report Table
  console.log(`📋 FIRST 20 LINKS DETAILED REPORT:`);
  console.log(`\n#   │ Link ID  │ Company                        │ Role Title                           │ Tasks  │ Job URL`);
  console.log(`────┼──────────┼────────────────────────────────┼──────────────────────────────────────┼────────┼──────────────────────────────────────────────────`);

  for (const item of targetLinks) {
    const idxStr = String(item.index).padStart(2, ' ');
    const linkIdStr = item.linkId.padEnd(8, ' ');
    const compStr = (item.company || 'Unknown').slice(0, 30).padEnd(30, ' ');
    const roleStr = (item.roleTitle || 'Position').slice(0, 36).padEnd(36, ' ');
    const taskCountStr = `${item.clientIds.size} tasks`.padStart(6, ' ');
    const urlStr = item.jobUrl.slice(0, 50) + '...';
    console.log(`${idxStr} │ ${linkIdStr} │ ${compStr} │ ${roleStr} │ ${taskCountStr} │ ${urlStr}`);
  }
  console.log(`────┴──────────┴────────────────────────────────┴──────────────────────────────────────┴────────┴──────────────────────────────────────────────────\n`);

  // Verify Supabase count
  const { count: finalCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true });

  console.log(`📊 LIVE Supabase batch_job_queue Verified Count: ${finalCount} tasks.`);
}

run().catch((err) => {
  console.error('Fatal error during upload:', err);
  process.exit(1);
});
