import { loadLocalEnvOnce, getSupabase } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();
const supabase = getSupabase();

async function inspect() {
  console.log('--- Checking batch_job_queue ---');
  const { data: bqData, error: bqErr } = await supabase
    .from('batch_job_queue')
    .select('*')
    .limit(1);
  if (bqErr) {
    console.log('batch_job_queue error:', bqErr);
  } else {
    console.log('batch_job_queue columns:', bqData && bqData.length > 0 ? Object.keys(bqData[0]) : 'empty table');
    if (bqData && bqData.length > 0) {
      console.log('sample row:', bqData[0]);
    }
  }

  console.log('\n--- Checking job_batch_queue ---');
  const { data: jbData, error: jbErr } = await supabase
    .from('job_batch_queue')
    .select('*')
    .limit(1);
  if (jbErr) {
    console.log('job_batch_queue error:', jbErr);
  } else {
    console.log('job_batch_queue columns:', jbData && jbData.length > 0 ? Object.keys(jbData[0]) : 'empty table');
    if (jbData && jbData.length > 0) {
      console.log('sample row:', jbData[0]);
    }
  }

  console.log('\n--- Checking scanned_jobs ---');
  const { data: sjData, error: sjErr } = await supabase
    .from('scanned_jobs')
    .select('*')
    .limit(1);
  if (sjErr) {
    console.log('scanned_jobs error:', sjErr);
  } else {
    console.log('scanned_jobs columns:', sjData && sjData.length > 0 ? Object.keys(sjData[0]) : 'empty table');
  }

  console.log('\n--- Checking job_distributions ---');
  const { data: jdData, error: jdErr } = await supabase
    .from('job_distributions')
    .select('*')
    .limit(1);
  if (jdErr) {
    console.log('job_distributions error:', jdErr);
  } else {
    console.log('job_distributions columns:', jdData && jdData.length > 0 ? Object.keys(jdData[0]) : 'empty table');
  }
}

inspect().catch(console.error);
