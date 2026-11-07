/**
 * stealthBrowser.mjs — Playwright Extra with Stealth Plugin & Container-Resilient Cascade
 * 
 * Provides an evasive Chromium launcher pre-configured with puppeteer-extra-plugin-stealth
 * to bypass bot detection, Cloudflare, Datadome, and ATS fingerprinting (Workday, Greenhouse, etc.).
 * 
 * Resilient Multi-Tier Launch Strategy:
 * 1. Stealth + Full Chromium ("New Headless" mode with channel: 'chromium')
 * 2. Stealth + Default Shell (headless fallback)
 * 3. Standard Chromium + Full Chromium (channel: 'chromium')
 * 4. Standard Chromium + Default Shell (hardened container flags)
 * 5. Minimal Safe Container Launch (emergency fallback)
 */

import { chromium as standardChromium } from 'playwright';

let chromium = standardChromium;
let stealth = null;

/**
 * Normalizes and hardens Chromium launch flags for headless container environments (Docker, Railway, Linux).
 * Prevents SIGTRAP crashes caused by SwiftShader, PartitionAlloc, missing GPU, and restricted shared memory.
 */
function prepareLaunchOptions(baseOptions = {}) {
  const isHeadless = baseOptions.headless !== false;

  const defaultContainerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-infobars',
    '--window-size=1280,900',
  ];

  const incomingArgs = Array.isArray(baseOptions.args) ? baseOptions.args : [];

  // Deduplicate args while preserving flags
  const combined = new Set([...defaultContainerArgs]);
  for (const arg of incomingArgs) {
    if (arg) combined.add(arg);
  }

  // Deduplicate comma-separated flags like --disable-blink-features
  const finalArgs = [];
  const blinkFeatures = new Set();
  for (const arg of combined) {
    if (typeof arg === 'string' && arg.startsWith('--disable-blink-features=')) {
      const parts = arg.replace('--disable-blink-features=', '').split(',');
      for (const p of parts) {
        if (p.trim()) blinkFeatures.add(p.trim());
      }
    } else {
      finalArgs.push(arg);
    }
  }

  if (blinkFeatures.size > 0) {
    finalArgs.push(`--disable-blink-features=${Array.from(blinkFeatures).join(',')}`);
  }

  return {
    ...baseOptions,
    headless: isHeadless,
    args: finalArgs,
  };
}

/**
 * Creates a multi-tier resilient launch wrapper around any Playwright Chromium launcher.
 */
function createResilientLauncher(extraLauncher = null) {
  const origExtraLaunch = extraLauncher ? extraLauncher.launch.bind(extraLauncher) : null;
  const origStandardLaunch = standardChromium.launch.bind(standardChromium);

  return async function resilientLaunch(baseOptions = {}) {
    const prepared = prepareLaunchOptions(baseOptions);
    const preferredChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || baseOptions.channel || 'chromium';

    // Tier 1: Stealth launcher with full Chromium channel ("new headless" - avoids chrome-headless-shell SIGTRAP)
    if (origExtraLaunch) {
      try {
        return await origExtraLaunch({
          ...prepared,
          channel: preferredChannel,
        });
      } catch (err1) {
        console.warn(`[STEALTH] Launch with channel "${preferredChannel}" failed (${err1?.message}). Retrying stealth without channel...`);
        // Tier 2: Stealth launcher with default headless shell
        try {
          const { channel: _, ...withoutChannel } = prepared;
          return await origExtraLaunch(withoutChannel);
        } catch (err2) {
          console.warn(`[STEALTH] Stealth launch failed (${err2?.message}), falling back to standard Chromium.`);
        }
      }
    }

    // Tier 3: Standard Chromium with full Chromium channel ("new headless")
    try {
      return await origStandardLaunch({
        ...prepared,
        channel: preferredChannel,
      });
    } catch (err3) {
      console.warn(`[BROWSER] Standard Chromium launch with channel "${preferredChannel}" failed (${err3?.message}). Retrying standard without channel...`);
    }

    // Tier 4: Standard Chromium with default binary and hardened container args
    try {
      const { channel: _, ...withoutChannel } = prepared;
      return await origStandardLaunch(withoutChannel);
    } catch (err4) {
      console.warn(`[BROWSER] Standard Chromium launch without channel failed (${err4?.message}). Attempting minimal safe container launch...`);
    }

    // Tier 5: Minimal emergency container launch
    try {
      const browser = await origStandardLaunch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      console.log('[BROWSER] Minimal emergency Chromium instance launched successfully.');
      return browser;
    } catch (finalErr) {
      console.error('[BROWSER] Critical: All Chromium launch tiers failed:', finalErr?.message);
      throw finalErr;
    }
  };
}

try {
  const extraModule = await import('playwright-extra');
  const stealthModule = await import('puppeteer-extra-plugin-stealth');
  const addExtra = extraModule.addExtra || extraModule.default?.addExtra;
  const stealthPlugin = stealthModule.default || stealthModule;

  if (typeof addExtra === 'function' && typeof stealthPlugin === 'function') {
    const extraChromium = addExtra(standardChromium);
    stealth = stealthPlugin();
    extraChromium.use(stealth);

    extraChromium.launch = createResilientLauncher(extraChromium);
    chromium = extraChromium;
    console.log('[STEALTH] Playwright stealth plugin initialized successfully via addExtra.');
  } else {
    console.warn('[STEALTH] addExtra or stealthPlugin not a function, using standard Playwright chromium.');
    standardChromium.launch = createResilientLauncher(null);
    chromium = standardChromium;
  }
} catch (err) {
  console.warn('[STEALTH] Note: playwright-extra initialization failed:', err?.message, '; running with standard Playwright chromium.');
  standardChromium.launch = createResilientLauncher(null);
  chromium = standardChromium;
}

export { chromium, stealth };
export default chromium;
