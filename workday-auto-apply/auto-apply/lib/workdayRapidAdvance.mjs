/**
 * workdayRapidAdvance.mjs — Fast Save and Continue / Next clicks with short DOM polls.
 */

import { waitForDomSettled } from './workdayDom.mjs';
import { detectWorkdayStep } from './stateDetector.mjs';
import { getApplicationQuestionsPageInfo } from './workdayQuestionFill.mjs';

export const RAPID = {
  settleMs: 100,
  pollMs: 80,
  maxPolls: 30,
  burstClicks: 2,
  burstGapMs: 50,
};

/**
 * @param {import('playwright').Page} page
 * @param {string} beforeStep
 * @param {{ aqBefore?: object|null }} [ctx]
 * @returns {Promise<{ changed: boolean, step: string, aqAdvanced?: boolean }>}
 */
export async function waitForWizardProgress(page, beforeStep, ctx = {}) {
  const aqBefore = ctx.aqBefore ?? (beforeStep === 'Application Questions'
    ? await getApplicationQuestionsPageInfo(page).catch(() => null)
    : null);

  for (let i = 0; i < RAPID.maxPolls; i++) {
    const step = await detectWorkdayStep(page);
    if (step === 'Review' || (step && step !== beforeStep)) {
      return { changed: true, step };
    }
    if (beforeStep === 'Application Questions' && aqBefore) {
      const aqAfter = await getApplicationQuestionsPageInfo(page).catch(() => null);
      if (aqAfter && aqAfter.current > aqBefore.current) {
        return { changed: true, step: beforeStep, aqAdvanced: true };
      }
    }
    await waitForDomSettled(page, { timeout: RAPID.settleMs }).catch(() => {});
    await page.waitForTimeout(RAPID.pollMs);
  }
  const step = await detectWorkdayStep(page);
  return { changed: step === 'Review' || step !== beforeStep, step };
}

/**
 * Click the footer Save and Continue / Next (never Submit).
 * @returns {Promise<{ clicked: string|null, submitBlocked?: boolean }>}
 */
export async function clickFooterAdvanceButton(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetParent !== null || el.getClientRects().length > 0);
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const targets = buttons.filter((btn) => {
      if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/submit|apply\s*now|send\s*application|complete\s*application/i.test(t)) return false;
      return /save and continue|save & continue|^next$/i.test(t)
        || btn.getAttribute('data-automation-id') === 'bottom-navigation-next-button'
        || btn.getAttribute('data-automation-id') === 'page-footer-next-button';
    });
    const btn = targets[targets.length - 1];
    if (!btn) return { clicked: null };
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/submit|apply\s*now|send\s*application|complete\s*application/i.test(text)) {
      return { clicked: null, submitBlocked: true };
    }
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return { clicked: text || 'Save and Continue' };
  });
}

/**
 * Burst-click advance then poll until step changes or max polls.
 */
export async function rapidAdvanceOnce(page, beforeStep) {
  const aqBefore = beforeStep === 'Application Questions'
    ? await getApplicationQuestionsPageInfo(page).catch(() => null)
    : null;

  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    document.querySelector('[data-automation-id="footerContainer"], footer')?.scrollIntoView({ block: 'end' });
  }).catch(() => {});

  let lastClick = null;
  for (let b = 0; b < RAPID.burstClicks; b++) {
    const hit = await clickFooterAdvanceButton(page);
    if (hit.submitBlocked) return { transitioned: false, submitBlocked: true, step: beforeStep };
    if (hit.clicked) {
      lastClick = hit.clicked;
      if (b < RAPID.burstClicks - 1) await page.waitForTimeout(RAPID.burstGapMs);
    }
  }

  if (!lastClick) return { transitioned: false, step: beforeStep, hasSaveButton: false };

  try {
    await page.waitForSelector('[data-automation-id="loading-spinner"], div[class*="loading-spinner"]', {
      state: 'detached',
      timeout: 8000,
    });
  } catch { /* spinner optional */ }

  const prog = await waitForWizardProgress(page, beforeStep, { aqBefore });
  return {
    transitioned: prog.changed,
    step: prog.step || beforeStep,
    hasSaveButton: true,
    clicked: lastClick,
    aqPageAdvanced: prog.aqAdvanced === true,
  };
}
