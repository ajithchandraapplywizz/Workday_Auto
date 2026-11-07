import { request, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

async function clearAndReset() {
  console.log('═'.repeat(70));
  console.log('🧹 CLEARING scanned_jobs, failed_jobs, job_distributions');
  console.log('🔄 RESETTING batch_job_queue TO PENDING');
  console.log('═'.repeat(70));

  // 1. Delete all rows from job_distributions first (child table)
  console.log('\n1. Deleting all rows from job_distributions...');
  try {
    await request('job_distributions', {
      method: 'DELETE',
      query: '?id=neq.00000000-0000-0000-0000-000000000000',
      prefer: 'return=minimal',
    });
    console.log('   ✅ job_distributions cleared.');
  } catch (err) {
    console.error('   ❌ Error clearing job_distributions:', err.message);
  }

  // 2. Delete all rows from scanned_jobs
  console.log('\n2. Deleting all rows from scanned_jobs...');
  try {
    await request('scanned_jobs', {
      method: 'DELETE',
      query: '?id=neq.00000000-0000-0000-0000-000000000000',
      prefer: 'return=minimal',
    });
    console.log('   ✅ scanned_jobs cleared.');
  } catch (err) {
    console.error('   ❌ Error clearing scanned_jobs:', err.message);
  }

  // 3. Delete all rows from failed_jobs
  console.log('\n3. Deleting all rows from failed_jobs...');
  try {
    await request('failed_jobs', {
      method: 'DELETE',
      query: '?id=neq.00000000-0000-0000-0000-000000000000',
      prefer: 'return=minimal',
    });
    console.log('   ✅ failed_jobs cleared.');
  } catch (err) {
    console.error('   ❌ Error clearing failed_jobs:', err.message);
  }

  // 4. Update all rows in batch_job_queue to pending
  console.log('\n4. Resetting batch_job_queue rows to status = "pending"...');
  const now = new Date().toISOString();
  try {
    await request('batch_job_queue', {
      method: 'PATCH',
      query: '?id=neq.00000000-0000-0000-0000-000000000000',
      prefer: 'return=minimal',
      body: {
        status: 'pending',
        worker_id: null,
        locked_at: null,
        attempt_count: 0,
        scanned_job_id: null,
        screenshot_path: null,
        updated_at: now,
      },
    });
    console.log('   ✅ batch_job_queue reset to pending.');
  } catch (err) {
    console.error('   ❌ Error resetting batch_job_queue:', err.message);
  }

  // 5. Verification: Check final counts
  console.log('\n5. Verification: Checking final table counts...');
  const sj = await request('scanned_jobs', { query: '?select=id' }).catch(() => []);
  const fj = await request('failed_jobs', { query: '?select=id' }).catch(() => []);
  const jd = await request('job_distributions', { query: '?select=id' }).catch(() => []);
  const bq = await request('batch_job_queue', { query: '?select=id,status' }).catch(() => []);

  const bqStatuses = {};
  for (const r of (bq || [])) {
    bqStatuses[r.status] = (bqStatuses[r.status] || 0) + 1;
  }

  console.log('   📊 Final Counts:');
  console.log('      scanned_jobs:', sj?.length || 0);
  console.log('      failed_jobs:', fj?.length || 0);
  console.log('      job_distributions:', jd?.length || 0);
  console.log('      batch_job_queue total:', bq?.length || 0);
  console.log('      batch_job_queue status breakdown:', bqStatuses);
  console.log('\n═'.repeat(70));
}

clearAndReset().catch(console.error);
