/**
 * workdayQuestionFill.mjs — Fill Workday dropdown/combobox questions by label
 */

import { writeFile } from 'fs/promises';
import { handleDropdown, clickVisiblePromptOption, fuzzyScore } from './fields.mjs';
import { lookupDefaultAnswer } from './workdayDefaults.mjs';
import { normalizeLabel, findBestMatch, loadSettings, createQAStore, isSalaryQuestion } from './qaStore.mjs';
import { waitForDomSettled, discoverFormFieldQuestions, isFormFieldValueFilled } from './workdayDom.mjs';
import { mapLabelToProfileValue, resolveField } from './planner.mjs';
import {
  getTodayMMDDYYYY,
  getTodayISODate,
  buildCurrentDateAction,
  validateMMDDYYYY,
  validateISODate,
  createManualReviewItem,
} from './date-utils.mjs';

const VIBE_ACK_LABEL = 'I acknowledge Workday\'s Recruitment Privacy Statement and VIBE Philosophy.';
const VIBE_ACK_KEY = 'VIBE Privacy acknowledgment';

function isCheckboxOnlyLabel(label) {
  return /recruitment privacy statement.*vibe|i acknowledge workday.*vibe|vibe philosophy/i.test(String(label));
}

function isGenderLabel(label) {
  return /^gender\s*$/i.test(String(label).replace(/\*+/g, '').trim());
}

async function selectCurrentDateFromCalendar(page, fieldBox, dateInput, timeZone) {
  const dateValue = getTodayMMDDYYYY(timeZone);
  const [, month, day, year] = dateValue.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [];
  if (!month || !day || !year) return false;

  const monthName = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
  }).format(new Date(`${year}-${month}-${day}T12:00:00Z`));
  const accessibleDate = `${monthName} ${Number(day)}, ${year}`;
  const pickerButton = fieldBox.locator(
    'button[aria-label*="calendar" i], button[aria-label*="date picker" i], [data-automation-id*="datePicker"] button, [data-automation-id*="calendar"] button'
  ).first();

  if (await pickerButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await pickerButton.click({ force: true });
  } else {
    await dateInput.click({ force: true }).catch(() => {});
  }

  const exactDateButton = page.locator(
    `button[aria-label*="${accessibleDate}"], [role="gridcell"][aria-label*="${accessibleDate}"]`
  ).first();
  if (await exactDateButton.isVisible({ timeout: 800 }).catch(() => false)) {
    await exactDateButton.click({ force: true });
    return true;
  }

  const activeDateButton = page.locator(
    '[aria-current="date"], [aria-selected="true"], [data-selected="true"], [data-current="true"]'
  ).filter({ hasText: new RegExp(`^${Number(day)}$`) }).first();
  if (await activeDateButton.isVisible({ timeout: 800 }).catch(() => false)) {
    await activeDateButton.click({ force: true });
    return true;
  }

  const dayButton = page
    .locator('button, [role="button"], [role="gridcell"]')
    .filter({ hasText: new RegExp(`^${Number(day)}$`) })
    .first();
  if (await dayButton.isVisible({ timeout: 800 }).catch(() => false)) {
    await dayButton.click({ force: true });
    return true;
  }

  return false;
}

/**
 * DOM snapshot of Voluntary Disclosures controls (audit + fill).
 * @param {import('playwright').Page} page
 */
export async function discoverVoluntaryDisclosureDom(page) {
  return await page.evaluate(() => {
    const result = {
      gender: { label: null, currentValue: '', hasCombobox: false },
      vibeAck: { label: null, checked: false, found: false },
      checkboxes: [],
    };

    const fields = document.querySelectorAll('[data-automation-id*="formField"], fieldset, [role="group"]');
    for (const field of fields) {
      const labelEl = field.querySelector('label, legend');
      const labelText = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!labelText) continue;

      if (/^gender\b/i.test(labelText)) {
        const combo = field.querySelector('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id*="select"]');
        const valEl = field.querySelector('[data-automation-id="selectWidget"] button, [role="combobox"]');
        result.gender = {
          label: labelText.replace(/\*+$/, ''),
          currentValue: (valEl?.textContent || '').trim(),
          hasCombobox: Boolean(combo),
        };
      }

      if (/recruitment privacy statement.*vibe philosophy/i.test(labelText)) {
        const id = labelEl?.getAttribute('for');
        let cb = id ? document.getElementById(id) : null;
        if (!cb) cb = field.querySelector('input[type="checkbox"]');
        if (!cb) {
          const parent = labelEl?.closest('div');
          cb = parent?.querySelector('input[type="checkbox"]') || field.querySelector('input[type="checkbox"]');
        }
        result.vibeAck = {
          label: labelText.replace(/\*+$/, ''),
          checked: Boolean(cb?.checked),
          found: Boolean(cb),
        };
      }
    }

    if (!result.vibeAck.found) {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const labelEl of labels) {
        const t = (labelEl.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/recruitment privacy statement.*vibe philosophy/i.test(t)) continue;
        const id = labelEl.getAttribute('for');
        let cb = id ? document.getElementById(id) : labelEl.querySelector('input[type="checkbox"]');
        if (!cb) {
          const wrap = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement;
          cb = wrap?.querySelector('input[type="checkbox"]');
        }
        result.vibeAck = {
          label: t.replace(/\*+$/, ''),
          checked: Boolean(cb?.checked),
          found: Boolean(cb),
        };
        break;
      }
    }

    document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const label = cb.id
        ? document.querySelector(`label[for="${cb.id}"]`)?.textContent?.trim()
        : cb.closest('label')?.textContent?.trim();
      if (label) {
        result.checkboxes.push({ label: label.slice(0, 120), checked: cb.checked });
      }
    });

    return result;
  });
}

