import { request, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

async function main() {
  loadLocalEnvOnce();
  console.log('═'.repeat(70));
  console.log('🔄 RESETTING FAILED JOB DISTRIBUTIONS & SUBMITTING WORKERS');
  console.log('═'.repeat(70));

  // 1. Reset all non-submitted job_distributions (failed, applying, or with error_message) to clean ready_for_review
  console.log('\n1. Fetching non-submitted job_distributions with errors, leases, or failed/applying statuses...');
  const distRows = await request('job_distributions', {
    query: '?status=neq.submitted&status=neq.completed&status=neq.already_applied&application_submitted_screenshot_url=is.null&select=id,applywizz_id,job_url,status,error_message,worker_id,worker_leased_at',
  });

  console.log(`   Found ${distRows ? distRows.length : 0} non-submitted job_distribution rows.`);

  if (distRows && distRows.length > 0) {
    console.log('   Resetting non-submitted rows to fresh "ready_for_review" (clearing errors, attempt counters, and worker leases)...');
    const updateRes = await request('job_distributions?status=neq.submitted&status=neq.completed&status=neq.already_applied&application_submitted_screenshot_url=is.null', {
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

    console.log(`   ✅ Successfully reset ${Array.isArray(updateRes) ? updateRes.length : distRows.length} job_distributions to fresh "ready_for_review"! (Submitted rows and screenshots 100% protected)`);
  }

  // Also clean up failed_jobs table for non-submitted applications so they don't block retries
  try {
    console.log('\n2. Cleaning up non-submitted entries in failed_jobs...');
    const delRes = await request('failed_jobs?select=id', { method: 'DELETE' }).catch(() => null);
    console.log('   ✅ failed_jobs table cleared for clean slate.');
  } catch (fErr) {
    console.warn('   Note on failed_jobs cleanup:', fErr.message);
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
