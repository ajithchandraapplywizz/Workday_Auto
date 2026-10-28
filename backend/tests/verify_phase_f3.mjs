import { signJwt } from '../lib/authService.mjs';

const BASE_URL = 'http://localhost:3001';

const adminToken = signJwt({ email: 'admin@applywizz.ai', role: 'admin', name: 'Admin Test' });
const devToken = signJwt({ email: 'dev@applywizz.ai', role: 'developer', name: 'Dev Test' });
const balajiToken = signJwt({ email: 'balaji@applywizz.ai', role: 'manager', manager_id: '9dc9376e-fbc5-440b-932f-38da10b89a70', name: 'Balaji' });
const rkToken = signJwt({ email: 'ramakrishnaa.tejavath@applywizz.ai', role: 'manager', manager_id: 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744', name: 'Ramakrishna' });
const caToken = signJwt({ email: 'ca@applywizz.ai', role: 'ca', name: 'CA Test' });

async function get(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log('========================================================================');
  console.log('              PHASE F3 COMPREHENSIVE VERIFICATION SUITE');
  console.log('========================================================================\n');

  // TEST 1: 401 / 403 / 200 per endpoint
  console.log('=== TEST 1: 401 / 403 / 200 PER ENDPOINT ===');
  const tAdminNoAuth = await get('/api/admin/applications');
  const tAdminCA = await get('/api/admin/applications', caToken);
  const tAdminMgr = await get('/api/admin/applications', balajiToken);
  const tAdminOk = await get('/api/admin/applications', adminToken);
  console.log(`GET /api/admin/applications:`);
  console.log(`  No token:       ${tAdminNoAuth.status} (expected 401)`);
  console.log(`  CA token:       ${tAdminCA.status} (expected 403)`);
  console.log(`  Manager token:  ${tAdminMgr.status} (expected 403)`);
  console.log(`  Admin token:    ${tAdminOk.status} (expected 200)`);

  const tDevNoAuth = await get('/api/developer/applications');
  const tDevCA = await get('/api/developer/applications', caToken);
  const tDevMgr = await get('/api/developer/applications', balajiToken);
  const tDevOk = await get('/api/developer/applications', devToken);
  const tDevAdminOk = await get('/api/developer/applications', adminToken);
  console.log(`GET /api/developer/applications:`);
  console.log(`  No token:       ${tDevNoAuth.status} (expected 401)`);
  console.log(`  CA token:       ${tDevCA.status} (expected 403)`);
  console.log(`  Manager token:  ${tDevMgr.status} (expected 403)`);
  console.log(`  Dev token:      ${tDevOk.status} (expected 200)`);
  console.log(`  Admin token:    ${tDevAdminOk.status} (expected 200)`);

  const tMgrNoAuth = await get('/api/manager/applications');
  const tMgrCA = await get('/api/manager/applications', caToken);
  const tMgrDev = await get('/api/manager/applications', devToken);
  const tMgrAdmin = await get('/api/manager/applications', adminToken);
  const tMgrOk = await get('/api/manager/applications', balajiToken);
  console.log(`GET /api/manager/applications:`);
  console.log(`  No token:       ${tMgrNoAuth.status} (expected 401)`);
  console.log(`  CA token:       ${tMgrCA.status} (expected 403)`);
  console.log(`  Dev token:      ${tMgrDev.status} (expected 403)`);
  console.log(`  Admin token:    ${tMgrAdmin.status} (expected 403)`);
  console.log(`  Manager token:  ${tMgrOk.status} (expected 200)`);

  // TEST 2: List rows equal tile counts for period, 7d, and all (9 submitted, 10 failed all-time)
  console.log('\n=== TEST 2: LIST ROWS EQUAL TILE COUNTS (PERIOD, 7D, ALL) ===');
  // Admin stats from tile engine
  const adminStats = await get('/api/admin/dashboard?from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59Z', adminToken);
  const tStats = adminStats.data.tasks;

  const adminSubPeriod = await get('/api/admin/applications?status=submitted&scope=period&from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59Z', adminToken);
  const adminSub7d = await get('/api/admin/applications?status=submitted&scope=7d', adminToken);
  const adminSubAll = await get('/api/admin/applications?status=submitted&scope=all', adminToken);

  const adminFailPeriod = await get('/api/admin/applications?status=failed&scope=period&from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59Z', adminToken);
  const adminFail7d = await get('/api/admin/applications?status=failed&scope=7d', adminToken);
  const adminFailAll = await get('/api/admin/applications?status=failed&scope=all', adminToken);

  console.log(`SUBMITTED:`);
  console.log(`  Period (Today):  Tile = ${tStats.submitted}    | List Rows = ${adminSubPeriod.data.total} | Equal: ${tStats.submitted === adminSubPeriod.data.total}`);
  console.log(`  Last 7 Days:     Tile = ${tStats.submitted_7d} | List Rows = ${adminSub7d.data.total}     | Equal: ${tStats.submitted_7d === adminSub7d.data.total}`);
  console.log(`  All Time:        Tile = ${tStats.submitted_all}| List Rows = ${adminSubAll.data.total}    | Equal: ${tStats.submitted_all === adminSubAll.data.total}`);

  console.log(`FAILED:`);
  console.log(`  Period (Today):  Tile = ${tStats.failed}       | List Rows = ${adminFailPeriod.data.total}| Equal: ${tStats.failed === adminFailPeriod.data.total}`);
  console.log(`  Last 7 Days:     Tile = ${tStats.failed_7d}    | List Rows = ${adminFail7d.data.total}    | Equal: ${tStats.failed_7d === adminFail7d.data.total}`);
  console.log(`  All Time:        Tile = ${tStats.failed_all}   | List Rows = ${adminFailAll.data.total}   | Equal: ${tStats.failed_all === adminFailAll.data.total}`);

  // TEST 3: All 19 rows (status, applywizz_id, company, status time)
  console.log('\n=== TEST 3: THE 19 EXACT ROWS (9 SUBMITTED + 10 FAILED) ===');
  console.log('--- 9 SUBMITTED ROWS ---');
  adminSubAll.data.applications.forEach((a, i) => {
    console.log(`  [${i+1}] status: ${a.status.padEnd(9)} | awl_id: ${a.applywizz_id.padEnd(10)} | company: ${(a.company || 'N/A').padEnd(20)} | time: ${a.status_time} | ca: ${a.ca || '(unassigned)'}`);
  });

  console.log('\n--- 10 FAILED ROWS ---');
  adminFailAll.data.applications.forEach((a, i) => {
    console.log(`  [${i+1}] status: ${a.status.padEnd(9)} | awl_id: ${a.applywizz_id.padEnd(10)} | company: ${(a.company || 'N/A').padEnd(20)} | time: ${a.status_time} | cat: ${a.failure_category.padEnd(28)} | error: ${a.error_message?.substring(0, 45)}...`);
  });

  // TEST 4: Manager isolation & manager_id query parameter ignored
  console.log('\n=== TEST 4: MANAGER ISOLATION & QUERY SPOOFING TEST ===');
  const balajiSub = await get('/api/manager/applications?status=submitted&scope=all', balajiToken);
  const balajiFail = await get('/api/manager/applications?status=failed&scope=all', balajiToken);
  const rkSub = await get('/api/manager/applications?status=submitted&scope=all', rkToken);
  const rkFail = await get('/api/manager/applications?status=failed&scope=all', rkToken);

  console.log(`Balaji (Manager 1):      Submitted = ${balajiSub.data.total} | Failed = ${balajiFail.data.total}`);
  console.log(`Ramakrishna (Manager 2): Submitted = ${rkSub.data.total} | Failed = ${rkFail.data.total}`);

  // Spoof attempt
  const spoofAttempt = await get(`/api/manager/applications?status=submitted&scope=all&manager_id=bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744`, balajiToken);
  console.log(`Spoof test: Balaji requesting Ramakrishna manager_id parameter -> returns ${spoofAttempt.data.total} (must equal Balaji count ${balajiSub.data.total}): ${spoofAttempt.data.total === balajiSub.data.total ? 'PASS (Spoofing Ignored)' : 'FAIL'}`);

  // TEST 5: Both managers + unassigned = admin
  console.log('\n=== TEST 5: BOTH MANAGERS + UNASSIGNED = ADMIN TOTAL ===');
  // From our unassigned clients query: AWL-6617 and AWL-6618 belong to clients without CA / manager. Both are submitted.
  const unassignedSub = adminSubAll.data.applications.filter(a => !a.ca).length;
  const unassignedFail = adminFailAll.data.applications.filter(a => !a.ca).length;

  const totalCalcSub = balajiSub.data.total + rkSub.data.total + unassignedSub;
  const totalCalcFail = balajiFail.data.total + rkFail.data.total + unassignedFail;

  console.log(`Submitted breakdown: Balaji (${balajiSub.data.total}) + Ramakrishna (${rkSub.data.total}) + Unassigned (${unassignedSub}) = ${totalCalcSub} (Admin = ${adminSubAll.data.total}) -> ${totalCalcSub === adminSubAll.data.total ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Failed breakdown:    Balaji (${balajiFail.data.total}) + Ramakrishna (${rkFail.data.total}) + Unassigned (${unassignedFail}) = ${totalCalcFail} (Admin = ${adminFailAll.data.total}) -> ${totalCalcFail === adminFailAll.data.total ? 'MATCH' : 'MISMATCH'}`);

  // TEST 6: Categories add up to failed total (10)
  console.log('\n=== TEST 6: FAILURE CATEGORIES CLASSIFICATION BREAKDOWN ===');
  const catSummary = {};
  for (const app of adminFailAll.data.applications) {
    const c = app.failure_category || 'Other';
    catSummary[c] = (catSummary[c] || 0) + 1;
  }
  console.log(JSON.stringify(catSummary, null, 2));
  const sumCats = Object.values(catSummary).reduce((a, b) => a + b, 0);
  console.log(`Categories Sum: ${sumCats} / ${adminFailAll.data.total} failed total -> ${sumCats === adminFailAll.data.total ? 'EXACT MATCH' : 'MISMATCH'}`);

  console.log('\nExpected Breakdown Verification:');
  console.log(`  Worker lease expired:             ${catSummary['Worker lease expired'] || 0} (expected 6)`);
  console.log(`  Daemon restart / interrupted:     ${catSummary['Daemon restart / interrupted'] || 0} (expected 1)`);
  console.log(`  Code error:                       ${catSummary['Code error'] || 0} (expected 1)`);
  console.log(`  Login / credentials:              ${catSummary['Login / credentials'] || 0} (expected 1)`);
  console.log(`  Incomplete submission:            ${catSummary['Incomplete submission'] || 0} (expected 1)`);
  console.log(`  Other:                            ${catSummary['Other'] || 0} (expected 0)`);
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
