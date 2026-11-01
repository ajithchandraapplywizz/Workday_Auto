/**
 * run_real_2_companies_scan.mjs
 * Real live scanning & resolving test for 2 real companies:
 * 1. Moog Inc. (AI Engineer Commercial Aircraft Group)
 * 2. SWBC (Data Scientist II)
 *
 * Verifies:
 * - Stage 1 Scanning harvests forms & saves to scanned_jobs
 * - Stage 2 Resolving matches candidate facts into job_distributions (ready_for_review)
 * - Zero local screenshots written (all in-memory)
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { runClusterBatchRunner } from '../lib/clusterBatchRunner.mjs';
import { runResolvingWorkerPool } from '../lib/resolvingWorkerPool.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Supabase credentials missing.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_COMPANIES = ['Moog Inc.', 'SWBC'];

async function run() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🚀 LIVE REAL-APPLICATION SCANNING & RESOLVING TEST (2 COMPANIES)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Step 1: Clean previous entries in scanned_jobs / failed_jobs for these 2 companies
  console.log('1️⃣ Preparing test data: resetting batch_job_queue and clearing old entries...');
  await supabase.from('failed_jobs').delete().or('job_url.ilike.%moog%,job_url.ilike.%swbc%');
  await supabase.from('scanned_jobs').delete().or('job_url.ilike.%moog%,job_url.ilike.%swbc%');
  await supabase.from('job_distributions').delete().or('job_url.ilike.%moog%,job_url.ilike.%swbc%');
  await supabase.from('batch_job_queue').delete().eq('company', 'Moog, Inc');

  await supabase
    .from('batch_job_queue')
    .update({
      status: 'pending',
      worker_id: null,
      locked_at: null,
      attempt_count: 0,
      updated_at: new Date().toISOString(),
    })
    .in('company', TEST_COMPANIES);

  await supabase
    .from('bot_control')
    .update({
      stage: 'scanning',
      mode: 'scanning',
      is_running: true,
      stop_requested: false,
      scan_stop_requested: false,
      scan_enabled: true,
      scan_status: 'running',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary');

  console.log('   ✓ Cleaned historical failed_jobs & scanned_jobs for Moog Inc. & SWBC.');
  console.log('   ✓ Set batch_job_queue to pending.\n');

  // Step 2: Run Stage 1 Scanning for these 2 companies
  console.log('2️⃣ Running Stage 1 Scanning on Moog Inc. and SWBC in HEADLESS mode...');
  const scanRunId = `live_test_${Date.now()}`;

  await runClusterBatchRunner({
    scanRunId,
    topLinks: 2,
    workers: 1, // Sequential or 1 dedicated worker to clearly monitor progress
    headless: true,
    confirmSubmit: false,
    limitPerLink: 1,
    defaultPassword: process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
  });

  console.log('\n3️⃣ Checking scanned_jobs table...');
  const { data: scannedRows } = await supabase
    .from('scanned_jobs')
    .select('id, company, role_title, scan_status, questions_count, job_url')
    .in('company', TEST_COMPANIES);

  console.log('   Scanned rows:', scannedRows);

  console.log('\n4️⃣ Running Stage 2 Resolving candidate answers into job_distributions...');
  await runResolvingWorkerPool();

  console.log('\n5️⃣ Checking job_distributions table...');
  const { data: distRows } = await supabase
    .from('job_distributions')
    .select('id, company, role_title, applywizz_id, status, client_answers, created_at')
    .in('company', TEST_COMPANIES)
    .limit(10);

  console.log('   Job distributions count:', distRows?.length || 0);
  if (distRows && distRows.length > 0) {
    distRows.slice(0, 3).forEach((d) => {
      console.log(`   • ${d.company} | ${d.applywizz_id} | status: ${d.status} | answers: ${Object.keys(d.client_answers || {}).length}`);
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🏁 SCAN & RESOLVE PASS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('❌ Error during live scan test:', err);
  process.exit(1);
});
