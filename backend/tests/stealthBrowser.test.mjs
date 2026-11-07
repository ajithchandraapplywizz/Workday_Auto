import { test } from 'node:test';
import assert from 'node:assert/strict';
import chromium, { stealth } from '../lib/stealthBrowser.mjs';

test('stealthBrowser exports valid chromium launcher and stealth instance', () => {
  assert.ok(chromium, 'chromium export must be defined');
  assert.equal(typeof chromium.launch, 'function', 'chromium.launch must be a function');
});

test('stealthBrowser launches Chromium cleanly in headless container-safe mode', async () => {
  const browser = await chromium.launch({ headless: true });
  assert.ok(browser, 'Browser instance must be created');
  assert.ok(browser.version(), 'Browser version must be a non-empty string');

  const context = await browser.newContext();
  const page = await context.newPage();
  assert.ok(page, 'New page must be created successfully');

  // Verify navigator.webdriver evasion
  const webdriverVal = await page.evaluate(() => navigator.webdriver);
  assert.ok(webdriverVal === false || webdriverVal === undefined, 'navigator.webdriver must be undefined or false');

  await page.close();
  await context.close();
  await browser.close();
});
