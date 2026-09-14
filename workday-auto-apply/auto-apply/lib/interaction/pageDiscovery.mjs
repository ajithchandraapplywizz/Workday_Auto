/**
 * pageDiscovery.mjs — Stabilize, discover, normalize. No answering.
 */

import {
  waitForDomSettled,
  discoverFormFieldQuestions,
  discoverWorkdayFields,
} from '../workdayDom.mjs';
import { normalizeDiscoveredFields } from './fieldSchema.mjs';

/**
 * @param {import('playwright').Page} page
 * @param {{ pageNumber?: number, stepName?: string }} [meta]
 */
export async function discoverPage(page, meta = {}) {
  await waitForDomSettled(page, { timeout: 2000 }).catch(() => {});

  const [formQuestions, domFields, chrome] = await Promise.all([
    discoverFormFieldQuestions(page).catch(() => []),
    discoverWorkdayFields(page).catch(() => []),
    page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
        .filter((el) => el.offsetParent || el.getClientRects().length)
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80));
      const iframes = Array.from(document.querySelectorAll('iframe'))
        .map((el) => el.getAttribute('title') || el.getAttribute('name') || el.src || '')
        .filter(Boolean);
      return { dialogs, iframes };
    }).catch(() => ({ dialogs: [], iframes: [] })),
  ]);

  const merged = [];
  const seen = new Set();
  for (const raw of [...formQuestions, ...domFields]) {
    const key = String(raw.label || raw.id || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(raw);
  }

  return {
    stepName: meta.stepName || '',
    pageNumber: meta.pageNumber || 1,
    url: page.url(),
    fields: normalizeDiscoveredFields(merged, meta),
    dialogs: chrome.dialogs || [],
    iframes: chrome.iframes || [],
    rawCount: { formQuestions: formQuestions.length, domFields: domFields.length },
  };
}
