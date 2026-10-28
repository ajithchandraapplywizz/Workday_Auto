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
  const extraModule = await import('playwright-extra');
  const stealthModule = await import('puppeteer-extra-plugin-stealth');
  const addExtra = extraModule.addExtra || extraModule.default?.addExtra;
  const stealthPlugin = stealthModule.default || stealthModule;

  if (typeof addExtra === 'function' && typeof stealthPlugin === 'function') {
    const extraChromium = addExtra(standardChromium);
    stealth = stealthPlugin();
    extraChromium.use(stealth);

    // Defensive launch wrapper: if stealth launch throws, fall back to standard chromium
    const origLaunch = extraChromium.launch.bind(extraChromium);
    extraChromium.launch = async function (launchOptions) {
      try {
        return await origLaunch(launchOptions);
      } catch (launchErr) {
        console.warn(`[STEALTH] Stealth launch failed (${launchErr?.message}), falling back to standard Chromium.`);
        return await standardChromium.launch(launchOptions);
      }
    };

    chromium = extraChromium;
    console.log('[STEALTH] Playwright stealth plugin initialized successfully via addExtra.');
  } else {
    console.warn('[STEALTH] addExtra or stealthPlugin not a function, using standard Playwright chromium.');
  }
} catch (err) {
  console.warn('[STEALTH] Note: playwright-extra initialization failed:', err?.message, '; running with standard Playwright chromium.');
  chromium = standardChromium;
}

export { chromium, stealth };
export default chromium;