/**
 * Check VIBE / Privacy acknowledgment exactly once (skip if already checked or recorded).
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<boolean>}
 */
export async function acknowledgeVibePrivacyOnce(page, profile) {
  const dom = await discoverVoluntaryDisclosureDom(page);
  console.log(`    📋 DOM: VIBE ack found=${dom.vibeAck.found} checked=${dom.vibeAck.checked}`);

  if (profile?._filledValues?.[VIBE_ACK_KEY] === 'Yes' && dom.vibeAck.checked) {
    console.log('    ✓ VIBE acknowledgment already recorded and checked — skipping');
    return true;
  }

  if (dom.vibeAck.found && dom.vibeAck.checked) {
    if (profile) recordField(profile, VIBE_ACK_KEY, 'Yes');
    console.log('    ✓ VIBE acknowledgment already checked in DOM');
    return true;
  }

  const clicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find(l =>
      /recruitment privacy statement.*vibe philosophy/i.test((l.textContent || '').replace(/\s+/g, ' '))
    );
    if (!target) return false;

    const id = target.getAttribute('for');
    let cb = id ? document.getElementById(id) : null;
    if (!cb) {
      const wrap = target.closest('[data-automation-id*="formField"]') || target.parentElement;
      cb = wrap?.querySelector('input[type="checkbox"]');
    }
    if (!cb || cb.type !== 'checkbox') return false;
    if (cb.checked) return true;
    cb.click();
    return cb.checked;
  });

  if (clicked) {
    if (profile) recordField(profile, VIBE_ACK_KEY, 'Yes');
    console.log('    ☑️  VIBE / Privacy acknowledgment checked (once)');
    await waitForDomSettled(page);
    return true;
  }

  const fallback = page.locator('label').filter({ hasText: /Recruitment Privacy Statement.*VIBE Philosophy/i }).locator('..').locator('input[type="checkbox"]').first();
  if (await fallback.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await fallback.isChecked().catch(() => false))) {
      await fallback.click({ force: true });
    }
    if (profile) recordField(profile, VIBE_ACK_KEY, 'Yes');
    console.log('    ☑️  VIBE / Privacy acknowledgment checked via locator');
    return true;
  }

  console.log('    ⚠️  VIBE acknowledgment checkbox not found in DOM');
  return false;
}

function recordField(profile, label, value) {
  if (!profile) return;
  if (!profile._filledValues) profile._filledValues = {};
  profile._filledValues[label] = value;
}

function isAlreadyFilledValue(current, label = '') {
  return isFormFieldValueFilled(current, label);
}

