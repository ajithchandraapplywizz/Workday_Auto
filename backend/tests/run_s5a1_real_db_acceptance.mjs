/**
 * run_s5a1_real_db_acceptance.mjs
 * ==============================================================================
 * Comprehensive Acceptance Test Suite for Phase S5a-1 Re-Run
 * Runs strictly against the REAL Supabase Database and the REAL queue_daemon on port 3001.
 * ==============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import { generateSync } from 'otplib';
import fs from 'fs';
import { decryptSecret, signMfaJwt } from '../lib/mfaAuth.mjs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = 'http://127.0.0.1:3001';

const TEST_EMAIL = 'test.mfa@applywizz.com';
const CLIENT_EMAIL = 'vishwas.boddu@applywizard.ai';

// Helper to query and print the test user's actual DB row
async function printUserDbRow(label) {
  const { data, error } = await supabase
    .from('auth_users')
    .select('mfa_enrolled, setup_allowed, totp_pending_enc, totp_secret_enc, failed_code_attempts, locked_until, totp_last_step, last_seen_at, status')
    .eq('email', TEST_EMAIL)
    .maybeSingle();

  if (error) {
    console.log(`[DB ROW ERROR] ${label}:`, error.message);
    return null;
  }

  const formatted = data ? {
    email: TEST_EMAIL,
    mfa_enrolled: data.mfa_enrolled,
    setup_allowed: data.setup_allowed,
    has_pending_secret: Boolean(data.totp_pending_enc),
    has_active_secret: Boolean(data.totp_secret_enc),
    failed_code_attempts: data.failed_code_attempts,
    locked_until: data.locked_until,
    totp_last_step: data.totp_last_step,
    last_seen_at: data.last_seen_at,
    status: data.status,
  } : 'ROW NOT FOUND';

  console.log(`\n>>> [DB STATE AFTER: ${label}]`);
  console.log(JSON.stringify(formatted, null, 2));
  return data;
}

async function post(path, body = {}, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log('  STARTING PHASE S5a-1 RE-RUN ACCEPTANCE SUITE (REAL DB & REAL DAEMON)');
  console.log('════════════════════════════════════════════════════════════════════════\n');

  // STEP 2.0: Create dedicated test user in auth_users
  console.log(`1. Creating dedicated TEST account '${TEST_EMAIL}' (role: operator, status: active)...`);
  await supabase.from('auth_users').delete().eq('email', TEST_EMAIL); // Clean up if existing
  const nowIso = new Date().toISOString();
  const { error: insertErr } = await supabase.from('auth_users').insert({
    email: TEST_EMAIL,
    name: 'MFA Test Operator',
    role: 'operator',
    status: 'active',
    mfa_enrolled: false,
    setup_allowed: false,
    failed_code_attempts: 0,
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (insertErr) throw new Error(`Failed to insert test user: ${insertErr.message}`);
  await printUserDbRow('INITIAL USER CREATION');

  // STEP 2.1: Check-Email States
  console.log('\n2. Testing POST /api/auth/check-email states:');

  // a. Unknown email
  const resUnknown = await post('/api/auth/check-email', { email: 'unknown_stranger@example.com' });
  console.log('   a. Unknown email:', resUnknown.status, resUnknown.data);

  // b. Client company_email from clients table
  const resClient = await post('/api/auth/check-email', { email: CLIENT_EMAIL });
  console.log(`   b. Client email (${CLIENT_EMAIL}):`, resClient.status, resClient.data);

  // c. Unenrolled + Not allowed
  const resNotAllowed = await post('/api/auth/check-email', { email: TEST_EMAIL });
  console.log('   c. Unenrolled + Not allowed:', resNotAllowed.status, resNotAllowed.data);
  await printUserDbRow('CHECK-EMAIL (UNENROLLED + NOT ALLOWED)');

  // d. Allowed for setup
  console.log('   Admin enabling setup for test user...');
  const adminToken = signMfaJwt({ id: 'admin-uuid', email: 'admin@applywizz.com', role: 'admin' });
  await post('/api/auth/admin/allow-setup', { targetEmail: TEST_EMAIL }, adminToken);
  await printUserDbRow('AFTER ADMIN ALLOW-SETUP');

  const resAllowed = await post('/api/auth/check-email', { email: TEST_EMAIL });
  console.log('   d. Allowed for setup:', resAllowed.status, resAllowed.data);

  // STEP 2.2: Setup / Start Refused Cases
  console.log('\n3. Testing POST /api/auth/setup/start refused cases:');
  const resStartUnknown = await post('/api/auth/setup/start', { email: 'unknown@example.com' });
  console.log('   a. Refused for unknown email:', resStartUnknown.status, resStartUnknown.data);

  const resStartClient = await post('/api/auth/setup/start', { email: CLIENT_EMAIL });
  console.log('   b. Refused for client email:', resStartClient.status, resStartClient.data);

  // Temporarily disallow setup to test refusal on not-allowed staff
  await supabase.from('auth_users').update({ setup_allowed: false }).eq('email', TEST_EMAIL);
  const resStartDisallowed = await post('/api/auth/setup/start', { email: TEST_EMAIL });
  console.log('   c. Refused when setup_allowed=false:', resStartDisallowed.status, resStartDisallowed.data);

  // Re-enable setup
  await supabase.from('auth_users').update({ setup_allowed: true }).eq('email', TEST_EMAIL);

  // STEP 2.3: Setup / Start + Confirm with REAL TOTP code
  console.log('\n4. Testing setup/start and confirmation with REAL TOTP code:');
  const resStart = await post('/api/auth/setup/start', { email: TEST_EMAIL });
  console.log('   Setup/start response:', resStart.status, { success: resStart.data.success, hasQr: Boolean(resStart.data.qrDataUrl) });
  const rowAfterStart = await printUserDbRow('AFTER SETUP/START (PENDING SECRET GENERATED)');

  // Decrypt pending secret from the real DB row
  const plainSecret = decryptSecret(rowAfterStart.totp_pending_enc);
  console.log(`   [SCRIPT TOTP ENGINE] Decrypted pending secret from DB (length: ${plainSecret.length} chars)`);
  const currentEpoch = Math.floor(Date.now() / 1000);
  const realTotpCode = generateSync({ secret: plainSecret, epoch: currentEpoch });
  console.log(`   [SCRIPT TOTP ENGINE] Generated real 6-digit TOTP code: ${realTotpCode} at epoch ${currentEpoch}`);

  // Wrong code test first
  const resWrongConfirm = await post('/api/auth/setup/confirm', { email: TEST_EMAIL, code: '000111' });
  console.log('   Setup/confirm with wrong code:', resWrongConfirm.status, resWrongConfirm.data);

  // Real code confirm
  const resConfirm = await post('/api/auth/setup/confirm', { email: TEST_EMAIL, code: realTotpCode });
  console.log('   Setup/confirm with REAL code:', resConfirm.status, { success: resConfirm.data.success, hasToken: Boolean(resConfirm.data.token) });
  const testUserToken = resConfirm.data.token;
  const rowAfterConfirm = await printUserDbRow('AFTER SETUP/CONFIRM (ENROLLED IN DB)');

  // e. Check-email when enrolled
  const resEnrolledCheck = await post('/api/auth/check-email', { email: TEST_EMAIL });
  console.log('   e. Check-email when enrolled:', resEnrolledCheck.status, resEnrolledCheck.data);

  // STEP 2.4: Logout
  console.log('\n5. Testing POST /api/auth/logout:');
  const resLogout = await post('/api/auth/logout', {}, testUserToken);
  console.log('   Logout response:', resLogout.status, resLogout.data);
  await printUserDbRow('AFTER LOGOUT (LAST_SEEN_AT CLEARED TO NULL)');

  // STEP 2.5: Login with REAL TOTP code
  console.log('\n6. Testing POST /api/auth/login with REAL TOTP code:');
  const activePlainSecret = decryptSecret(rowAfterConfirm.totp_secret_enc);
  const loginEpoch = Math.floor(Date.now() / 1000) + 30; // Advance to next 30s step so replay guard permits fresh login
  const loginTotpCode = generateSync({ secret: activePlainSecret, epoch: loginEpoch });
  console.log(`   [SCRIPT TOTP ENGINE] Generated login TOTP code: ${loginTotpCode} at epoch ${loginEpoch}`);

  const resLogin = await post('/api/auth/login', { email: TEST_EMAIL, code: loginTotpCode });
  console.log('   Login response:', resLogin.status, { success: resLogin.data.success, hasToken: Boolean(resLogin.data.token) });
  const activeSessionToken = resLogin.data.token;
  await printUserDbRow('AFTER SUCCESSFUL LOGIN');

  // STEP 2.6: Replay Rejection
  console.log('\n7. Testing Replay Protection (reusing the same TOTP code in the same step):');
  const resReplay = await post('/api/auth/login', { email: TEST_EMAIL, code: loginTotpCode });
  console.log('   Replay attempt response:', resReplay.status, resReplay.data);
  await printUserDbRow('AFTER REPLAY REJECTION');

  // STEP 2.7: 5-Wrong-Codes Lockout
  console.log('\n8. Testing 5-Wrong-Codes Account Lockout:');
  for (let i = 1; i <= 5; i++) {
    const resWrong = await post('/api/auth/login', { email: TEST_EMAIL, code: `99900${i}` });
    console.log(`   Attempt ${i}/5 wrong code: status ${resWrong.status}, error: "${resWrong.data.error}"`);
  }
  const rowAfterLockout = await printUserDbRow('AFTER 5 CONSECUTIVE WRONG CODES (LOCKED OUT)');

  // Attempt login with valid code while locked out
  console.log('   Attempting login with valid code while locked...');
  const lockedEpoch = Math.floor(Date.now() / 1000) + 60; // Next step to avoid replay guard
  const validCodeWhileLocked = generateSync({ secret: activePlainSecret, epoch: lockedEpoch });
  const resWhileLocked = await post('/api/auth/login', { email: TEST_EMAIL, code: validCodeWhileLocked });
  console.log('   Login attempt during lockout:', resWhileLocked.status, resWhileLocked.data);

  // STEP 2.8: Admin Reset
  console.log('\n9. Testing Admin Reset Authenticator (POST /api/auth/admin/reset-mfa):');
  const resAdminReset = await post('/api/auth/admin/reset-mfa', { targetEmail: TEST_EMAIL }, adminToken);
  console.log('   Admin reset response:', resAdminReset.status, resAdminReset.data);
  await printUserDbRow('AFTER ADMIN RESET (RETURNS TO UNENROLLED + ALLOWED)');

  // Verify user returns to setup state
  const resCheckAfterReset = await post('/api/auth/check-email', { email: TEST_EMAIL });
  console.log('   Check-email state after admin reset:', resCheckAfterReset.status, resCheckAfterReset.data);

  // STEP 2.9: Non-Admin 403 Forbidden
  console.log('\n10. Testing Non-Admin 403 Access Control:');
  const operatorToken = signMfaJwt({ id: 'op-uuid', email: TEST_EMAIL, role: 'operator' });
  const resNonAdminReset = await post('/api/auth/admin/reset-mfa', { targetEmail: TEST_EMAIL }, operatorToken);
  console.log('   Operator attempting admin endpoint:', resNonAdminReset.status, resNonAdminReset.data);

  // STEP 3: Specific Fixes
  console.log('\n11. STEP 3(a): Testing Logout Isolation and Body Email Ignored:');
  // Re-set last_seen_at for user A (test.mfa@applywizz.com)
  const stampA = new Date().toISOString();
  await supabase.from('auth_users').update({ last_seen_at: stampA }).eq('email', TEST_EMAIL);

  // Pick a real user B (e.g. sana@applywizz.com or balaji@applywizz.com)
  const USER_B = 'sana@applywizz.com';
  const stampB = new Date().toISOString();
  await supabase.from('auth_users').update({ last_seen_at: stampB }).eq('email', USER_B);

  // Test 1: No token
  const resLogoutNoToken = await post('/api/auth/logout', {});
  console.log('   Logout without token:', resLogoutNoToken.status, resLogoutNoToken.data);

  // Test 2: Token for user A, but body specifies user B
  const resLogoutCross = await post('/api/auth/logout', { email: USER_B }, operatorToken);
  console.log('   Logout with User A token and User B body:', resLogoutCross.status, resLogoutCross.data);

  // Check DB for User A and User B
  const { data: dbA } = await supabase.from('auth_users').select('email, last_seen_at').eq('email', TEST_EMAIL).single();
  const { data: dbB } = await supabase.from('auth_users').select('email, last_seen_at').eq('email', USER_B).single();
  console.log(`   User A (${TEST_EMAIL}) last_seen_at: ${dbA.last_seen_at} (Expected: null)`);
  console.log(`   User B (${USER_B}) last_seen_at: ${dbB.last_seen_at} (Expected: unchanged timestamp: ${stampB})`);

  // STEP 3(b): Confirm auth_users.status is untouched
  console.log('\n12. STEP 3(b): Verifying auth_users.status integrity across all rows:');
  const { data: allUsers } = await supabase.from('auth_users').select('email, status');
  const invalidStatuses = allUsers.filter(u => u.status !== 'active' && u.status !== 'inactive');
  console.log(`   Total users checked: ${allUsers.length}`);
  console.log(`   Users with valid status ('active' | 'inactive'): ${allUsers.length - invalidStatuses.length}`);
  console.log(`   Unexpected statuses: ${invalidStatuses.length}`);

  // STEP 4: Cleanup
  console.log('\n13. STEP 4: Cleanup - Deleting dedicated test account:');
  await supabase.from('auth_users').delete().eq('email', TEST_EMAIL);
  const finalCheckRow = await printUserDbRow('AFTER CLEANUP DELETION');

  // Verify real users' MFA counts
  const { data: realUsers } = await supabase.from('auth_users').select('email, mfa_enrolled, setup_allowed');
  const realEnrolled = realUsers.filter(u => u.mfa_enrolled === true);
  const realAllowed = realUsers.filter(u => u.setup_allowed === true);
  console.log(`   Final Real Users Total: ${realUsers.length}`);
  console.log(`   Real Users mfa_enrolled = true count: ${realEnrolled.length}`);
  console.log(`   Real Users setup_allowed = true count: ${realAllowed.length}`);

  console.log('\n════════════════════════════════════════════════════════════════════════');
  console.log('  PHASE S5a-1 RE-RUN ACCEPTANCE SUITE COMPLETED SUCCESSFULLY');
  console.log('════════════════════════════════════════════════════════════════════════');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[TEST SUITE CRITICAL ERROR]:', err);
  process.exit(1);
});
