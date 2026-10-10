
import { resolve } from 'path';
import { existsSync } from 'fs';
import { loadLocalEnvOnce, ingestCsvToBatchQueue, getBatchQueueStats, isSupabaseConfigured } from '../lib/supabaseClient.mjs';
import { readClientJobsCsvFile } from '../lib/csvJobParser.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const csvArg = args.find((a) => !a.startsWith('--'));

let minClients = 1;
const minClientsIdx = args.indexOf('--min-clients');
if (minClientsIdx !== -1 && args[minClientsIdx + 1]) {
  minClients = Number(args[minClientsIdx + 1]) || 30;
}

if (!csvArg) {
  console.log(`
Usage:
  node scripts/upload_csv_to_supabase.mjs <path-to-csv> [--min-clients 30]

Example:
  node scripts/upload_csv_to_supabase.mjs data/clients_jobs.csv --min-clients 30
`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(process.cwd(), csvArg),
  resolve(process.cwd(), 'backend', csvArg),
  resolve(scriptDir, '..', csvArg),
];
const fullPath = candidates.find((c) => existsSync(c)) || resolve(process.cwd(), csvArg);
if (!existsSync(fullPath)) {
  console.error(`❌ CSV file not found: ${fullPath}`);
  process.exit(1);
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`🚀 SUPABASE CSV BATCH UPLOADER`);
console.log(`   File: ${fullPath}`);
if (minClients > 1) {
  console.log(`   Filter: Only job links matching at least ${minClients} candidates`);
}
console.log(`${'═'.repeat(70)}\n`);

const tasks = await readClientJobsCsvFile(fullPath, { minClients });

if (!tasks.length) {
  console.error(`❌ No valid tasks found in ${csvArg}${minClients > 1 ? ` that match >= ${minClients} clients per link` : ''}.`);
  process.exit(1);
}

// Group links for telemetry
const urlMap = new Map();
for (const t of tasks) {
  const count = urlMap.get(t.jobUrl) || 0;
  urlMap.set(t.jobUrl, count + 1);
}

console.log(`📊 Parsed ${tasks.length} client application tasks across ${urlMap.size} unique job links:`);
let rank = 1;
for (const [url, count] of [...urlMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`   ${rank++}. ${count} candidates → ${url.slice(0, 90)}...`);
}
if (urlMap.size > 5) {
  console.log(`   ...and ${urlMap.size - 5} more job links.`);
}

console.log(`\n⏳ Ingesting ${tasks.length} rows to Supabase table \`batch_job_queue\` in chunked batches...`);

const startTime = Date.now();
const res = await ingestCsvToBatchQueue(tasks, { chunkSize: 250 });
const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

console.log(`\n✅ Upload complete in ${elapsedSec}s!`);
console.log(`   Total Tasks Ingested: ${res.inserted}/${tasks.length}`);

const stats = await getBatchQueueStats();
if (stats) {
  console.log(`\n📋 Current batch_job_queue status:`);
  console.log(`   Pending:      ${stats.pending}`);
  console.log(`   Pre-resolved: ${stats.pre_resolved}`);
  console.log(`   Processing:   ${stats.processing}`);
  console.log(`   Submitted:    ${stats.submitted}`);
  console.log(`   Total in DB:  ${stats.total}\n`);
}

console.log(`⚡ You can now start the 10-worker pool:`);
console.log(`   node cli.mjs run-queue --workers 10 --dry-run`);
console.log(`   node scripts/run_queue.mjs --workers 10\n`);
