import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'backend/.env' });

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
  console.log(`🚀 INGESTING EXACTLY THE FIRST 10 WORKDAY LINKS INTO batch_job_queue`);
  console.log(`   Source: ${targetPath}`);
  console.log(`${'═'.repeat(78)}\n`);

  const raw = readFileSync(targetPath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const targetLinks = [];
  const TARGET_LINK_COUNT = 10; // EXACTLY 10 LINKS

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length || !parts[2]) continue;

    const jobId = parts[0] ? String(parts[0]).trim() : null;
    const companyName = parts[1] ? String(parts[1]).trim() : '';
    const rawJobUrl = parts[2] ? String(parts[2]).trim() : '';
    const awlCol = parts[4] || '';

    if (!rawJobUrl || !rawJobUrl.startsWith('http')) continue;

    const awlMatches = awlCol.match(/AWL[-_]?\d+/gi) || [];
    const clientIds = Array.from(new Set(awlMatches.map((id) => id.toUpperCase().trim())));

    const existing = targetLinks.find((item) => item.jobUrl === rawJobUrl);
    if (!existing) {
      if (targetLinks.length >= TARGET_LINK_COUNT) break; // Reached exactly 10 unique links!

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

  console.log(`🔗 Successfully isolated exactly ${targetLinks.length} unique links from CSV.\n`);

  const now = new Date().toISOString();
  const taskRows = targetLinks.map((item) => ({
    applywizz_id: Array.from(item.clientIds).join(', '),
    job_url: item.jobUrl,
    company: item.company,
    role_title: item.roleTitle,
    job_id: item.jobId,
    status: 'pending',
    created_at: now,
    updated_at: now,
  }));

  console.log(`🧹 Clearing any previous records from batch_job_queue...`);
  await supabase.from('batch_job_queue').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log(`📥 Inserting exactly 10 unique link rows into batch_job_queue...`);
  const { data, error } = await supabase.from('batch_job_queue').insert(taskRows).select('id, company, role_title, job_url, applywizz_id');

  if (error) {
    console.error('❌ Insert error:', error.message);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`🎉 UPLOAD COMPLETE: Exactly ${data.length} Unique Link Rows in batch_job_queue`);
  console.log(`${'═'.repeat(78)}\n`);

  data.forEach((r, idx) => {
    const clientsCount = r.applywizz_id.split(',').length;
    console.log(`${String(idx + 1).padStart(2, ' ')}. [${r.company}] ${r.role_title} (${clientsCount} clients in single cell)`);
    console.log(`    URL: ${r.job_url}`);
  });

  const { count } = await supabase.from('batch_job_queue').select('*', { count: 'exact', head: true });
  console.log(`\n📊 Verified live count in batch_job_queue: ${count} rows.`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
