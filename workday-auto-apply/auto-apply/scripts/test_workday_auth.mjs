import { chromium } from 'playwright';

const URL = 'https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Software-Development-Engineer---DevOps---Security_JR-0108536';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('Navigating to:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('Page title:', await page.title());
  console.log('Current URL:', page.url());

  const applyBtn = await page.$('a[data-automation-id="applyButton"], button[data-automation-id="applyButton"], a:has-text("Apply")');
  if (applyBtn) {
    console.log('Clicking Apply...');
    await applyBtn.click();
    await page.waitForTimeout(3000);
    console.log('After Apply URL:', page.url());

    const manual = await page.$('[data-automation-id="applyManually"], a:has-text("Apply Manually"), button:has-text("Apply Manually")');
    if (manual) {
      console.log('Clicking Apply Manually...');
      await manual.click();
      await page.waitForTimeout(4000);
      console.log('After Apply Manually URL:', page.url());
    }

    const gatewayElements = await page.$$eval('input, button, a', (els) => els.map(e => ({
      tag: e.tagName,
      text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      autoId: e.getAttribute('data-automation-id'),
      type: e.getAttribute('type'),
      name: e.getAttribute('name'),
      placeholder: e.getAttribute('placeholder'),
      visible: e.offsetParent !== null
    })).filter(e => e.visible && (e.autoId || e.type || e.text)));
    console.log('Visible Gateway Elements:\n', JSON.stringify(gatewayElements, null, 2));

    const ssoEmail = await page.$('button:has-text("Sign in with email"), a:has-text("Sign in with email")');
    if (ssoEmail) {
      console.log('Clicking "Sign in with email"...');
      await ssoEmail.click();
      await page.waitForTimeout(3000);
      console.log('After "Sign in with email" URL:', page.url());

      const afterEmailElements = await page.$$eval('input, button, a', (els) => els.map(e => ({
        tag: e.tagName,
        text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        autoId: e.getAttribute('data-automation-id'),
        type: e.getAttribute('type'),
        name: e.getAttribute('name'),
        placeholder: e.getAttribute('placeholder'),
        visible: e.offsetParent !== null
      })).filter(e => e.visible && (e.autoId || e.type || e.text)));
      console.log('Visible Elements after "Sign in with email":\n', JSON.stringify(afterEmailElements, null, 2));

      const createAccountBtn = await page.$('button[data-automation-id="createAccountLink"], button:has-text("Create Account"), a:has-text("Create Account")');
      if (createAccountBtn) {
        console.log('Found Create Account button/link — clicking...');
        await createAccountBtn.click();
        await page.waitForTimeout(3000);
        console.log('After Create Account click URL:', page.url());

        const createAccountElements = await page.$$eval('input, button, a', (els) => els.map(e => ({
          tag: e.tagName,
          text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          autoId: e.getAttribute('data-automation-id'),
          type: e.getAttribute('type'),
          name: e.getAttribute('name'),
          placeholder: e.getAttribute('placeholder'),
          visible: e.offsetParent !== null
        })).filter(e => e.visible && (e.autoId || e.type || e.text)));
        console.log('Visible Elements on Create Account form:\n', JSON.stringify(createAccountElements, null, 2));
      }
    }
  }

  await browser.close();
}

run().catch(console.error);
