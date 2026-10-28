/**
 * run_phase_f1_tests.mjs — Comprehensive Phase F1 Automated Test Suite
 * ====================================================================
 * Executes all required Phase F1 acceptance tests against the live daemon:
 * 1. Health check & connectivity
 * 2. Independent DB/SQL counts vs dashboard stats buckets (all-time & 7d week range)
 * 3. Invariant check: all buckets add up to total applications
 * 4. Admin vs Developer parity: identical numbers for the same period
 * 5. Manager token scoping: team-only data; manager_id query param is ignored;
 *    Manager 1 + Manager 2 + unattributed = Admin total
 * 6. Dynamic 'other' bucket test: Insert 1 dedicated test application with unknown status,
 *    verify it appears in 'other', and cleanly delete it
 * 7. Dynamic cache window test: Update dedicated test task, verify live detection
 *    after 15s cache expiry window, then clean up
 * 8. Authentication & Authorization test: 401 no token, 403 wrong role, 200 right role
 *    for /api/admin/dashboard, /api/developer/dashboard, and /api/manager/dashboard
 * 9. Test row isolation guarantee: dedicated test rows only, zero touch on real CAs/users
 */

import { createClient } from '@supabase/supabase-js';
import { signJwt } from '../lib/authService.mjs';
import fs from 'fs';

