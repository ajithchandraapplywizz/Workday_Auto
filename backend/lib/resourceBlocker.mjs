/**
 * resourceBlocker.mjs — High-Efficiency Network & RAM Optimizer for Playwright
 *
 * Drastically reduces bandwidth (network egress) and RAM/CPU consumption by:
 * 1. Blocking heavy non-essential media: images, videos, audio, custom fonts, text tracks.
 * 2. Blocking third-party trackers, analytics, ad networks, and marketing telemetry.
 * 3. Permitting only essential resources needed for ATS wizard form filling:
 *    - document (HTML)
 *    - script (JavaScript application code)
 *    - stylesheet (CSS layout & styling)
 *    - xhr / fetch (API requests & resume uploads)
 */

const BLOCKED_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'texttrack',
  'beacon',
  'csp_report',
  'imageset',
]);

const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'adservice.google',
  'connect.facebook.net',
  'snap.licdn.com',
  'linkedin.com/li/track',
  'hotjar.com',
  'clarity.ms',
  'segment.io',
  'segment.com',
  'datadoghq.com',
  'browser-intake',
  'newrelic.com',
  'nr-data.net',
  'intercom.io',
  'drift.com',
  'crazyegg.com',
  'fullstory.com',
  'tiktok.com',
  'youtube.com',
  'vimeo.com',
  'branch.io',
  'optimizely.com',
  'quantummetric.com',
  'bat.bing.com',
];

/**
 * Attaches request interception to a Playwright BrowserContext or Page.
 *
 * @param {import('playwright').BrowserContext | import('playwright').Page} target
 */
export async function setupResourceBlocker(target) {
  if (process.env.BLOCK_HEAVY_ASSETS === 'false') {
    return;
  }

  try {
    await target.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url().toLowerCase();

      // 1. Block heavy asset types
      if (BLOCKED_RESOURCE_TYPES.has(type)) {
        return route.abort().catch(() => {});
      }

      // 2. Block tracking, ads, and telemetry scripts
      for (const domain of BLOCKED_DOMAINS) {
        if (url.includes(domain)) {
          return route.abort().catch(() => {});
        }
      }

      // 3. Allow essential assets for ATS interaction
      return route.continue().catch(() => {});
    });
  } catch (err) {
    console.warn('[RESOURCE BLOCKER] Failed to attach route interceptor:', err?.message);
  }
}
