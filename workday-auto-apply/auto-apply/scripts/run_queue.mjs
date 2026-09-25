/**
 * run_queue.mjs
 *
 * Runs 10 concurrent workers directly against the Supabase `batch_job_queue` table.
 * Each worker leases a task atomically, fills via Playwright, triggers pre-resolution
 * for shared links, and marks tasks as completed/submitted.
 *
 * Usage:
 *   node scripts/run_queue.mjs [--workers 10] [--dry-run] [--confirm-submit] [--headless]
 *
 * Example:
 *   node scripts/run_queue.mjs --workers 10 --dry-run
 */

import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';
import { runQueueWorkerPool } from '../lib/workerPool.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);

let workers = 10;
const workersIdx = args.indexOf('--workers');
if (workersIdx !== -1 && args[workersIdx + 1]) {
  workers = Number(args[workersIdx + 1]) || 10;
}

const dryRun = args.includes('--dry-run');
const confirmSubmit = args.includes('--confirm-submit');
const isHeadless = args.includes('--headless') || process.env.HEADLESS === 'true';

await runQueueWorkerPool({
  concurrency: workers,
  headless: isHeadless,
  confirmSubmit,
  dryRun,
  defaultPassword: process.env.WORKDAY_PASSWORD || '',
});