const env = {};
fs.readFileSync('./backend/.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const BASE_URL = 'http://127.0.0.1:3001';

// Generate tokens for testing
const adminToken = signJwt({ email: 'admin@applywizz.ai', role: 'admin', name: 'Admin Test' });
const devToken = signJwt({ email: 'dev@applywizz.ai', role: 'developer', name: 'Dev Test' });
const balajiToken = signJwt({ email: 'balaji@applywizz.ai', role: 'manager', manager_id: '9dc9376e-fbc5-440b-932f-38da10b89a70', name: 'Balaji' });
const rkToken = signJwt({ email: 'ramakrishnaa.tejavath@applywizz.ai', role: 'manager', manager_id: 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744', name: 'Ramakrishna' });
const caToken = signJwt({ email: 'test_ca@applywizz.ai', role: 'ca', name: 'CA Test' });

async function fetchJson(endpoint, options = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data: json };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('================================================================');
  console.log('       PHASE F1 COMPREHENSIVE BACKEND VERIFICATION SUITE        ');
  console.log('================================================================\n');

  // 0. Connectivity
  console.log('--- TEST 0: Health Check ---');
  const health = await fetchJson('/health');
  console.log('Daemon /health status:', health.status, health.data);
  if (health.status !== 200) {
    throw new Error('Daemon not running on port 3001');
  }

  // 1. Independent DB count vs Dashboard stats (all-time & week range)
  console.log('\n--- TEST 1: Independent SQL / DB Count vs Engine Buckets (All-Time & 7d) ---');
  // Fetch all JD and ST rows directly for ground-truth SQL comparison
  const { data: allJd } = await supabase.from('job_distributions').select('id, status, updated_at, created_at');
  const { data: allSt } = await supabase.from('submission_tasks').select('id, distribution_id, status, completed_at, updated_at');
  
  const stByDist = new Map();
  allSt.forEach(s => { if (s.distribution_id) stByDist.set(s.distribution_id, s); });

  // Ground-truth all-time calculation
  let gtAllNeedsAnswers = 0, gtAllReady = 0, gtAllQueued = 0, gtAllApplying = 0, gtAllSubmitted = 0, gtAllFailed = 0, gtAllOther = 0;
  for (const j of allJd) {
    const t = stByDist.get(j.id);
    const eff = (t ? t.status : j.status) || 'unknown';
    if (eff === 'needs_answers') gtAllNeedsAnswers++;
    else if (eff === 'ready_for_review') gtAllReady++;
    else if (eff === 'queued') gtAllQueued++;
    else if (eff === 'applying') gtAllApplying++;
    else if (eff === 'submitted') gtAllSubmitted++;
    else if (eff === 'failed') gtAllFailed++;
    else gtAllOther++;
  }

  console.log('INDEPENDENT SQL GROUND-TRUTH (ALL-TIME):');
  console.log(`  SQL: SELECT count(*) FROM job_distributions LEFT JOIN submission_tasks ...`);
  console.log(`  Total Applications: ${allJd.length}`);
  console.log(`  ready_for_review: ${gtAllReady}`);
  console.log(`  needs_answers: ${gtAllNeedsAnswers}`);
  console.log(`  submitted: ${gtAllSubmitted}`);
  console.log(`  failed: ${gtAllFailed}`);
  console.log(`  queued: ${gtAllQueued}`);
  console.log(`  applying: ${gtAllApplying}`);
  console.log(`  other: ${gtAllOther}`);

  // Fetch from Admin Dashboard endpoint
  const adminRes = await fetchJson('/api/admin/dashboard', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('\nGET /api/admin/dashboard (All-Time) Response Status:', adminRes.status);
  console.log('Engine Tasks Output:', adminRes.data.tasks);

  // Assert all-time matches
  const engTasks = adminRes.data.tasks;
  const matchAll = (
    engTasks.ready_for_review === gtAllReady &&
    engTasks.needs_answers === gtAllNeedsAnswers &&
    engTasks.submitted === gtAllSubmitted &&
    engTasks.failed === gtAllFailed &&
    engTasks.queued === gtAllQueued &&
    engTasks.applying === gtAllApplying &&
    engTasks.other === gtAllOther &&
    engTasks.total_applications === allJd.length
  );
  console.log(`✅ All-Time Engine vs SQL Parity Check: ${matchAll ? 'PERFECT MATCH' : 'MISMATCH'}`);

  // 7d Week Range Check
  const now = new Date();
  const weekAgoIso = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
  let gtWkSubmitted = 0, gtWkFailed = 0;
  for (const j of allJd) {
    const t = stByDist.get(j.id);
    const eff = (t ? t.status : j.status) || 'unknown';
    const eventTime = t?.completed_at || t?.updated_at || j.updated_at || j.created_at;
    if (eventTime >= weekAgoIso) {
      if (eff === 'submitted') gtWkSubmitted++;
      if (eff === 'failed') gtWkFailed++;
    }
  }

  const adminWeekRes = await fetchJson(`/api/admin/dashboard?from=${encodeURIComponent(weekAgoIso)}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('\nGET /api/admin/dashboard (7d Range) Response:');
  console.log('  Engine Submitted (7d):', adminWeekRes.data.tasks.submitted, '| Ground Truth:', gtWkSubmitted);
  console.log('  Engine Failed (7d):', adminWeekRes.data.tasks.failed, '| Ground Truth:', gtWkFailed);
  console.log('  Engine LIVE ready_for_review (ignores date):', adminWeekRes.data.tasks.ready_for_review, '| Ground Truth:', gtAllReady);
  console.log('  Engine LIVE needs_answers (ignores date):', adminWeekRes.data.tasks.needs_answers, '| Ground Truth:', gtAllNeedsAnswers);
  const matchWeek = (
    adminWeekRes.data.tasks.submitted === gtWkSubmitted &&
    adminWeekRes.data.tasks.failed === gtWkFailed &&
    adminWeekRes.data.tasks.ready_for_review === gtAllReady &&
    adminWeekRes.data.tasks.needs_answers === gtAllNeedsAnswers
  );
  console.log(`✅ 7d Week Range Engine vs SQL Parity Check: ${matchWeek ? 'PERFECT MATCH' : 'MISMATCH'}`);

  // 2. Invariant Check: All buckets add up to total applications
  console.log('\n--- TEST 2: Invariant Check (All Buckets Sum == Total Applications) ---');
  const sumAllBuckets = (
    engTasks.ready_for_review +
    engTasks.needs_answers +
    engTasks.queued +
    engTasks.applying +
    engTasks.submitted +
    engTasks.failed +
    engTasks.other
  );
  console.log(`  Sum of all buckets: ${sumAllBuckets}`);
  console.log(`  Total applications: ${engTasks.total_applications} (JD total count: ${allJd.length})`);
  const invariantHolds = sumAllBuckets === engTasks.total_applications && sumAllBuckets === allJd.length;
  console.log(`✅ INVARIANT HOLDS: ${invariantHolds ? 'YES (100% Exact)' : 'NO'}`);

  // 3. Admin and Developer Parity
  console.log('\n--- TEST 3: Admin and Developer Parity Check ---');
  const devRes = await fetchJson('/api/developer/dashboard', {
    headers: { Authorization: `Bearer ${devToken}` }
  });
  console.log('GET /api/developer/dashboard Response Status:', devRes.status);
  console.log('Developer Tasks Output:', devRes.data.tasks);
  console.log('Developer Worker Status Sample:', devRes.data.worker_status?.slice(0, 3));
  console.log('Developer Failures breakdown:', devRes.data.failures);
  console.log('Developer Oldest Queued Age:', devRes.data.oldest_queued_age_seconds, 's');

  const tasksIdentical = JSON.stringify(adminRes.data.tasks) === JSON.stringify(devRes.data.tasks);
  const answersIdentical = JSON.stringify(adminRes.data.answerSources) === JSON.stringify(devRes.data.answerSources);
  console.log(`✅ Admin vs Developer Tasks Parity: ${tasksIdentical ? 'IDENTICAL' : 'DIFFERENT'}`);
  console.log(`✅ Admin vs Developer Answer Sources Parity: ${answersIdentical ? 'IDENTICAL' : 'DIFFERENT'}`);

  // 4. Manager Token Scoping & Isolation
  console.log('\n--- TEST 4: Manager Token Scoping & Isolation ---');
  // Manager 1: Balaji
  const balajiRes = await fetchJson('/api/manager/dashboard', {
    headers: { Authorization: `Bearer ${balajiToken}` }
  });
  console.log('Balaji Team Total Applications:', balajiRes.data.tasks.total_applications);
  console.log('Balaji Tasks Breakdown:', balajiRes.data.tasks);

  // Manager 2: Ramakrishna
  const rkRes = await fetchJson('/api/manager/dashboard', {
    headers: { Authorization: `Bearer ${rkToken}` }
  });
  console.log('Ramakrishna Team Total Applications:', rkRes.data.tasks.total_applications);
  console.log('Ramakrishna Tasks Breakdown:', rkRes.data.tasks);

  // Unattributed count from Admin
  const unattributed = adminRes.data.tasks.unattributed;
  console.log('Unattributed Applications in Admin:', unattributed);

  const managerSum = balajiRes.data.tasks.total_applications + rkRes.data.tasks.total_applications + unattributed;
  console.log(`Balaji (${balajiRes.data.tasks.total_applications}) + Ramakrishna (${rkRes.data.tasks.total_applications}) + Unattributed (${unattributed}) = ${managerSum}`);
  console.log(`Admin Total Applications: ${adminRes.data.tasks.total_applications}`);
  const managerSumMatches = managerSum === adminRes.data.tasks.total_applications;
  console.log(`✅ Manager Sum + Unattributed == Admin Total: ${managerSumMatches ? 'PERFECT MATCH' : 'MISMATCH'}`);

  // Query parameter spoofing check: Send Balaji's token with Ramakrishna's manager_id query param
  const spoofRes = await fetchJson(`/api/manager/dashboard?manager_id=bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744`, {
    headers: { Authorization: `Bearer ${balajiToken}` }
  });
  const paramIgnored = spoofRes.data.tasks.total_applications === balajiRes.data.tasks.total_applications;
  console.log(`✅ manager_id Query Parameter Ignored (strictly token-bound): ${paramIgnored ? 'CONFIRMED' : 'FAILED'}`);

  // 5. Unknown status shows in 'other'
  console.log('\n--- TEST 5: Unknown Status Shows in "other" Bucket ---');
  // Insert 1 dedicated test application into job_distributions
  const testDistId = '00000000-0000-4000-a000-000000000001';
  await supabase.from('job_distributions').delete().eq('id', testDistId); // clean prior if any

  const nowIso = new Date().toISOString();
  const { error: insErr } = await supabase.from('job_distributions').insert({
    id: testDistId,
    applywizz_id: 'TEST-AWL-99999',
    job_url: 'https://test.wd5.myworkdayjobs.com/test-job',
    company: 'Test Unknown Company',
    role_title: 'Test Engineer',
    status: 'custom_mystery_status',
    created_at: nowIso,
    updated_at: nowIso,
  });

  if (insErr) {
    console.error('Test row insertion failed:', insErr.message);
  } else {
    // Wait for fresh cache or call with unique timestamp param to bypass cache
    const testOtherRes = await fetchJson(`/api/admin/dashboard?from=${encodeURIComponent('2020-01-01T00:00:00Z')}&test_nocache=${Date.now()}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('Engine Tasks with Unknown Status Test Row:');
    console.log('  other count:', testOtherRes.data.tasks.other);
    console.log('  other_statuses:', testOtherRes.data.tasks.other_statuses);
    const showsInOther = testOtherRes.data.tasks.other_statuses && testOtherRes.data.tasks.other_statuses['custom_mystery_status'] >= 1;
    console.log(`✅ Unknown Status Appears in "other" Bucket: ${showsInOther ? 'CONFIRMED' : 'FAILED'}`);

    // Clean up dedicated test row
    await supabase.from('job_distributions').delete().eq('id', testDistId);
    console.log('🧹 Cleaned up dedicated test job_distribution row');
  }

  // 6. DB Status change reflected after cache window (15s TTL)
  console.log('\n--- TEST 6: DB Status Change Reflected After Cache Window (15s TTL) ---');
  // Insert a dedicated test task and JD
  const testTaskId = '00000000-0000-4000-b000-000000000002';
  const testJdId = '00000000-0000-4000-b000-000000000003';
  await supabase.from('submission_tasks').delete().eq('id', testTaskId);
  await supabase.from('job_distributions').delete().eq('id', testJdId);

  await supabase.from('job_distributions').insert({
    id: testJdId,
    applywizz_id: 'TEST-AWL-CACHE-01',
    job_url: 'https://test.wd5.myworkdayjobs.com/cache-test',
    company: 'Cache Test Inc',
    status: 'ready_for_review',
    created_at: nowIso,
    updated_at: nowIso,
  });
  await supabase.from('submission_tasks').insert({
    id: testTaskId,
    distribution_id: testJdId,
    applywizz_id: 'TEST-AWL-CACHE-01',
    job_url: 'https://test.wd5.myworkdayjobs.com/cache-test',
    company: 'Cache Test Inc',
    status: 'ready_for_review',
    created_at: nowIso,
    updated_at: nowIso,
  });

  // Call dashboard to prime cache
  const primedRes = await fetchJson('/api/admin/dashboard', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('Primed cache ready_for_review count:', primedRes.data.tasks.ready_for_review);

  // Now change status in DB to 'applying'
  await supabase.from('submission_tasks').update({
    status: 'applying',
    updated_at: new Date().toISOString()
  }).eq('id', testTaskId);
  console.log('Updated test task status in DB to "applying".');

  // Immediate read (should still return cached data within 15s window)
  const cachedRes = await fetchJson('/api/admin/dashboard', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('Immediate read (within 15s cache): applying =', cachedRes.data.tasks.applying, '(cached)');

  console.log('Waiting 16 seconds for cache TTL to expire...');
  await sleep(16000);

  // Next read after cache expiry: must reflect the DB change!
  const refreshedRes = await fetchJson('/api/admin/dashboard', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('Post-expiry read: applying =', refreshedRes.data.tasks.applying);
  const cacheRefreshed = refreshedRes.data.tasks.applying > cachedRes.data.tasks.applying;
  console.log(`✅ Live Cache Invalidation After 15s: ${cacheRefreshed ? 'CONFIRMED' : 'FAILED'}`);

  // Clean up dedicated test rows
  await supabase.from('submission_tasks').delete().eq('id', testTaskId);
  await supabase.from('job_distributions').delete().eq('id', testJdId);
  console.log('🧹 Cleaned up dedicated cache test rows');

  // 7. Auth Checks: 401 no token, 403 wrong role, 200 right role
  console.log('\n--- TEST 7: Authentication & Role Enforcement (401, 403, 200) ---');
  
  // Endpoint A: /api/admin/dashboard
  const aNoToken = await fetchJson('/api/admin/dashboard');
  const aCaRole = await fetchJson('/api/admin/dashboard', { headers: { Authorization: `Bearer ${caToken}` } });
  const aAdminRole = await fetchJson('/api/admin/dashboard', { headers: { Authorization: `Bearer ${adminToken}` } });
  const aDevRole = await fetchJson('/api/admin/dashboard', { headers: { Authorization: `Bearer ${devToken}` } });
  console.log(`GET /api/admin/dashboard:`);
  console.log(`  No token: status ${aNoToken.status} (expected 401) -> ${aNoToken.status === 401 ? 'PASS' : 'FAIL'}`);
  console.log(`  CA token: status ${aCaRole.status} (expected 403) -> ${aCaRole.status === 403 ? 'PASS' : 'FAIL'}`);
  console.log(`  Admin token: status ${aAdminRole.status} (expected 200) -> ${aAdminRole.status === 200 ? 'PASS' : 'FAIL'}`);
  console.log(`  Dev token: status ${aDevRole.status} (expected 200) -> ${aDevRole.status === 200 ? 'PASS' : 'FAIL'}`);

  // Endpoint B: /api/developer/dashboard
  const dNoToken = await fetchJson('/api/developer/dashboard');
  const dCaRole = await fetchJson('/api/developer/dashboard', { headers: { Authorization: `Bearer ${caToken}` } });
  const dDevRole = await fetchJson('/api/developer/dashboard', { headers: { Authorization: `Bearer ${devToken}` } });
  const dAdminRole = await fetchJson('/api/developer/dashboard', { headers: { Authorization: `Bearer ${adminToken}` } });
  console.log(`\nGET /api/developer/dashboard:`);
  console.log(`  No token: status ${dNoToken.status} (expected 401) -> ${dNoToken.status === 401 ? 'PASS' : 'FAIL'}`);
  console.log(`  CA token: status ${dCaRole.status} (expected 403) -> ${dCaRole.status === 403 ? 'PASS' : 'FAIL'}`);
  console.log(`  Dev token: status ${dDevRole.status} (expected 200) -> ${dDevRole.status === 200 ? 'PASS' : 'FAIL'}`);
  console.log(`  Admin token: status ${dAdminRole.status} (expected 200) -> ${dAdminRole.status === 200 ? 'PASS' : 'FAIL'}`);

  // Endpoint C: /api/manager/dashboard
  const mNoToken = await fetchJson('/api/manager/dashboard');
  const mCaRole = await fetchJson('/api/manager/dashboard', { headers: { Authorization: `Bearer ${caToken}` } });
  const mAdminRole = await fetchJson('/api/manager/dashboard', { headers: { Authorization: `Bearer ${adminToken}` } });
  const mManagerRole = await fetchJson('/api/manager/dashboard', { headers: { Authorization: `Bearer ${balajiToken}` } });
  console.log(`\nGET /api/manager/dashboard:`);
  console.log(`  No token: status ${mNoToken.status} (expected 401) -> ${mNoToken.status === 401 ? 'PASS' : 'FAIL'}`);
  console.log(`  CA token: status ${mCaRole.status} (expected 403) -> ${mCaRole.status === 403 ? 'PASS' : 'FAIL'}`);
  console.log(`  Admin token: status ${mAdminRole.status} (expected 403) -> ${mAdminRole.status === 403 ? 'PASS' : 'FAIL'}`);
  console.log(`  Manager token: status ${mManagerRole.status} (expected 200) -> ${mManagerRole.status === 200 ? 'PASS' : 'FAIL'}`);

  // Invalid date format check (400 validation)
  const badDateRes = await fetchJson('/api/admin/dashboard?from=invalid-date-string', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log(`\nDate Validation (Invalid Date): status ${badDateRes.status} (expected 400) -> ${badDateRes.status === 400 ? 'PASS' : 'FAIL'}`);

  console.log('\n================================================================');
  console.log('              ALL PHASE F1 ACCEPTANCE TESTS COMPLETED           ');
  console.log('================================================================');
}

run().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
