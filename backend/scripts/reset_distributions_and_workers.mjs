import { request, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

async function main() {
  loadLocalEnvOnce();
  console.log('═'.repeat(70));
  console.log('🔄 RESETTING FAILED JOB DISTRIBUTIONS & SUBMITTING WORKERS');
  console.log('═'.repeat(70));

  // 1. Reset failed job_distributions to ready_for_review
  console.log('\n1. Fetching failed job_distributions...');
  const failedDist = await request('job_distributions', {
    query: '?status=eq.failed&select=id,applywizz_id,job_url,status,error_message,worker_id,worker_leased_at',
  });

  console.log(`   Found ${failedDist ? failedDist.length : 0} failed job_distribution rows.`);

  if (failedDist && failedDist.length > 0) {
    console.log('   Resetting failed job_distributions to "ready_for_review" and clearing error/leased fields...');
    const updateRes = await request('job_distributions?status=eq.failed', {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: 'ready_for_review',
        error_message: null,
        worker_id: null,
        worker_leased_at: null,
        updated_at: new Date().toISOString(),
      },
    });

    console.log(`   ✅ Successfully updated ${Array.isArray(updateRes) ? updateRes.length : failedDist.length} job_distributions to "ready_for_review"!`);
  }

  // 2. Also reset any stuck/leased job_distributions that are NOT completed/submitted
  const stuckLeased = await request('job_distributions', {
    query: '?worker_leased_at=not.is.null&status=in.(ready_for_review,applying)&select=id,worker_id,worker_leased_at',
  });
  if (stuckLeased && stuckLeased.length > 0) {
    console.log(`   Clearing ${stuckLeased.length} stuck leased job_distributions...`);
    await request('job_distributions?worker_leased_at=not.is.null&status=in.(ready_for_review,applying)', {
      method: 'PATCH',
      body: {
        worker_id: null,
        worker_leased_at: null,
        updated_at: new Date().toISOString(),
      },
    });
    console.log('   ✅ Leased fields cleared.');
  }

  // 3. Reset worker_status table
  console.log('\n2. Resetting worker_status rows...');
  const workers = await request('worker_status', { query: '?select=*' });
  console.log(`   Found ${workers ? workers.length : 0} workers in worker_status.`);

  if (workers && workers.length > 0) {
    await request('worker_status?worker_id=neq.\'\'', {
      method: 'PATCH',
      body: {
        state: 'idle',
        stage: 'idle',
        current_application_id: null,
        updated_at: new Date().toISOString(),
      },
    });
    console.log('   ✅ All workers in worker_status reset to state="idle", stage="idle", current_application_id=null.');
  }

  // 4. Reset bot_control stop flags
  console.log('\n3. Resetting bot_control state...');
  await request('bot_control?id=eq.primary', {
    method: 'PATCH',
    body: {
      is_running: false,
      is_paused: false,
      stop_requested: false,
      scan_stop_requested: false,
      submit_stop_requested: false,
      active_worker_count: 0,
      current_action: 'Idle - ready for pipeline trigger',
      updated_at: new Date().toISOString(),
    },
  });
  console.log('   ✅ bot_control reset: stop flags cleared, active_worker_count=0.');

  // 5. Verification: Get latest counts
  console.log('\n4. Verification: Latest status counts:');
  const distAll = await request('job_distributions', { query: '?select=status' });
  const distCounts = {};
  for (const r of (distAll || [])) {
    distCounts[r.status] = (distCounts[r.status] || 0) + 1;
  }
  console.log('   📊 job_distributions status counts:', distCounts);

  const bqAll = await request('batch_job_queue', { query: '?select=status' });
  const bqCounts = {};
  for (const r of (bqAll || [])) {
    bqCounts[r.status] = (bqCounts[r.status] || 0) + 1;
  }
  console.log('   📊 batch_job_queue status counts:', bqCounts);

  console.log('\n═'.repeat(70));
  console.log('✅ ALL FAILED JOBS & WORKERS SUCCESSFULLY RESET');
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
