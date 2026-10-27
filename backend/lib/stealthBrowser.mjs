/**
 * stealthBrowser.mjs — Playwright Extra with Stealth Plugin
 * 
 * Provides an evasive Chromium launcher pre-configured with puppeteer-extra-plugin-stealth
 * to bypass bot detection, Cloudflare, Datadome, and ATS fingerprinting (Workday, Greenhouse, etc.).
 */

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

// Register the stealth plugin on the Playwright Extra chromium instance
const stealth = stealthPlugin();
chromium.use(stealth);

export { chromium, stealth };
export default chromium;
