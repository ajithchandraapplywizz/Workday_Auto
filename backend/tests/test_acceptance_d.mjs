import { chromium } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/node_modules/playwright/index.mjs';
import { signJwt } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/authService.mjs';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/supabaseClient.mjs';

loadLocalEnvOnce();

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testLivePollUpdate() {
  console.log('=== ACCEPTANCE TEST D: LIVE TILE UPDATE WITHIN 30S WITHOUT REFRESH ===\n');

  const adminToken = signJwt({
    email: 'admin@applywizz.ai',
    role: 'admin',
    name: 'Admin User'
  });

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
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

  await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const getSubmittedCount = async () => {
    return await page.evaluate(() => {
      const boxes = document.querySelectorAll('.video-kpi-box');
      for (const b of boxes) {
        if (b.querySelector('.vkpi-label')?.innerText?.trim() === 'SUBMITTED') {
          return b.querySelector('.vkpi-val')?.innerText?.trim();
        }
      }
      return null;
    });
  };

  const initialSubmitted = await getSubmittedCount();
  console.log(`Initial SUBMITTED count in browser: ${initialSubmitted}`);

  // Find a ready_for_review task to temporarily toggle to submitted
  const { data: testTask, error: findErr } = await supabase
    .from('submission_tasks')
    .select('id, status')
    .eq('status', 'ready_for_review')
    .limit(1)
    .single();

  if (findErr || !testTask) {
    throw new Error('Could not find test task to update');
  }

  console.log(`Toggling task ${testTask.id} status: ready_for_review -> submitted...`);
  const nowIso = new Date().toISOString();
  await supabase
    .from('submission_tasks')
    .update({ status: 'submitted', updated_at: nowIso })
    .eq('id', testTask.id);

  // Poll browser DOM every 1s without refresh for up to 35s
  const startTime = Date.now();
  let updatedSubmitted = initialSubmitted;
  while (Date.now() - startTime < 35000) {
    await page.waitForTimeout(1000);
    updatedSubmitted = await getSubmittedCount();
    if (updatedSubmitted !== initialSubmitted) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✓ SUBMITTED tile updated from ${initialSubmitted} to ${updatedSubmitted} after ${elapsed}s WITHOUT refresh!`);
      break;
    }
  }

  // Revert the task back
  console.log(`Reverting task ${testTask.id} back to ready_for_review...`);
  await supabase
    .from('submission_tasks')
    .update({ status: 'ready_for_review', updated_at: new Date().toISOString() })
    .eq('id', testTask.id);

  await browser.close();

  if (updatedSubmitted === initialSubmitted) {
    throw new Error('Tile did not update within 35s');
  }

  console.log('=== TEST D PASSED: Live dynamic tile update verified! ===\n');
}

testLivePollUpdate().catch(err => {
  console.error('Test D failed:', err);
  process.exit(1);
});