function isSameCurrentDateValue(actual, expected) {
  const actualParts = String(actual || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const expectedParts = String(expected || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return Boolean(
    actualParts
    && expectedParts
    && Number(actualParts[1]) === Number(expectedParts[1])
    && Number(actualParts[2]) === Number(expectedParts[2])
    && actualParts[3] === expectedParts[3]
  );
}

/**
 * Discover Application Questions from Workday formField containers (any tenant).
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ label: string, fieldType: string, currentValue: string, required: boolean }>>}
 */
export async function discoverApplicationQuestionFields(page) {
  return discoverFormFieldQuestions(page);
}

/**
 * Match a scanned question label to a YAML / default answer (fuzzy).
 * @param {string} label
 * @param {object} profile
 * @param {object} [qaStore]
 * @returns {Promise<string|null>}
 */
export async function matchQuestionToAnswer(label, profile, qaStore = null) {
  const store = qaStore || createQAStore();
  const settings = await loadSettings();
  const norm = normalizeLabel(label);

  const dynamicDateAction = buildCurrentDateAction(label, {
    label,
    question: label,
    containerText: 'Voluntary Self-Identification of Disability CC-305 current value is MM/DD/YYYY',
    timeZone: 'Asia/Kolkata',
  });
  if (dynamicDateAction) {
    console.log(`[date] Detected dynamic current-date field`);
    console.log(`[date] Generated value: ${dynamicDateAction.value}`);
    return dynamicDateAction.value;
  }

  if (/please\s+enter\s+your\s+name/i.test(norm)) {
    const fullName = profile?.personal?.full_name
      || `${profile?.personal?.first_name || ''} ${profile?.personal?.last_name || ''}`.trim();
    if (fullName) return fullName;
  }

  if (/^name$/i.test(norm.replace(/\*+/, ''))) {
    const fullName = profile?.personal?.full_name
      || `${profile?.personal?.first_name || ''} ${profile?.personal?.last_name || ''}`.trim();
    if (fullName) return fullName;
  }

  if (/please\s+check\s+one\s+of\s+the\s+boxes\s+below/i.test(norm)) {
    return profile?.eeo?.disability_status
      || profile?.qa_answers?.[norm]
      || 'No, I do not have a disability and have not had one in the past';
  }

  if (/non\s*disclosure\s*agreement/i.test(norm)) {
    return 'I have read and agree to the Non Disclosure Agreement';
  }
  if (/mutual\s*arbitration\s*agreement/i.test(norm) || /to\s+be\s+considered\s+for\s+employment.*mutual\s*arbitration\s*agreement/i.test(norm) || /applicants\s+will\s+not\s+be\s+considered.*mutual\s*arbitration\s*agreement/i.test(norm)) {
    return 'I have read and agree to the Mutual Arbitration Agreement';
  }

  // Salary must only match an exact cached answer — never fuzzy or profile guess.
  const threshold = isSalaryQuestion(label) ? 1 : settings.fuzzy_threshold;
  const fuzzy = await findBestMatch(label, profile, store, threshold);
  if (fuzzy?.answer) return fuzzy.answer;

  if (!isSalaryQuestion(label)) {
    const fromDefault = lookupDefaultAnswer(label);
    if (fromDefault) return fromDefault;

    const fromProfile = mapLabelToProfileValue(label, profile);
    if (fromProfile) return fromProfile;

    for (const [key, val] of Object.entries(profile?.qa_answers || {})) {
      if (!val || String(key).includes('::')) continue;
      if (norm === normalizeLabel(key)) return String(val);
    }
  }

  return null;
}

/**
 * Fill one Application Question inside its formField container.
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {string} fieldType
 * @param {string} answer
 * @returns {Promise<boolean>}
 */
function extractQuestionLabel(label = '') {
  const clean = String(label).replace(/\s+/g, ' ').trim();
  const question = clean.match(/[^.?!]*\?/);
  if (question && question[0].length >= 15) return question[0].trim();
  if (/please\s+enter\s+your\s+name/i.test(clean)) return 'Please enter your name:';
  if (/please\s+enter\s+today['’]?s\s+date/i.test(clean)) return "Please enter today's date:";
  return clean;
}

async function selectExactAgreementOption(page, label, answer) {
  const question = String(label || '');
  const isNDA = /non\s*disclosure\s*agreement/i.test(question);
  const isArbitration = /mutual\s*arbitration\s*agreement|to be considered for employment.*mutual arbitration agreement|applicants will not be considered.*mutual arbitration agreement/i.test(question);
  if (!isNDA && !isArbitration) return false;

  const expectedOption = isNDA
    ? 'I have read and agree to the Non Disclosure Agreement'
    : 'I have read and agree to the Mutual Arbitration Agreement';

  return await page.evaluate(async ({ targetText, expectedOptionText }) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const containers = Array.from(document.querySelectorAll('[data-automation-id*="formField"], fieldset, [role="group"], [data-automation-id*="secondaryQuestionnaire"]'));

    const findVisibleOptions = () => Array.from(document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]'))
      .filter((el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetParent !== null || el.getClientRects().length > 0);
      });

    let selected = false;
    for (const field of containers) {
      const text = normalize(field.textContent || '');
      if (!text) continue;
      const matchesField = /non\s*disclosure\s*agreement|mutual\s*arbitration\s*agreement/i.test(text)
        && /select one/i.test(text);
      if (!matchesField) continue;

      const trigger = field.querySelector('button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id*="select"] button');
      if (!trigger) continue;

      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const targetNode = findVisibleOptions().find((el) => normalize(el.textContent || '').toLowerCase() === expectedOptionText.toLowerCase());
      if (targetNode) {
        targetNode.click();
        selected = true;
      }
      if (selected) break;
    }

    if (!selected) {
      const targetNode = findVisibleOptions().find((el) => normalize(el.textContent || '').toLowerCase() === expectedOptionText.toLowerCase());
      if (targetNode) {
        targetNode.click();
        selected = true;
      }
    }

    return selected;
  }, { targetText: question, expectedOptionText: expectedOption });
}

export async function fillApplicationQuestionField(page, label, fieldType, answer, profile = null, fieldMetadata = {}) {
  const normTarget = normalizeLabel(extractQuestionLabel(label));
  const marked = await page.evaluate((target) => {
    function norm(s) {
      return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function labelsMatch(a, b) {
      if (!a || !b) return false;
      const A = String(a).toLowerCase();
      const B = String(b).toLowerCase();
      if (A === B) return true;
      if (A.length > 12 && B.length > 12 && (A.includes(B.slice(0, 28)) || B.includes(A.slice(0, 28)))) return true;

      const agreementKeyA = /(click on the link below.*arbitration agreement|mutual arbitration agreement|to be considered for employment.*agree.*mutual arbitration agreement|have you read and agree.*mutual arbitration)/i.test(A);
      const agreementKeyB = /(click on the link below.*arbitration agreement|mutual arbitration agreement|to be considered for employment.*agree.*mutual arbitration agreement|have you read and agree.*mutual arbitration)/i.test(B);
      if (agreementKeyA && agreementKeyB) return true;

      const ndaKeyA = /(click on the link below.*non disclosure agreement|have you read and agree.*non disclosure|non disclosure agreement)/i.test(A);
      const ndaKeyB = /(click on the link below.*non disclosure agreement|have you read and agree.*non disclosure|non disclosure agreement)/i.test(B);
      if (ndaKeyA && ndaKeyB) return true;

      if (/non\s*disclosure/i.test(A) && /non\s*disclosure/i.test(B)) return true;
      if (/mutual\s*arbitration/i.test(A) && /mutual\s*arbitration/i.test(B)) return true;
      if (/please\s+enter\s+your\s+name/i.test(A) && /please\s+enter\s+your\s+name/i.test(B)) return true;
      if (/today.*date|please\s+enter\s+today/i.test(A) && /today.*date|please\s+enter\s+today/i.test(B)) return true;
      if (A === 'name' && B === 'name') return true;
      if (A === 'date' && B === 'date') return true;
      if (/please\s+check\s+one\s+of\s+the\s+boxes/i.test(A) && /please\s+check\s+one\s+of\s+the\s+boxes/i.test(B)) return true;
      return false;
    }
    function fieldLabels(field) {
      const labelEl = field.querySelector('[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]');
      let raw = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim().replace(/\*+$/, '');
      const short = raw.replace(/\*+/g, '').trim();
      if (/^name$/i.test(short)) raw = 'Name';
      else if (/^date$/i.test(short)) raw = 'Date';
      else if (/^language$/i.test(short)) raw = 'Language';
      else {
        const question = raw.match(/[^.?!]*\?/);
        if (question && question[0].length >= 15) raw = question[0].trim();
        else if (/please\s+enter\s+your\s+name/i.test(raw)) raw = 'Please enter your name:';
        else if (/please\s+enter\s+today['’]?s\s+date/i.test(raw)) raw = "Please enter today's date:";
      }
      const container = (field.textContent || '').replace(/\s+/g, ' ').trim();
      return { raw, norm: norm(raw), containerNorm: norm(container) };
    }

    document.querySelectorAll('[data-auto-fill-target]').forEach((el) => el.removeAttribute('data-auto-fill-target'));
    const containers = document.querySelectorAll('[data-automation-id*="formField"], fieldset');
    for (const field of containers) {
      const { norm: n, containerNorm } = fieldLabels(field);
      if (!n) continue;
      if (n.length < 8 && n !== target && !labelsMatch(n, target)) continue;
      if (!labelsMatch(n, target) && !labelsMatch(containerNorm, target)) continue;
      field.setAttribute('data-auto-fill-target', '1');
      return true;
    }
    return false;
  }, normTarget);

  if (!marked) return false;

  const fieldBox = page.locator('[data-auto-fill-target="1"]').first();
  let ok = false;

  try {
    if (!(await fieldBox.isVisible({ timeout: 2000 }).catch(() => false))) {
      return false;
    }

    const dynamicDateAction = buildCurrentDateAction(label, {
      label: extractQuestionLabel(label),
      placeholder: fieldMetadata.placeholder,
      name: fieldMetadata.name,
      automationId: fieldMetadata.automationId,
      question: label,
      containerText: fieldMetadata.containerText,
      timeZone: 'Asia/Kolkata',
    });

    if (dynamicDateAction) {
      const spinButtons = fieldBox.locator('input[role="spinbutton"]');
      const spinButtonCount = await spinButtons.count();
      const dateInput = spinButtonCount >= 3
        ? spinButtons.first()
        : fieldBox.locator('input[type="date"], input[type="text"], textarea').first();
      if (!(await dateInput.isVisible({ timeout: 800 }).catch(() => false))) {
        return false;
      }
      const valueToFill = String(dynamicDateAction.value);
      const nativeValue = getTodayISODate(dynamicDateAction.timeZone);
      const fillValue = await dateInput.evaluate((el) => el.type || 'text').catch(() => 'text');
      const targetValue = fillValue === 'date' ? nativeValue : valueToFill;
      await dateInput.scrollIntoViewIfNeeded().catch(() => {});
      if (spinButtonCount >= 3) {
        const [, month, day, year] = valueToFill.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        await selectCurrentDateFromCalendar(page, fieldBox, dateInput, dynamicDateAction.timeZone).catch(() => false);
        await spinButtons.nth(0).fill(String(Number(month)));
        await spinButtons.nth(1).fill(String(Number(day)));
        await spinButtons.nth(2).fill(year);
      } else if (fillValue === 'date') {
        await dateInput.fill(targetValue);
      } else {
        const selectedFromCalendar = await selectCurrentDateFromCalendar(
          page,
          fieldBox,
          dateInput,
          dynamicDateAction.timeZone
        );
        if (!selectedFromCalendar) {
          await dateInput.fill(targetValue);
        }
      }
      await dateInput.press('Tab');
      const expectedPattern = fillValue === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{2}\/\d{2}\/\d{4}$/;
      let actual = (await dateInput.inputValue().catch(() => '') || '').trim();
      if (spinButtonCount >= 3) {
        const values = await spinButtons.evaluateAll((elements) => elements.map((element) => element.value));
        actual = `${String(values[0] || '').padStart(2, '0')}/${String(values[1] || '').padStart(2, '0')}/${values[2] || ''}`;
      }
      // Some Workday masked controls update only the selected day. Complete the
      // full value when the calendar leaves month/year segments empty or stale.
      if (!expectedPattern.test(actual) || (fillValue !== 'date' && actual !== valueToFill)) {
        if (spinButtonCount >= 3) {
          const [, month, day, year] = valueToFill.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
          await spinButtons.nth(0).fill(String(Number(month)));
          await spinButtons.nth(1).fill(String(Number(day)));
          await spinButtons.nth(2).fill(year);
          await spinButtons.nth(2).press('Tab');
          const values = await spinButtons.evaluateAll((elements) => elements.map((element) => element.value));
          actual = `${String(values[0] || '').padStart(2, '0')}/${String(values[1] || '').padStart(2, '0')}/${values[2] || ''}`;
        } else {
          await dateInput.fill(targetValue);
          await dateInput.press('Tab');
          actual = (await dateInput.inputValue().catch(() => '') || '').trim();
        }
      }
      if (!expectedPattern.test(actual)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = `screenshots/manual-review-date-${stamp}.png`;
        const htmlPath = `screenshots/manual-review-date-${stamp}.html`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        const html = await page.content().catch(() => '');
        await writeFile(htmlPath, html).catch(() => {});
        if (profile) {
          profile._manualReview = profile._manualReview || [];
          profile._manualReview.push(createManualReviewItem(label, {
            reason: 'Dynamic current-date field validation failed',
            expected: fillValue === 'date' ? nativeValue : valueToFill,
            actual,
            screenshot: screenshotPath,
            domSnapshot: htmlPath,
          }));
        }
        console.error('[date] Dynamic current-date field validation failed; manual review required');
        return false;
      }
      console.log('[date] Detected dynamic current-date field');
      console.log(`[date] Generated value: ${valueToFill}`);
      console.log('[date] Filled and verified successfully');
      ok = true;
    } else if (fieldType === 'text') {
      const candidates = [
        fieldBox.locator('input[type="text"]'),
        fieldBox.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'),
        fieldBox.locator('textarea'),
        fieldBox.locator('[contenteditable="true"]'),
      ];
      for (const loc of candidates) {
        const input = loc.first();
        if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
          await input.scrollIntoViewIfNeeded().catch(() => {});
          await input.click({ force: true }).catch(() => {});
          await input.fill(String(answer));
          await input.press('Tab').catch(() => {});
          const actual = (await input.inputValue().catch(() => '') || '').trim();
          if (actual || String(answer).length > 0) {
            ok = true;
            break;
          }
        }
      }
      if (!ok) {
        ok = await page.evaluate(({ value }) => {
          const box = document.querySelector('[data-auto-fill-target="1"]');
          if (!box) return false;
          const input = box.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
          if (!input) return false;
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return Boolean(input.value);
        }, { value: String(answer) });
      }
    } else if (fieldType === 'checkbox') {
      const cb = fieldBox.locator('input[type="checkbox"]').first();
      if (await cb.isVisible({ timeout: 800 }).catch(() => false)) {
        const wantChecked = /^yes|true|1$/i.test(String(answer).trim());
        const isChecked = await cb.isChecked().catch(() => false);
        if (wantChecked !== isChecked) await cb.click({ force: true });
        ok = true;
      }
    } else if (fieldType === 'radio') {
      const answerPattern = String(answer).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const radio = fieldBox.getByRole('radio', { name: new RegExp(answerPattern, 'i') }).first();
      if (await radio.isVisible({ timeout: 800 }).catch(() => false)) {
        await radio.click({ force: true });
        ok = true;
      } else {
        const opt = fieldBox.locator(`label:has-text("${answer}")`).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click({ force: true });
          ok = true;
        }
      }
      if (!ok && /please\s+check\s+one\s+of\s+the\s+boxes|disability/i.test(label)) {
        const pageRadio = page.getByRole('radio', { name: new RegExp(answerPattern, 'i') }).first();
        if (await pageRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
          await pageRadio.click({ force: true });
          ok = true;
        } else {
          const pageLabel = page.locator('label').filter({ hasText: new RegExp(answerPattern, 'i') }).first();
          if (await pageLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
            await pageLabel.click({ force: true });
            ok = true;
          }
        }
      }
    } else {
      const combo = fieldBox.locator(
        'select, [role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button'
      ).first();

      if (await combo.isVisible({ timeout: 1000 }).catch(() => false)) {
        await combo.scrollIntoViewIfNeeded().catch(() => {});

        const directAgreementSelected = await selectExactAgreementOption(page, label, answer);
        if (directAgreementSelected) {
          ok = true;
        } else {
          const result = await handleDropdown(page, combo, answer, label);
          const visibleValue = (await combo.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
          const selectionStuck = /^select(\s+one)?$/i.test(visibleValue);
          if (result.success && !selectionStuck) {
            ok = true;
          } else {
            await combo.click({ force: true });
            const options = /mutual\s+arbitration\s+agreement/i.test(label)
              ? [answer, 'I have read and agree to the Mutual Arbitration Agreement', 'I agree', 'Agree']
              : /non\s+disclosure\s+agreement/i.test(label)
                ? [answer, 'I have read and agree to the Non Disclosure Agreement', 'I agree', 'Agree']
              : [answer, 'Yes', 'No'];
            ok = await clickVisiblePromptOption(page, options);
          }
          if (ok && /mutual\s+arbitration\s+agreement/i.test(label)) {
            const selectedText = await combo.evaluate((element) => {
              if (element.tagName.toLowerCase() === 'select') {
                return element.selectedOptions?.[0]?.textContent || '';
              }
              return element.textContent || element.getAttribute('aria-label') || '';
            }).catch(() => '');
            if (!/I have read and agree to the Mutual Arbitration Agreement/i.test(selectedText)) {
              await combo.click({ force: true });
              ok = Boolean(await clickVisiblePromptOption(page, [
                'I have read and agree to the Mutual Arbitration Agreement',
              ]));
            }
          }
        }
      }
    }
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-auto-fill-target]').forEach((el) => el.removeAttribute('data-auto-fill-target'));
    }).catch(() => {});
  }

  return ok;
}

/**
 * Pure-DOM fill: read questions from formField widgets, match profile.yml / qa_answers.
 * Runs on ANY Workday wizard step (not only "Application Questions").
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string} [stepName]
 * @returns {Promise<number>}
 */
export async function handleWorkdayFormFieldQuestions(page, profile, stepName = '') {
  await waitForDomSettled(page);
  const qaStore = createQAStore();
  let questions = await discoverFormFieldQuestions(page);

  const pagePart = await page.evaluate(() => {
    const h = document.body?.innerText || '';
    const m = h.match(/Application Questions\s*(\d+)\s*of\s*(\d+)/i);
    return m ? `page ${m[1]} of ${m[2]}` : '';
  }).catch(() => '');
  const pageHint = pagePart || stepName || 'form fields';

  console.log(`  📋 DOM [${pageHint}]: ${questions.length} formField question(s) detected`);

  if (questions.length === 0) {
    await page.waitForTimeout(1200);
    questions = await discoverFormFieldQuestions(page);
    if (questions.length > 0) {
      console.log(`    ↳ After wait: ${questions.length} formField question(s)`);
    }
  }

  let filled = 0;
  let skipped = 0;
  for (const q of questions) {
    if (isCheckboxOnlyLabel(q.label)) continue;
    if (/employee\s*id.*if applicable/i.test(q.label)) continue;

    const questionLabel = extractQuestionLabel(q.label);
    const norm = normalizeLabel(questionLabel);
    const dynamicDateAction = buildCurrentDateAction(questionLabel, {
      label: questionLabel,
      placeholder: q.placeholder,
      name: q.name,
      automationId: q.automationId,
      question: `${questionLabel} ${q.containerText || ''}`,
      containerText: q.containerText,
      timeZone: 'Asia/Kolkata',
    });
    const currentDateValue = q.fieldType === 'date'
      ? getTodayISODate(dynamicDateAction?.timeZone || 'Asia/Kolkata')
      : dynamicDateAction?.value;
    const isCurrentDateAlreadyCorrect = dynamicDateAction
      && (
        q.fieldType === 'date'
          ? String(q.currentValue || '').trim() === currentDateValue
          : isSameCurrentDateValue(q.currentValue, currentDateValue)
      );

    if (!dynamicDateAction && profile?._filledValues && Object.keys(profile._filledValues).some((k) => normalizeLabel(k) === norm)) {
      skipped++;
      continue;
    }
    if (isAlreadyFilledValue(q.currentValue, questionLabel) && (!dynamicDateAction || isCurrentDateAlreadyCorrect)) {
      if (dynamicDateAction && isCurrentDateAlreadyCorrect) {
        console.log(`[date] Current-date field already verified: ${currentDateValue}`);
      }
      recordField(profile, questionLabel, q.currentValue);
      skipped++;
      continue;
    }

    let answer = await resolveField({
      ...q,
      label: questionLabel,
      required: q.required ?? true,
      options: q.options || [],
    }, profile, qaStore, {
      skipPrompt: false,
      company: profile?._company || profile?.company,
      resumePath: profile?._resumePath,
      url: page.url(),
    });
    if (!answer) {
      console.log(`    ⚠️  No answer supplied for: "${q.label.slice(0, 70)}..."`);
      continue;
    }

    const ok = await fillApplicationQuestionField(page, questionLabel, q.fieldType, answer, profile, q);
    if (ok) {
      recordField(profile, questionLabel, answer);
      console.log(`    ✅ [${q.fieldType}] "${q.label.slice(0, 55)}..." ← "${answer.length > 40 ? answer.slice(0, 40) + '...' : answer}"`);
      filled++;
      await waitForDomSettled(page);
    } else {
      console.log(`    ⚠️  Could not fill: "${q.label.slice(0, 55)}..."`);
    }
  }

  if (skipped > 0 && filled === 0) {
    console.log(`    ℹ️  ${skipped} field(s) skipped (already filled or recorded this session)`);
  }

  return filled;
}

/** @deprecated Use handleWorkdayFormFieldQuestions */
export const handleApplicationQuestionsStep = handleWorkdayFormFieldQuestions;

/**
 * Brute-force fill Name + Date on OFCCP Self Identify when standard locators fail.
 * @param {import('playwright').Page} page
 * @param {string} fullName
 * @param {string} dateValue MM/DD/YYYY
 * @returns {Promise<{ name: boolean, date: boolean }>}
 */
async function bruteForceSelfIdentifyNameDate(page, fullName, dateValue) {
  return await page.evaluate(({ fullName, dateValue }) => {
    const result = { name: false, date: false };
    const [, month, day, year] = String(dateValue).match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [];

    function fire(el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const formFields = document.querySelectorAll('[data-automation-id*="formField"]');
    for (const field of formFields) {
      const labelEl = field.querySelector('label, legend, [data-automation-id*="label"]');
      const labelText = (labelEl?.textContent || '').replace(/\*+/g, '').trim().toLowerCase();

      if (labelText === 'name' && fullName) {
        const input = field.querySelector(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]'
        );
        if (input) {
          input.focus();
          if (input.getAttribute('contenteditable') === 'true') {
            input.textContent = fullName;
          } else {
            input.value = fullName;
          }
          fire(input);
          result.name = Boolean((input.value || input.textContent || '').trim());
        }
      }

      if (labelText === 'date' && month && day && year) {
        const spins = field.querySelectorAll('input[role="spinbutton"]');
        if (spins.length >= 3) {
          spins[0].focus();
          spins[0].value = String(Number(month));
          fire(spins[0]);
          spins[1].value = String(Number(day));
          fire(spins[1]);
          spins[2].value = year;
          fire(spins[2]);
          result.date = Boolean(spins[0].value && spins[1].value && spins[2].value);
        } else {
          const input = field.querySelector('input[type="date"], input[type="text"], textarea');
          if (input) {
            input.focus();
            input.value = dateValue;
            fire(input);
            result.date = Boolean(input.value);
          }
        }
      }
    }

    // Fallback: first two text inputs in CC-305 block (Name then Employee ID area)
    if (!result.name && fullName) {
      const section = Array.from(formFields).find((f) =>
        /voluntary self-identification|cc-305|omb control/i.test(f.textContent || '')
      ) || document.body;
      const nameInput = section.querySelector('[data-automation-id*="formField"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if (nameInput && !nameInput.value) {
        nameInput.value = fullName;
        fire(nameInput);
        result.name = Boolean(nameInput.value);
      }
    }

    return result;
  }, { fullName, dateValue });
}

/**
 * OFCCP Self Identify step (CC-305): Name, Date, disability attestation.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<number>}
 */
export async function handleSelfIdentifyStep(page, profile) {
  console.log('  📋 Self Identify (OFCCP CC-305) — DOM scan + fill...');
  await waitForDomSettled(page);

  const fullName = profile?.personal?.full_name
    || `${profile?.personal?.first_name || ''} ${profile?.personal?.last_name || ''}`.trim();
  const disabilityAnswer = profile?.eeo?.disability_status
    || profile?.qa_answers?.[normalizeLabel('please check one of the boxes below:')]
    || 'No, I do not have a disability and have not had one in the past';
  const selfIdentifyMeta = {
    containerText: 'Voluntary Self-Identification of Disability CC-305 OMB Control Number current value is MM/DD/YYYY',
    placeholder: 'MM/DD/YYYY',
  };

  let filled = 0;
  const today = getTodayMMDDYYYY('Asia/Kolkata');

  if (fullName) {
    let nameOk = await fillApplicationQuestionField(page, 'Name', 'text', fullName, profile, selfIdentifyMeta);
    if (!nameOk) {
      const brute = await bruteForceSelfIdentifyNameDate(page, fullName, today);
      nameOk = brute.name;
      if (nameOk) console.log(`    ✅ [text] Name ← "${fullName}" (direct DOM)`);
    } else {
      console.log(`    ✅ [text] Name ← "${fullName}"`);
    }
    if (!nameOk) {
      console.log('    ⚠️  Name field fill failed — retrying with getByLabel...');
      const byLabel = page.getByLabel(/^Name\b/i).first();
      if (await byLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
        await byLabel.fill(fullName);
        await byLabel.press('Tab').catch(() => {});
        nameOk = true;
        console.log(`    ✅ [text] Name ← "${fullName}" (getByLabel)`);
      }
    }
    if (nameOk) {
      recordField(profile, 'Name', fullName);
      filled++;
    }
  }

  let dateOk = await fillApplicationQuestionField(page, 'Date', 'date', today, profile, selfIdentifyMeta);
  if (!dateOk) {
    const brute = await bruteForceSelfIdentifyNameDate(page, fullName, today);
    dateOk = brute.date;
    if (dateOk) console.log(`    ✅ [date] Date ← "${today}" (direct DOM spinbuttons)`);
  } else {
    console.log(`    ✅ [date] Date ← "${today}"`);
  }
  if (!dateOk) {
    console.log('    ⚠️  Date field fill failed — retrying spinbutton locators...');
    const dateField = page.locator('[data-automation-id*="formField"]').filter({ hasText: /^Date\b/i }).first();
    const spins = dateField.locator('input[role="spinbutton"]');
    if (await spins.count() >= 3) {
      const [, month, day, year] = today.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [];
      await spins.nth(0).fill(String(Number(month)));
      await spins.nth(1).fill(String(Number(day)));
      await spins.nth(2).fill(year);
      await spins.nth(2).press('Tab');
      dateOk = true;
      console.log(`    ✅ [date] Date ← "${today}" (spinbutton locator)`);
    }
  }
  if (dateOk) {
    recordField(profile, 'Date', today);
    filled++;
  }

  const disabilityOk = await fillApplicationQuestionField(
    page,
    'Please check one of the boxes below:',
    'radio',
    disabilityAnswer,
    profile,
    selfIdentifyMeta
  );
  if (disabilityOk) {
    recordField(profile, 'Please check one of the boxes below:', disabilityAnswer);
    console.log(`    ✅ [radio] Disability ← "${disabilityAnswer.slice(0, 50)}..."`);
    filled++;
  }

  const genericFilled = await handleWorkdayFormFieldQuestions(page, profile, 'Self Identify');
  return filled + genericFilled;
}

/**
 * Fill Gender dropdown on Voluntary Disclosures (combobox only — not checkbox).
 * @param {import('playwright').Page} page
 * @param {string} gender
 * @param {object} [profile]
 * @returns {Promise<boolean>}
 */
export async function fillGenderDropdown(page, gender = 'Male', profile = null) {
  if (profile?._filledValues?.Gender === gender) {
    console.log(`    ✓ Gender already set to "${gender}" — skipping`);
    return true;
  }

  const dom = await discoverVoluntaryDisclosureDom(page);
  if (dom.gender.currentValue && /male|female|non-binary/i.test(dom.gender.currentValue)) {
    recordField(profile, 'Gender', dom.gender.currentValue);
    console.log(`    ✓ Gender already "${dom.gender.currentValue}" in DOM`);
    return true;
  }

  const genderField = page.locator('[data-automation-id*="formField"]').filter({ hasText: /^Gender\b/i }).first();
  const combo = genderField.locator('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button').first();

  if (await combo.isVisible({ timeout: 1500 }).catch(() => false)) {
    await combo.scrollIntoViewIfNeeded().catch(() => {});
    const result = await handleDropdown(page, combo, gender, 'Gender');
    if (result.success) {
      recordField(profile, 'Gender', gender);
      console.log(`    ✅ Gender dropdown ← "${gender}"`);
      return true;
    }
  }

  const byRole = page.getByRole('combobox', { name: /^gender/i }).first();
  if (await byRole.isVisible({ timeout: 800 }).catch(() => false)) {
    const result = await handleDropdown(page, byRole, gender, 'Gender');
    if (result.success) {
      recordField(profile, 'Gender', gender);
      console.log(`    ✅ Gender dropdown ← "${gender}"`);
      return true;
    }
    await byRole.click({ force: true });
    const picked = await clickVisiblePromptOption(page, [gender, 'Male', 'Female']);
    if (picked) {
      recordField(profile, 'Gender', gender);
      return true;
    }
  }

  // Some Workday tenants render Gender without an accessible combobox name.
  // Resolve the control from the exact Gender label before giving up.
  const marked = await page.evaluate(() => {
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
    const label = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"]'))
      .find((el) => normalize(el.textContent).toLowerCase() === 'gender');
    if (!label) return false;

    const field = label.closest('[data-automation-id*="formField"], fieldset, [role="group"]') || label.parentElement;
    const control = field?.querySelector(
      '[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"], [data-automation-id="select-widget"], [data-automation-id*="select"]'
    );
    if (!control) return false;
    control.setAttribute('data-auto-gender-target', 'true');
    return true;
  }).catch(() => false);

  if (marked) {
    const fallbackCombo = page.locator('[data-auto-gender-target="true"]').first();
    try {
      await fallbackCombo.scrollIntoViewIfNeeded().catch(() => {});
      await fallbackCombo.click({ force: true }).catch(() => fallbackCombo.evaluate((el) => el.click()));
      await page.waitForTimeout(300);
      const picked = await clickVisiblePromptOption(page, [gender, 'Male']);
      const after = await discoverVoluntaryDisclosureDom(page);
      if (picked && (/male|female|non-binary/i.test(after.gender.currentValue) || picked.toLowerCase() === gender.toLowerCase())) {
        recordField(profile, 'Gender', gender);
        console.log(`    ✅ Gender dropdown ← "${gender}"`);
        return true;
      }
    } finally {
      await page.evaluate(() => {
        document.querySelectorAll('[data-auto-gender-target="true"]')
          .forEach((el) => el.removeAttribute('data-auto-gender-target'));
      }).catch(() => {});
    }
  }

  return false;
}

/**
 * Full Voluntary Disclosures step: gender dropdown + VIBE checkbox once, then DOM log.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ gender: boolean, vibe: boolean }>}
 */
export async function handleVoluntaryDisclosuresStep(page, profile) {
  console.log('  📋 Voluntary Disclosures — reading DOM...');
  const before = await discoverVoluntaryDisclosureDom(page);
  console.log(`    DOM record: gender="${before.gender.currentValue || '(empty)'}" vibeChecked=${before.vibeAck.checked}`);

  const gender = await fillGenderDropdown(page, profile?.eeo?.gender || 'Male', profile);
  const vibe = await acknowledgeVibePrivacyOnce(page, profile);

  const after = await discoverVoluntaryDisclosureDom(page);
  console.log(`    DOM after fill: gender="${after.gender.currentValue || '(empty)'}" vibeChecked=${after.vibeAck.checked}`);

  return { gender, vibe };
}

/**
 * Fill a single Workday dropdown identified by question label text.
 */
export async function fillWorkdayDropdownByLabel(page, labelText, answer) {
  if (isCheckboxOnlyLabel(labelText)) return false;
  if (isGenderLabel(labelText)) return false;

  const escaped = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelRe = new RegExp(escaped.slice(0, 80), 'i');

  const candidates = [
    page.getByRole('combobox', { name: labelRe }),
    page.locator('[data-automation-id="select-widget"], [data-automation-id="selectWidget"]').filter({ hasText: labelRe }),
    page.locator('button[aria-haspopup="listbox"]').filter({ hasText: labelRe }),
  ];

  for (const loc of candidates) {
    const el = loc.first();
    if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;

    const tag = await el.evaluate(n => n.tagName.toLowerCase()).catch(() => '');
    if (tag === 'input' && await el.evaluate(n => n.type === 'checkbox').catch(() => false)) continue;

    const current = ((await el.innerText().catch(() => '')) || (await el.inputValue().catch(() => '')) || '').trim();
    if (current && current !== 'Select' && current !== 'Select...' && fuzzyAlreadySet(current, answer)) {
      return false;
    }

    const result = await handleDropdown(page, el, answer, labelText);
    if (result.success) {
      console.log(`    ✅ Dropdown [${result.method}]: "${labelText.slice(0, 50)}..." ← "${answer}"`);
      return true;
    }
  }

  return false;
}

function fuzzyAlreadySet(current, answer) {
  const c = current.toLowerCase();
  const a = String(answer).toLowerCase();
  return c === a || c.includes(a) || a.includes(c);
}

/**
 * @deprecated Use handleApplicationQuestionsStep
 */
export async function fillKnownWorkdayDropdowns(page, profile, stepName) {
  if (!/application questions/i.test(stepName)) return 0;
  return handleApplicationQuestionsStep(page, profile);
}

/** @deprecated Use acknowledgeVibePrivacyOnce */
export async function checkVoluntaryDisclosureAcknowledgments(page, profile = null) {
  return acknowledgeVibePrivacyOnce(page, profile);
}
