import { chromium } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/node_modules/playwright/index.mjs';
import { signJwt } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/authService.mjs';
import path from 'path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const artifactDir = 'C:\\Users\\ajith\\.gemini\\antigravity-ide\\brain\\c003c768-63a6-4a39-a844-2ccb53d0d663';

async function runBrowserAcceptance() {
  console.log('=== RUNNING REAL BROWSER ACCEPTANCE TESTS ===\n');

  // Sign valid admin JWT
  const adminToken = signJwt({
    email: 'admin@applywizz.ai',
    role: 'admin',
    name: 'Admin User',
    manager_id: null
  });

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const networkRequests = [];
  const networkErrors = [];

  page.on('request', req => {
    networkRequests.push({ url: req.url(), method: req.method() });
  });

  page.on('response', res => {
    if (res.status() >= 400) {
      networkErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  // Navigate & inject admin auth token & session
  await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('applywizz_auth_token', tok);
    localStorage.setItem('applywizz_auth_session', JSON.stringify({
      email: 'admin@applywizz.ai',
      role: 'admin',
      baseRole: 'admin',
      name: 'Admin User',
      timeframe: 'day',
      date: '2026-10-12'
    }));
  }, adminToken);

  console.log('Reloading with Admin session & JWT token...');
  await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // 1. Check network requests for /api/admin/dashboard and direct Supabase calls
  const adminApiCall = networkRequests.find(r => r.url.includes('/api/admin/dashboard'));
  console.log('GET /api/admin/dashboard request made:', Boolean(adminApiCall));
  console.log('Network 4xx/5xx errors:', networkErrors);

  // Take Overview screenshot
  const screenshotOverview = path.join(artifactDir, 'phase_e_overview_screenshot.png');
  await page.screenshot({ path: screenshotOverview, fullPage: true });
  console.log('Saved Overview screenshot to:', screenshotOverview);

  // 2. Read KPI Tiles from DOM (Range = ALL)
  const readKpis = async () => {
    return await page.evaluate(() => {
      const boxes = document.querySelectorAll('.video-kpi-box');
      const res = {};
      boxes.forEach(b => {
        const label = b.querySelector('.vkpi-label')?.innerText?.trim();
        const val = b.querySelector('.vkpi-val')?.innerText?.trim();
        if (label) res[label] = val;
      });
      return res;
    });
  };

  const kpisAll = await readKpis();
  console.log('\nKPI Tiles in DOM (Range = ALL):', JSON.stringify(kpisAll, null, 2));

  // 3. Test Range Selector
  console.log('\nTesting Range Selector buttons...');
  const rangeButtons = await page.$$('button:has-text("Today"), button:has-text("7 Days"), button:has-text("30 Days"), button:has-text("All Time")');
  console.log(`Found ${rangeButtons.length} range buttons.`);

  // Click "Today"
  await page.click('button:has-text("Today")');
  await page.waitForTimeout(2000);
  const kpisToday = await readKpis();
  console.log('KPI Tiles in DOM (Range = TODAY):', JSON.stringify(kpisToday, null, 2));

  // Click back to "All Time"
  await page.click('button:has-text("All Time")');
  await page.waitForTimeout(2000);

  // 4. Test Managers Tab
  console.log('\nNavigating to Managers Tab...');
  await page.click('button:has-text("Managers")');
  await page.waitForTimeout(2000);

  const screenshotManagers = path.join(artifactDir, 'phase_e_managers_screenshot.png');
  await page.screenshot({ path: screenshotManagers, fullPage: true });
  console.log('Saved Managers screenshot to:', screenshotManagers);

  const managerRows = await page.evaluate(() => {
    const rows = document.querySelectorAll('.video-data-table tbody tr');
    const res = [];
    rows.forEach(r => {
      const cols = Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim());
      if (cols.length > 0) res.push(cols);
    });
    return res;
  });
  console.log('Manager & Reconciliation Table Rows:', JSON.stringify(managerRows, null, 2));

  await browser.close();
  console.log('\n=== REAL BROWSER ACCEPTANCE COMPLETED SUCCESSFULLY ===');
}

runBrowserAcceptance().catch(err => {
  console.error('Browser acceptance failed:', err);
  process.exit(1);
});
