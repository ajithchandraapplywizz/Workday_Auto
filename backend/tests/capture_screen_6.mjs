import { chromium } from 'playwright';
import path from 'path';
import { signMfaJwt } from '../lib/mfaAuth.mjs';

const ARTIFACT_DIR = 'C:/Users/ajith/.gemini/antigravity-ide/brain/31622ac3-2e82-454a-8343-7934cf5c3918';
const FRONTEND_URL = 'http://localhost:5182';

async function main() {
  console.log('[SCREENSHOT 6] Launching browser...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('response', r => {
    if (!r.ok()) console.log('HTTP NOT OK:', r.status(), r.url());
  });

  const adminToken = signMfaJwt({
    id: 'a2d27c54-e026-4d61-ba18-a6e154115cbd',
    email: 'ramakrishna@applywizz.ai',
    name: 'Ramakrishna',
    role: 'admin',
    baseRole: 'admin',
  });
  const adminUser = {
    id: 'a2d27c54-e026-4d61-ba18-a6e154115cbd',
    email: 'ramakrishna@applywizz.ai',
    name: 'Ramakrishna',
    role: 'admin',
    baseRole: 'admin',
  };

  // Navigate to frontend first to establish origin
  await page.goto(FRONTEND_URL);
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('applywizz_auth_token', token);
    localStorage.setItem('applywizz_auth_session', JSON.stringify(user));
  }, { token: adminToken, user: adminUser });

  // Reload to let AuthContext initialize with the real admin session
  await page.goto(FRONTEND_URL);
  await page.waitForTimeout(2000);

  // Click "Staff access" sub-tab button
  console.log('Finding Staff access tab...');
  const staffTabBtn = await page.waitForSelector('button:has-text("Staff access")', { timeout: 10000 });
  await staffTabBtn.click();
  console.log('Clicked Staff access tab');

  // Wait for the Staff Authenticator & Access Control header
  await page.waitForSelector('text=STAFF AUTHENTICATOR & ACCESS CONTROL', { timeout: 10000 });
  console.log('Found STAFF AUTHENTICATOR & ACCESS CONTROL header');

  // Wait for table rows to render (buttons: Allow Setup / Reset Authenticator)
  await page.waitForTimeout(3000);

  // Save screenshot
  const outPath = path.join(ARTIFACT_DIR, 'screen_6_admin_staff_access.png');
  await page.screenshot({ path: outPath });
  console.log('Successfully saved screen_6_admin_staff_access.png to:', outPath);

  await browser.close();
  console.log('[SCREENSHOT 6] Done!');
}

main().catch(err => {
  console.error('[SCREENSHOT 6 ERROR]', err);
  process.exit(1);
});
