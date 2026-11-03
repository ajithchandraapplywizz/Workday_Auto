/**
 * ingest_wd_jobs_json.mjs
 *
 * Ingests Workday jobs CSV into public.batch_job_queue with 1 row per unique job link.
 * All AWL IDs for that link are aggregated into a single cell in JSON format:
 *   - applywizz_id: JSON.stringify(awlList)  (e.g. '["AWL-1568","AWL-25663"]')
 *   - client_ids: awlList                   (JSONB array)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  loadLocalEnvOnce,
  isSupabaseConfigured,
  request,
} from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

const csvPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(process.cwd(), 'Data', 'wd_jobs_202611031652.csv');

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

function parseRole(u, fallback = '') {
  if (fallback && fallback.trim().length > 2) return fallback.trim();
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
    return fallback || 'Unknown Position';
  }
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🚀 INGESTING WORKDAY CSV TO SUPABASE (public.batch_job_queue)`);
  console.log(`   Source:   ${csvPath}`);
  console.log(`   Format:   1 row per unique link, all AWL IDs in JSON array cell`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`📁 Loaded ${lines.length} lines from CSV.`);

  const linkMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (!parts.length) continue;

    const company = parts[1] || '';
    const roleTitle = parts[2] || '';
    const jobUrl = parts[3] || '';
    const rawAwl = parts[6] || parts[5] || '';

    if (!jobUrl || !jobUrl.startsWith('http')) continue;

    const awlMatches = [...rawAwl.matchAll(/AWL[-_]?\d+/gi)].map((m) => m[0].toUpperCase());

    const cleanCompany = company
      .replace(/â€“/g, ' - ')
      .replace(/[â€œâ€\?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const cleanRole = roleTitle
      .replace(/â€“/g, ' - ')
      .replace(/[â€œâ€\?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!linkMap.has(jobUrl)) {
      linkMap.set(jobUrl, {
        company: cleanCompany,
        role_title: parseRole(jobUrl, cleanRole),
        job_url: jobUrl.trim(),
        awlSet: new Set(),
      });
    }

    const entry = linkMap.get(jobUrl);
    for (const awl of awlMatches) {
      entry.awlSet.add(awl);
    }
  }

  console.log(`📊 Aggregated ${linkMap.size} unique job links from CSV.`);

  const now = new Date().toISOString();
  let totalCandidatesCount = 0;

  const rows = [];
  for (const [jobUrl, data] of linkMap.entries()) {
    const awlArray = Array.from(data.awlSet);
    totalCandidatesCount += awlArray.length;

    rows.push({
      job_url: jobUrl,
      company: data.company || 'Workday Tenant',
      role_title: data.role_title || 'Unknown Position',
      // JSON format in a single cell:
      applywizz_id: JSON.stringify(awlArray),
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
  }

  console.log(`👥 Total Candidate Applications across all links: ${totalCandidatesCount}`);
  console.log(`📋 Total Distinct Rows to Ingest into batch_job_queue: ${rows.length}\n`);

  // Sample row preview
  if (rows.length > 0) {
    console.log('--- SAMPLE ROW PREVIEW (Row 1) ---');
    console.log('job_url:     ', rows[0].job_url);
    console.log('company:     ', rows[0].company);
    console.log('role_title:  ', rows[0].role_title);
    console.log('candidates count:              ', JSON.parse(rows[0].applywizz_id).length, 'candidates');
    console.log('----------------------------------\n');
  }

  // Upload in chunks to batch_job_queue
  const CHUNK_SIZE = 50;
  let totalInserted = 0;
  let errorCount = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      await request('batch_job_queue', {
        method: 'POST',
        prefer: 'return=minimal',
        body: chunk,
      });
      totalInserted += chunk.length;
      process.stdout.write(`  ⏳ Ingested ${totalInserted} / ${rows.length} unique links...\r`);
    } catch (err) {
      errorCount++;
      console.error(`\n  ⚠️ Ingestion error at chunk ${Math.floor(i / CHUNK_SIZE) + 1}:`, err?.message?.slice(0, 160));
    }
  }

  console.log(`\n\n🎉 INGESTION COMPLETE!`);
  console.log(`   Total Unique Links Ingested: ${totalInserted} / ${rows.length}`);
  console.log(`   Candidate Applications Mapped: ${totalCandidatesCount}`);
  console.log(`   Status: All rows set to 'pending' in public.batch_job_queue\n`);
}

main().catch((err) => {
  console.error('Fatal error during CSV ingestion:', err);
  process.exit(1);
});
