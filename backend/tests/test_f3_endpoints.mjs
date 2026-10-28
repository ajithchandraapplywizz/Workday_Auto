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

async function run() {
  console.log('================================================================');
  console.log(' PHASE F3 APPLICATIONS ENDPOINTS VERIFICATION');
  console.log('================================================================\n');

  // 1. Auth tests
  console.log('--- 1. AUTH & ROLE BOUNDARIES ---');
  const noToken = await get('/api/admin/applications');
  console.log(`No Token: status ${noToken.status} (expected 401)`);

  const caOnAdmin = await get('/api/admin/applications', caToken);
  console.log(`CA on Admin: status ${caOnAdmin.status} (expected 403)`);

  const adminOnAdmin = await get('/api/admin/applications', adminToken);
  console.log(`Admin on Admin: status ${adminOnAdmin.status} (expected 200)`);

  const devOnDev = await get('/api/developer/applications', devToken);
  console.log(`Dev on Dev: status ${devOnDev.status} (expected 200)`);

  const adminOnMgr = await get('/api/manager/applications', adminToken);
  console.log(`Admin on Manager: status ${adminOnMgr.status} (expected 403)`);

  const mgrOnMgr = await get('/api/manager/applications', balajiToken);
  console.log(`Manager on Manager: status ${mgrOnMgr.status} (expected 200)\n`);

  // 2. Admin all-time and 7d counts
  console.log('--- 2. ADMIN APPLICATIONS LIST (COUNTS & SHAPE) ---');
  const subAll = await get('/api/admin/applications?status=submitted&scope=all', adminToken);
  const failAll = await get('/api/admin/applications?status=failed&scope=all', adminToken);
  console.log(`Submitted (all): total = ${subAll.data.total} (expected 9)`);
  console.log(`Failed (all):    total = ${failAll.data.total} (expected 10)`);

  const sub7d = await get('/api/admin/applications?status=submitted&scope=7d', adminToken);
  const fail7d = await get('/api/admin/applications?status=failed&scope=7d', adminToken);
  console.log(`Submitted (7d):  total = ${sub7d.data.total} (expected 9)`);
  console.log(`Failed (7d):     total = ${fail7d.data.total} (expected 10)`);

  const subPeriodToday = await get('/api/admin/applications?status=submitted&scope=period&from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59Z', adminToken);
  const failPeriodToday = await get('/api/admin/applications?status=failed&scope=period&from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59Z', adminToken);
  console.log(`Submitted (period Today): total = ${subPeriodToday.data.total} (expected 0)`);
  console.log(`Failed (period Today):    total = ${failPeriodToday.data.total} (expected 0)\n`);

  // Verify column shape on first row
  const sample = failAll.data.applications[0];
  console.log('Sample Failed Application Shape:');
  console.log(JSON.stringify(sample, null, 2));
  console.log();

  // 3. Manager Isolation & Spoofing Check
  console.log('--- 3. MANAGER ISOLATION & QUERY SPOOFING CHECK ---');
  const bSub = await get('/api/manager/applications?status=submitted&scope=all', balajiToken);
  const bFail = await get('/api/manager/applications?status=failed&scope=all', balajiToken);
  console.log(`Balaji Team: Submitted = ${bSub.data.total} (expected 2) | Failed = ${bFail.data.total} (expected 2)`);

  const rkSub = await get('/api/manager/applications?status=submitted&scope=all', rkToken);
  const rkFail = await get('/api/manager/applications?status=failed&scope=all', rkToken);
  console.log(`Ramakrishna Team: Submitted = ${rkSub.data.total} (expected 5) | Failed = ${rkFail.data.total} (expected 8)`);

  // Spoofing test: Balaji token with Ramakrishna manager_id in query parameter
  const spoof = await get(`/api/manager/applications?status=submitted&scope=all&manager_id=bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744`, balajiToken);
  const spoofIgnored = spoof.data.total === bSub.data.total;
  console.log(`manager_id query param spoofing ignored: ${spoofIgnored ? 'CONFIRMED' : 'FAILED'} (got ${spoof.data.total})\n`);

  // 4. Failure Categories Check
  console.log('--- 4. FAILURE CATEGORIES BREAKDOWN (ALL 10 FAILED) ---');
  const catCounts = {};
  for (const app of failAll.data.applications) {
    const cat = app.failure_category || 'Other';
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  console.log(JSON.stringify(catCounts, null, 2));
  const catTotal = Object.values(catCounts).reduce((a, b) => a + b, 0);
  console.log(`Total categorized: ${catTotal} / 10`);

  // 5. Compare with Dashboard Stats Endpoints
  console.log('\n--- 5. LIST TOTALS VS TILE STATS PARITY ---');
  const statsRes = await get('/api/admin/dashboard', adminToken);
  console.log(`Stats Tile submitted_all: ${statsRes.data.tasks.submitted_all} | List total: ${subAll.data.total}`);
  console.log(`Stats Tile submitted_7d:  ${statsRes.data.tasks.submitted_7d}  | List total: ${sub7d.data.total}`);
  console.log(`Stats Tile failed_all:    ${statsRes.data.tasks.failed_all}    | List total: ${failAll.data.total}`);
  console.log(`Stats Tile failed_7d:     ${statsRes.data.tasks.failed_7d}     | List total: ${fail7d.data.total}`);
}

run().catch(console.error);
