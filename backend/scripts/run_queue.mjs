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

import '../lib/polyfills.mjs';
import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';
import { runQueueWorkerPool } from '../lib/workerPool.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);

let workers = 1;
const workersIdx = args.indexOf('--workers') !== -1 ? args.indexOf('--workers') : args.indexOf('--concurrency');
if (workersIdx !== -1 && args[workersIdx + 1]) {
  workers = Number(args[workersIdx + 1]) || 1;
}

let maxTasks = Infinity;
const maxTasksIdx = args.indexOf('--max-tasks');
if (maxTasksIdx !== -1 && args[maxTasksIdx + 1]) {
  maxTasks = Number(args[maxTasksIdx + 1]) || Infinity;
}

const caIdx = args.indexOf('--ca');
const caEmails = caIdx !== -1 && args[caIdx + 1] ? args[caIdx + 1].split(',').map((e) => e.trim().toLowerCase()) : null;

// Active CA filtering is enabled by default or with --active-ca-only, unless explicitly overridden with --all-candidates
const activeCaOnly = !args.includes('--all-candidates');

const dryRun = args.includes('--dry-run');
// Only auto-submit if explicitly requested with --confirm-submit; default is to pause at Step 5 Review for CA approval
const confirmSubmit = args.includes('--confirm-submit');
// Default to headless mode unless --headful is explicitly specified
const isHeadless = !args.includes('--headful');

await runQueueWorkerPool({
  concurrency: workers,
  headless: isHeadless,
  confirmSubmit,
  dryRun,
  defaultPassword: process.env.WORKDAY_PASSWORD || '',
  activeCaOnly,
  caEmails,
  maxTasks,
});
