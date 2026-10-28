import { chromium } from 'playwright';
import path from 'path';
import { generateSync } from 'otplib';
import { signMfaJwt } from '../lib/mfaAuth.mjs';

const ARTIFACT_DIR = 'C:/Users/ajith/.gemini/antigravity-ide/brain/31622ac3-2e82-454a-8343-7934cf5c3918';
const FRONTEND_URL = 'http://localhost:5182';
const DAEMON_URL = 'http://127.0.0.1:3001';
const UNENROLLED_STAFF = 'ali@applywizz.com';
const SETUP_STAFF = 'dayakar@applywizz.com';

async function post(path, body = {}, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function main() {
  console.log('[SCREENSHOT RUNNER] Starting Chrome browser...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const clearAuth = async () => {
    await page.goto(FRONTEND_URL);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page.waitForTimeout(500);
  };

  const adminToken = signMfaJwt({ id: 'admin-uuid', email: 'admin@applywizz.com', role: 'admin' });

  // 1. Blocked unknown email
  console.log('[1/6] Capturing blocked unknown email...');
  await clearAuth();
  await page.fill('#login-email', 'unknown_hacker@stranger.com');
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#login-error-message', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_4_blocked_unknown_email.png') });
  console.log('Saved screen_4_blocked_unknown_email.png');

  // 2. Blocked client email
  console.log('[2/6] Capturing blocked client email...');
  await clearAuth();
  await page.fill('#login-email', 'vishwas.boddu@applywizard.ai');
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#login-error-message', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_3_blocked_client_email.png') });
  console.log('Saved screen_3_blocked_client_email.png');

  // 3. "Ask admin" screen (ali@applywizz.com where setup_allowed=false, mfa_enrolled=false)
  console.log('[3/6] Capturing Ask Admin screen...');
  await clearAuth();
  await page.fill('#login-email', UNENROLLED_STAFF);
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#login-info-message', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_5_ask_admin.png') });
  console.log('Saved screen_5_ask_admin.png');

  // 4. QR setup screen
  console.log('[4/6] Capturing QR setup screen...');
  // Reset MFA for SETUP_STAFF: sets mfa_enrolled=false, setup_allowed=true
  await post('/api/auth/admin/reset-mfa', { targetEmail: SETUP_STAFF }, adminToken);
  await clearAuth();
  await page.fill('#login-email', SETUP_STAFF);
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#mfa-qr-image', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_1_qr_setup.png') });
  console.log('Saved screen_1_qr_setup.png');

  // 5. Code-only screen (enrolled staff user with mfa_enrolled=true)
  console.log('[5/6] Enrolling staff member via real TOTP and capturing Code-only screen...');
  const setupStart = await post('/api/auth/setup/start', { email: SETUP_STAFF });
  const otpUrl = new URL(setupStart.otpauthUri);
  const secret = otpUrl.searchParams.get('secret');
  const realTotpCode = generateSync({ secret });
  console.log('Generated real TOTP code for enrollment confirmation:', realTotpCode);

  const confirmRes = await post('/api/auth/setup/confirm', { email: SETUP_STAFF, code: realTotpCode });
  console.log('Confirm setup result:', confirmRes.success ? 'SUCCESS' : confirmRes.error);

  await clearAuth();
  await page.fill('#login-email', SETUP_STAFF);
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#login-code', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_2_code_only.png') });
  console.log('Saved screen_2_code_only.png');

  // 6. Admin Staff access list with Allow setup / Reset buttons
  console.log('[6/6] Capturing Admin Staff Access list...');
  await page.goto(FRONTEND_URL);
  await page.evaluate(({ token, adminUser }) => {
    localStorage.setItem('applywizz_auth_token', token);
    localStorage.setItem('applywizz_auth_session', JSON.stringify(adminUser));
  }, {
    token: adminToken,
    adminUser: {
      id: 'admin-uuid',
      email: 'admin@applywizz.com',
      role: 'admin',
      baseRole: 'admin',
      name: 'System Admin',
    },
  });

  await page.goto(FRONTEND_URL);
  await page.waitForTimeout(1500);
  const staffTabBtn = await page.waitForSelector('button:has-text("Staff access")', { timeout: 10000 });
  await staffTabBtn.click();
  await page.waitForSelector('text=STAFF AUTHENTICATOR & ACCESS CONTROL', { timeout: 10000 });
  await page.waitForTimeout(2500); // let staff list table rows load from daemon
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'screen_6_admin_staff_access.png') });
  console.log('Saved screen_6_admin_staff_access.png');

  // Clean up: reset test user back to original clean state
  console.log('Cleaning up test user state...');
  await post('/api/auth/admin/reset-mfa', { targetEmail: SETUP_STAFF }, adminToken);
  // And set setup_allowed=false
  const { createClient } = await import('@supabase/supabase-js');
  const env = {};
  (await import('fs')).readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
  });
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.from('auth_users').update({ setup_allowed: false, mfa_enrolled: false }).eq('email', SETUP_STAFF);

  await browser.close();
  console.log('[SCREENSHOT RUNNER] All 6 screenshots successfully captured and saved!');
}

main().catch(err => {
  console.error('[SCREENSHOT RUNNER ERROR]', err);
  process.exit(1);
});
