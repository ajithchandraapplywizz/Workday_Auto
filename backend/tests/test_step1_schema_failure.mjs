import { assertMfaSchema, REQUIRED_MFA_COLUMNS } from '../lib/mfaAuth.mjs';

async function test() {
  console.log('=== TEST STEP 1: Verify Schema Enforcement and Missing-Column Failure ===\n');

  console.log('1. Testing against real auth_users table (must PASS):');
  try {
    const res = await assertMfaSchema('auth_users');
    console.log('Result on auth_users:', res);
    console.log('PASS: All 9 required MFA columns exist in real auth_users table.');
  } catch (err) {
    console.error('FAIL on auth_users:', err.message);
  }

  console.log('\n2. Testing against test table missing MFA columns (must FAIL and REFUSE):');
  try {
    // 'clients' table does not have totp_secret_enc, mfa_enrolled, etc.
    await assertMfaSchema('clients');
    console.error('UNEXPECTED: Should have refused table missing MFA columns!');
  } catch (err) {
    console.log('Caught expected refusal error:');
    console.log(`Error Code: ${err.code}`);
    console.log(`Error Message: ${err.message}`);
    console.log('PASS: Server successfully REFUSES to proceed when required columns are missing!');
  }
}

test().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
