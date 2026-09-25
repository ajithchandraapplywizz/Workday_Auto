/**
 * Local-only Playwright. Never opens a live Workday career site.
 */

import { chromium } from 'playwright';
import { pathToFileURL } from 'url';

export async function launchLocalBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  return { browser, page };
}

export async function openFixture(page, filePath) {
  await page.goto(pathToFileURL(filePath).href, { waitUntil: 'domcontentloaded' });
}

export async function withLocalPage(fn) {
  const { browser, page } = await launchLocalBrowser();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}
