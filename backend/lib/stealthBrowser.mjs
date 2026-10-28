/**
 * stealthBrowser.mjs — Playwright Extra with Stealth Plugin
 * 
 * Provides an evasive Chromium launcher pre-configured with puppeteer-extra-plugin-stealth
 * to bypass bot detection, Cloudflare, Datadome, and ATS fingerprinting (Workday, Greenhouse, etc.).
 * Gracefully falls back to standard playwright if stealth packages are not installed.
 */

import { chromium as standardChromium } from 'playwright';

let chromium = standardChromium;
let stealth = null;

try {
  const extra = await import('playwright-extra');
  const stealthModule = await import('puppeteer-extra-plugin-stealth');
  const stealthPlugin = stealthModule.default || stealthModule;
  if (extra?.chromium && typeof stealthPlugin === 'function') {
    stealth = stealthPlugin();
    extra.chromium.use(stealth);
    chromium = extra.chromium;
    console.log('[STEALTH] Playwright stealth plugin initialized successfully.');
  }
} catch (err) {
  console.warn('[STEALTH] Note: playwright-extra / stealth plugin not present; running with standard Playwright chromium.');
  chromium = standardChromium;
}

export { chromium, stealth };
export default chromium;
