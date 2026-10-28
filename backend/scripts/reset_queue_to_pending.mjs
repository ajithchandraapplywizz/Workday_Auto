/**
 * reset_queue_to_pending.mjs
 *
 * Resets all jobs in `batch_job_queue` to `status: 'pending'`
 * and clears worker locks (`worker_id: null`, `locked_at: null`, `attempt_count: 0`).
 * This ensures the automation scanner will start fresh from the very first link.
 */

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

async function run() {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`🔄 RESETTING ALL BATCH_JOB_QUEUE ROWS TO PENDING`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  const now = new Date().toISOString();

  // 1. Update all rows in batch_job_queue to pending
  const { data, error, count } = await supabase
    .from('batch_job_queue')
    .update({
      status: 'pending',
      worker_id: null,
      locked_at: null,
      attempt_count: 0,
      updated_at: now,
    })
    .neq('id', '00000000-0000-0000-0000-000000000000') // matches all rows
    .select('id', { count: 'exact' });

  if (error) {
    console.error('❌ Error resetting batch_job_queue:', error.message);
  } else {
    console.log(`✅ Successfully reset ${count || data?.length || 'all'} tasks in batch_job_queue to "pending"!`);
  }

  // 2. Clear or reset scanned_jobs so links aren't marked as already completed for the next run
  const { count: scannedCount, error: scannedErr } = await supabase
    .from('scanned_jobs')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (!scannedErr) {
    console.log(`🧹 Cleared previous scan records from scanned_jobs table.`);
  }

  // 3. Verify final counts
  const { count: pendingCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  const { count: totalCount } = await supabase
    .from('batch_job_queue')
    .select('id', { count: 'exact', head: true });

  console.log(`\n📊 Current batch_job_queue status:`);
  console.log(`   Pending Tasks: ${pendingCount}`);
  console.log(`   Total Tasks:   ${totalCount}`);
  console.log(`\n🚀 The automation will now scan from the very first link!\n`);
}

run().catch((err) => {
  console.error('Fatal error during queue reset:', err);
  process.exit(1);
});
