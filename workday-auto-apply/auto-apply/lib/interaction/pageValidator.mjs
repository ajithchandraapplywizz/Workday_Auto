/**
 * pageValidator.mjs — Gate before Save and Continue / Next.
 */

import { countUnfilledMandatoryQuestions } from '../workdayQuestionFill.mjs';
import { waitForDomSettled } from '../workdayDom.mjs';

/**
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string} stepName
 */
export async function validatePage(page, profile = {}, stepName = '') {
  await waitForDomSettled(page, { timeout: 800 }).catch(() => {});

  const remaining = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => -1);
  const errors = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      '[data-automation-id*="error"], [aria-invalid="true"], [role="alert"]',
    ));
    return nodes
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && /required|invalid|error|must be|please (enter|select)/i.test(t))
      .slice(0, 8);
  }).catch(() => []);

  const ok = remaining === 0 && errors.length === 0;
  return {
    ok,
    stepName,
    requiredRemaining: remaining,
    errors,
    reason: ok ? '' : (errors[0] || (remaining > 0 ? `${remaining} required empty` : 'page_invalid')),
  };
}
