/**
 * selectVerified.mjs — Verified Workday Select State Machine.
 * 
 * Activated under STRICT_FILL=1 (additive only).
 * 
 * Strict 4-step state machine:
 * 1. open: Click trigger, wait for visible [role="listbox"] portal anywhere in document.
 * 2. match: Match option (exact -> synonym -> fuzzy unless negation words present).
 * 3. click_and_detach: Click matched live option, wait for listbox to close/detach.
 * 4. verify: Read button text and verify expected == actual.
 * 
 * Attempt 2 fallback: Keyboard route (focus, type first letters, Enter).
 */

import { waitForDomSettled } from '../workdayDom.mjs';
import { okResult, failResult } from './_result.mjs';

const LISTBOX_SELECTOR = '[role="listbox"], [data-automation-id="promptPopup"], [data-automation-id="promptOption"], [role="option"]';
const OPTION_SELECTOR = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [data-automation-id="menuItem"]';
const NEGATION_RE = /\b(no|not|never|don't|without|non)\b/i;

const SYNONYMS = new Map([
  ['yes', ['yes', 'y', 'true']],
  ['y', ['yes', 'y', 'true']],
  ['no', ['no', 'n', 'false']],
  ['n', ['no', 'n', 'false']],
  ['true', ['true', 'yes', 'y']],
  ['false', ['false', 'no', 'n']],
]);

/**
 * Match answer to options:
 * 1. Exact normalized match
 * 2. Synonym map
 * 3. Fuzzy (ONLY if neither side contains negation words)
 */
export function matchOptionSafely(answer = '', options = []) {
  const normA = String(answer || '').trim().toLowerCase();
  if (!normA || !options.length) return { match: null, reason: 'empty_input' };

  // 1. Exact normalized
  const exact = options.find((o) => String(o || '').trim().toLowerCase() === normA);
  if (exact) return { match: exact, strategy: 'exact' };

  // 2. Synonym map
  const synList = SYNONYMS.get(normA);
  if (synList) {
    const synHit = options.find((o) => synList.includes(String(o || '').trim().toLowerCase()));
    if (synHit) return { match: synHit, strategy: 'synonym' };
  }

  // 3. Check for negation
  const aHasNegation = NEGATION_RE.test(normA);
  const candidates = options.filter((o) => {
    const oHasNegation = NEGATION_RE.test(String(o || ''));
    if (aHasNegation !== oHasNegation) return false; // Never mix negation and non-negation
    return true;
  });

  if (aHasNegation) {
    // If negation is involved, we reject fuzzy match to prevent "require sponsorship" matching "do not require"
    return { match: null, reason: 'negation_requires_exact_match' };
  }

  // 4. Prefix / subset matching for non-negation items ONLY if unique
  const prefixHits = candidates.filter((o) => {
    const normO = String(o || '').trim().toLowerCase();
    // Ensure word boundary or delimiter to prevent accidental substring false-positives
    return normO === normA
      || normO.startsWith(`${normA} `)
      || normO.startsWith(`${normA}(`)
      || normO.startsWith(`${normA},`)
      || normA.startsWith(`${normO} `);
  });

  if (prefixHits.length === 1) {
    return { match: prefixHits[0], strategy: 'unique_prefix' };
  }
  if (prefixHits.length > 1) {
    return { match: null, reason: 'ambiguous_prefix_match' };
  }

  // 5. Degree semantic bucket matching for verbose degrees
  if (/master|bachelor|ph\.?d|doctor|associate|high\s*school/i.test(normA)) {
    const isMaster = /master|ms\b|m\.s\./i.test(normA) && !/bachelor/i.test(normA);
    const isBachelor = /bachelor|b\.?tech|btech|bs\b/i.test(normA) && !/master/i.test(normA);
    const isDoctor = /doctor|ph\.?d/i.test(normA);
    const isAssociate = /associate/i.test(normA);

    const degCandidate = candidates.find((o) => {
      const normO = String(o || '').trim().toLowerCase();
      if (/none\s+of\s+the\s+above|not\s+applicable/i.test(normO)) return false;
      if (isMaster && /master/i.test(normO)) return true;
      if (isBachelor && /bachelor/i.test(normO)) return true;
      if (isDoctor && /doctor|ph\.?d/i.test(normO)) return true;
      if (isAssociate && /associate/i.test(normO)) return true;
      return false;
    });

    if (degCandidate) {
      return { match: degCandidate, strategy: 'degree_bucket' };
    }
  }

  return { match: null, reason: 'no_safe_option_match' };
}

/**
 * Executes the 4-step verified state machine for single-select dropdowns.
 */
export async function fillSelectVerified(page, field, answer, ctx = {}) {
  const label = field.label || '';
  const triggerSelector = `button[aria-haspopup], [role="combobox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, [data-automation-id="selectWidget"], [data-automation-id="selectOne"], button`;

  // Locate trigger control
  let trigger = null;
  const qId = field.questionId || field._raw?.wdQId;
  if (qId) {
    trigger = page.locator(`[data-wd-q-id="${qId}"]`).locator(triggerSelector).first();
  }
  if (!trigger || !(await trigger.count())) {
    const container = page.locator('[data-automation-id*="formField"], [data-automation-id*="question"], fieldset, [role="group"]').filter({ hasText: label.slice(0, 40) }).first();
    if (await container.count()) {
      trigger = container.locator(triggerSelector).first();
    }
  }
  if (!trigger || !(await trigger.count())) {
    trigger = page.getByRole('button', { name: new RegExp(label.slice(0, 60), 'i') }).first();
  }
  if (!trigger || !(await trigger.count())) {
    trigger = page.locator(triggerSelector).filter({ hasText: new RegExp(label.slice(0, 40), 'i') }).first();
  }

  if (!trigger || !(await trigger.isVisible({ timeout: 1500 }).catch(() => false))) {
    return failResult(field, 'select_trigger_not_found', { recoverable: true, step: 'locate_trigger' });
  }

  // Step 1: Open trigger & wait for listbox portal
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true }).catch(() => {});
  
  const listboxOpened = await page.waitForSelector(LISTBOX_SELECTOR, { timeout: 2500, state: 'visible' }).catch(() => null);
  if (!listboxOpened) {
    // Fallback: keyboard Enter to open
    await trigger.focus().catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    const retryOpen = await page.waitForSelector(LISTBOX_SELECTOR, { timeout: 1500, state: 'visible' }).catch(() => null);
    if (!retryOpen) {
      return failResult(field, 'wait_listbox_open_failed', { recoverable: true, step: 'wait_listbox_open' });
    }
  }

  // Step 2: Read live options & match
  const liveOptionElements = page.locator(OPTION_SELECTOR);
  const optCount = await liveOptionElements.count().catch(() => 0);
  const liveTexts = [];
  for (let i = 0; i < optCount; i++) {
    const t = (await liveOptionElements.nth(i).textContent().catch(() => '') || '').trim();
    if (t && !/^select(\s+one)?\.?$/i.test(t)) {
      liveTexts.push(t);
    }
  }

  const matchResult = matchOptionSafely(answer, liveTexts);
  if (!matchResult.match) {
    await page.keyboard.press('Escape').catch(() => {});
    return failResult(field, `match_live_option_failed:${matchResult.reason}`, {
      recoverable: false,
      step: 'match_live_option',
      options: liveTexts,
    });
  }

  const targetOptionText = matchResult.match;

  // Step 3: Click matched option & wait for detach
  const optionLoc = page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(`^\\s*${targetOptionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
  if (await optionLoc.isVisible().catch(() => false)) {
    await optionLoc.click({ force: true }).catch(() => {});
  } else {
    // Keyboard fallback route
    await page.keyboard.type(targetOptionText.slice(0, 3), { delay: 40 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }

  await waitForDomSettled(page, { timeout: 800 }).catch(() => {});

  // Wait listbox detach
  const detached = await page.waitForSelector(LISTBOX_SELECTOR, { timeout: 1500, state: 'detached' }).catch(() => null);
  if (!detached) {
    await page.keyboard.press('Escape').catch(() => {});
  }

  // Step 4: Verify read-back from trigger button
  let actualText = (await trigger.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  if (!actualText || /^select(\s+one)?\.?$/i.test(actualText)) {
    if (qId) {
      const selItem = page.locator(`[data-wd-q-id="${qId}"]`).locator('[data-automation-id="selectedItem"], [data-automation-id="promptSelectedItem"]').first();
      const t = (await selItem.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
      if (t && !/^select(\s+one)?\.?$/i.test(t)) actualText = t;
    }
  }
  const verified = actualText.toLowerCase().includes(targetOptionText.toLowerCase())
    || targetOptionText.toLowerCase().includes(actualText.toLowerCase());

  if (verified && !/^select(\s+one)?\.?$/i.test(actualText)) {
    return okResult(field, actualText, 1);
  }

  return failResult(field, 'read_button_text_mismatch', {
    recoverable: true,
    step: 'read_button_text_mismatch',
    expected: targetOptionText,
    actual: actualText,
  });
}
