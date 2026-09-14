/**
 * workdayQuestionFill.mjs — Fill Workday dropdown/combobox questions by label
 */

import { writeFile } from 'fs/promises';
import { handleDropdown, clickVisiblePromptOption, fuzzyScore, typeAndClickOption } from './fields.mjs';
import {
  isForegoingStatementCertifyLabel,
  isShiftAvailabilityQuestion,
  isYesNoAnswer,
  leadingYesNo,
  selectionMatchesAnswer,
  WORKDAY_NOTICE_PERIOD_OPTIONS,
} from './workdayDefaults.mjs';
import { normalizeLabel, findBestMatch, loadSettings, createQAStore, isSalaryQuestion, lookupSemanticCompensationAnswer, saveAnswerToYaml } from './qaStore.mjs';
import {
  waitForDomSettled,
  discoverFormFieldQuestions,
  isFormFieldValueFilled,
  isDropdownAnsweredInDom,
  isDiscoveredFieldFilled,
  collectLiveFieldOptions,
} from './workdayDom.mjs';
import { mapLabelToProfileValue, resolveField } from './planner.mjs';
import { pickNearestSelectOption, resolveUnknownWithLlm, isPersonalIdentityQuestion } from './openRouterLlm.mjs';
import { pickCompensationFromOptions, compensationInputValue } from './compensationPick.mjs';
import { getWorkdayTenant } from './discovery.mjs';
import { saveAnswerToTenantYaml, lookupTenantAnswer } from './tenantQuestionYaml.mjs';
import { peekClientAnswer } from './clientAnswer.mjs';
import { resolveDynamicAnswer } from './questionEngine/index.mjs';
import {
  fillWorkdayCustomDropdown,
  markDropdownByLabel,
  veteranStatusKind,
} from './interaction/workdayCustomDropdown.mjs';
import { resolveMinimumAgeAnswer } from './minimumAge.mjs';
import { shouldSkipOptionalFill, isMandatoryField } from './scanFieldFilter.mjs';
import { fillWorkdaySkillsField } from './workdaySkills.mjs';
import {
  resolveExperienceQuestionAnswer,
  sanitizeExperienceAnswer,
  isYearsQuantityQuestion,
  isInvalidYearsAnswer,
} from './experienceAnswer.mjs';
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
const FOREGOING_STATEMENT_ACK_KEY = 'Foregoing statement certification';

function isCheckboxOnlyLabel(label) {
  return /recruitment privacy statement.*vibe|i acknowledge workday.*vibe|vibe philosophy/i.test(String(label));
}

function isGenderLabel(label) {
  const t = String(label).replace(/\*+/g, '').trim();
  return /^gender\s*$/i.test(t) || /please\s*select\s*your\s*sex/i.test(t) || /^sex\s*$/i.test(t);
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
      const labelEl = field.querySelector('[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]');
      const labelText = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!labelText) continue;

      if (/^gender\b|^sex\b|please\s*select\s*your\s*(gender|sex)/i.test(labelText)) {
        const combo = field.querySelector('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id*="select"]');
        const valEl = field.querySelector('[data-automation-id="selectWidget"] button, [role="combobox"], [data-automation-id="selectOne"] button');
        let currentValue = (valEl?.textContent || valEl?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!currentValue || /^select(\s+one)?\.?$/i.test(currentValue)) {
          const selected = field.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptOption"], [aria-selected="true"]');
          currentValue = (selected?.textContent || '').replace(/\s+/g, ' ').trim() || currentValue;
        }
        result.gender = {
          label: labelText.replace(/\*+$/, ''),
          currentValue,
          hasCombobox: Boolean(combo),
        };
      }

      if (/recruitment privacy statement.*vibe philosophy/i.test(labelText)
        || /privacy statement/i.test(labelText)
        || /i confirm that i understand and agree/i.test(labelText)) {
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
        if (!/recruitment privacy statement.*vibe philosophy/i.test(t)
          && !/privacy statement/i.test(t)
          && !/i confirm that i understand and agree/i.test(t)) continue;
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
    const target = labels.find(l => {
      const t = (l.textContent || '').replace(/\s+/g, ' ');
      return /recruitment privacy statement.*vibe philosophy/i.test(t)
        || /privacy statement/i.test(t)
        || /i confirm that i understand and agree/i.test(t);
    });
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

/**
 * Check "I certify... foregoing statement" checkbox on Voluntary Disclosures (once).
 */
export async function acknowledgeForegoingStatementOnce(page, profile) {
  const already = profile?._filledValues?.[FOREGOING_STATEMENT_ACK_KEY];
  if (already === 'Yes') {
    console.log('    ✓ Foregoing statement certification already recorded — skipping');
    return true;
  }

  const clicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((l) =>
      /i certify that i have read.*foregoing statement/i.test((l.textContent || '').replace(/\s+/g, ' '))
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
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb.checked;
  });

  if (clicked) {
    if (profile) recordField(profile, FOREGOING_STATEMENT_ACK_KEY, 'Yes');
    console.log('    ☑️  Foregoing statement certification checked');
    await waitForDomSettled(page);
    return true;
  }

  const fallback = page.locator('label').filter({ hasText: /I certify that I have read.*foregoing statement/i }).locator('..').locator('input[type="checkbox"]').first();
  if (await fallback.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await fallback.isChecked().catch(() => false))) {
      await fallback.click({ force: true });
    }
    if (profile) recordField(profile, FOREGOING_STATEMENT_ACK_KEY, 'Yes');
    console.log('    ☑️  Foregoing statement certification checked via locator');
    return true;
  }

  return false;
}

const TERMS_CONSENT_KEY = 'Terms and Conditions consent';

/**
 * Check "I have read and consent to the terms and conditions" (State Street and similar).
 */
export async function acknowledgeTermsAndConditionsOnce(page, profile) {
  const already = profile?._filledValues?.[TERMS_CONSENT_KEY];
  if (already === 'Yes') return true;

  const clicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((l) => {
      const t = (l.textContent || '').replace(/\s+/g, ' ').trim();
      return /terms and conditions/i.test(t)
        || /i have read and consent/i.test(t)
        || /privacy statement/i.test(t)
        || /i confirm that i understand and agree/i.test(t);
    });
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
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb.checked;
  });

  if (clicked) {
    if (profile) recordField(profile, TERMS_CONSENT_KEY, 'Yes');
    console.log('    ☑️  Terms and Conditions consent checked');
    await waitForDomSettled(page);
    return true;
  }

  const fallback = page.locator('label').filter({ hasText: /terms and conditions|I have read and consent|Privacy Statement|I confirm that I understand and agree/i }).first();
  if (await fallback.isVisible({ timeout: 1000 }).catch(() => false)) {
    const cb = fallback.locator('input[type="checkbox"]').first()
      .or(fallback.locator('..').locator('input[type="checkbox"]').first());
    if (await cb.isVisible({ timeout: 500 }).catch(() => false)) {
      if (!(await cb.isChecked().catch(() => false))) await cb.click({ force: true });
      if (profile) recordField(profile, TERMS_CONSENT_KEY, 'Yes');
      console.log('    ☑️  Terms and Conditions consent checked via locator');
      return true;
    }
    await fallback.click({ force: true }).catch(() => {});
    if (profile) recordField(profile, TERMS_CONSENT_KEY, 'Yes');
    console.log('    ☑️  Terms and Conditions consent checked via label click');
    return true;
  }

  const radio = page.getByRole('radio', { name: /yes.*terms and conditions|i have read and consent/i }).first();
  if (await radio.isVisible({ timeout: 1000 }).catch(() => false)) {
    await radio.click({ force: true });
    if (profile) recordField(profile, TERMS_CONSENT_KEY, 'Yes');
    console.log('    ☑️  Terms and Conditions consent selected via radio');
    return true;
  }
  return false;
}

function isCheckboxAckAnswer(answer = '') {
  const text = String(answer || '').trim();
  if (!text) return false;
  return /^yes|true|1$/i.test(text)
    || /certify|i have read|i agree|accept all terms|foregoing statement/i.test(text);
}

const AGREEMENT_LABEL_RES = [
  /terms\s*(and|&)\s*conditions/i,
  /privacy\s*(statement|notice|policy)/i,
  /recruitment\s*privacy/i,
  /vibe\s*philosophy/i,
  /i\s*confirm/i,
  /i\s*certify/i,
  /i\s*acknowledge/i,
  /i\s*agree/i,
  /i\s*have\s*read/i,
  /i\s*understand/i,
  /consent\s*to/i,
  /accept\s*(all\s*)?terms/i,
  /foregoing\s*statement/i,
  /mutual\s*arbitration/i,
  /non[\s-]*disclosure\s*agreement/i,
  /by\s*clicking.*checkbox/i,
  /click.*checkbox.*below/i,
  /information.*accurate/i,
  /understand\s*and\s*agree/i,
];

const NON_AGREEMENT_CHECKBOX_RES = [
  /i\s*currently\s*work\s*here/i,
  /currently\s*employed\s*at/i,
  /select\s*all\s*that\s*apply/i,
  /work\s*type/i,
  /employment\s*type/i,
  /^remote$/i,
  /^full[\s-]*time$/i,
  /^part[\s-]*time$/i,
  /^hybrid$/i,
  /^on[\s-]*site$/i,
  /type\s*to\s*add\s*skills/i,
  /enter\s*a\s*skill/i,
];

function isAgreementCheckboxLabel(labelText = '') {
  const text = String(labelText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 8) return false;
  if (NON_AGREEMENT_CHECKBOX_RES.some((re) => re.test(text))) return false;
  if (AGREEMENT_LABEL_RES.some((re) => re.test(text))) return true;
  if (/\*/.test(text) && /confirm|certify|acknowledge|consent|agree|privacy|terms|accurate|understand/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Scroll to page bottom and check every unchecked agreement / consent checkbox.
 * Catches Terms, Privacy Statement, certify/acknowledge boxes Workday puts at the footer.
 */
export async function acknowledgeAllPageAgreements(page, profile, stepName = '') {
  const requiredOnly = profile?._fillOptionalFields !== true;

  await page.evaluate(() => {
    window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const footer = document.querySelector(
      '[data-automation-id="footerContainer"], [data-automation-id="bottom-navigation"], footer'
    );
    footer?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }).catch(() => {});
  await waitForDomSettled(page);
  await page.waitForTimeout(350);

  const checked = await page.evaluate(({ agreementRes, skipRes, requiredOnly }) => {
    const agreementPatterns = agreementRes.map((s) => new RegExp(s, 'i'));
    const skipPatterns = skipRes.map((s) => new RegExp(s, 'i'));

    const isAgreement = (text) => {
      if (!text || text.length < 8) return false;
      if (skipPatterns.some((re) => re.test(text))) return false;
      if (agreementPatterns.some((re) => re.test(text))) return true;
      if (/\*/.test(text) && /confirm|certify|acknowledge|consent|agree|privacy|terms|accurate|understand/i.test(text)) {
        return true;
      }
      return false;
    };

    const getLabel = (cb) => {
      const id = cb.id;
      let label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      if (!label) label = cb.closest('label');
      if (!label) {
        const field = cb.closest('[data-automation-id*="formField"]');
        label = field?.querySelector('label, legend');
      }
      return (label?.textContent || cb.getAttribute('aria-label') || cb.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    };

    const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const bottomCutoff = docHeight * 0.42;

    const candidates = [];
    const seen = new Set();

    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      if (cb.checked || cb.disabled) continue;
      const label = getLabel(cb);
      if (!label || seen.has(label)) continue;

      const rect = cb.getBoundingClientRect();
      const absTop = rect.top + window.scrollY;
      const inBottomHalf = absTop >= bottomCutoff;
      const required = cb.required
        || cb.getAttribute('aria-required') === 'true'
        || /\*/.test(label)
        || Boolean(cb.closest('[data-automation-id*="formField"]')?.querySelector('[aria-required="true"], abbr[title*="required" i]'));

      // Script-only: never click optional marketing / non-required checkboxes.
      if (requiredOnly && !required) continue;

      if (!isAgreement(label) && !(inBottomHalf && required)) continue;
      if (!isAgreement(label) && inBottomHalf && !/confirm|certify|acknowledge|consent|agree|privacy|terms|statement|accurate|understand/i.test(label)) {
        continue;
      }

      seen.add(label);
      candidates.push({ cb, label, absTop });
    }

    candidates.sort((a, b) => b.absTop - a.absTop);

    const checkedLabels = [];
    for (const { cb, label } of candidates) {
      if (cb.checked) continue;
      cb.scrollIntoView({ block: 'center', behavior: 'instant' });
      cb.click();
      cb.dispatchEvent(new Event('input', { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      if (!cb.checked) {
        const wrap = cb.closest('label') || cb.parentElement;
        wrap?.click();
      }
      if (cb.checked) checkedLabels.push(label.slice(0, 120));
    }

    return checkedLabels;
  }, {
    agreementRes: AGREEMENT_LABEL_RES.map((re) => re.source),
    skipRes: NON_AGREEMENT_CHECKBOX_RES.map((re) => re.source),
    requiredOnly,
  }).catch(() => []);

  if (checked.length === 0) {
    return 0;
  }

  for (const label of checked) {
    recordField(profile, label, 'Yes');
    console.log(`    ☑️  Agreement checked: "${label.slice(0, 80)}${label.length > 80 ? '...' : ''}"`);
  }
  if (stepName) {
    console.log(`    ☑️  ${checked.length} required agreement checkbox(es) (${stepName})`);
  }
  await waitForDomSettled(page);
  return checked.length;
}

function recordField(profile, label, value) {
  if (!profile) return;
  if (!profile._filledValues) profile._filledValues = {};
  profile._filledValues[label] = value;
}

function valuesFuzzyMatch(actual, expected) {
  const a = String(actual || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const e = String(expected || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a || !e) return false;
  if (a === e) return true;
  if (/^[1-9]\d*\s+items?\s+selected$/.test(a)) return true;
  // Yes/No is decided on the leading word: a substring test would accept
  // "Yes, I have been notified" as the answer "No".
  if (leadingYesNo(a) || leadingYesNo(e)) return selectionMatchesAnswer(a, e);
  return a.includes(e) || e.includes(a);
}

function isYesNoQuestion(label) {
  const n = normalizeLabel(label);
  if (/highest level of education|minimum educational|bachelor|degree|hispanic|race|veteran|gender|education completed/i.test(n)) {
    return false;
  }
  return /^(are you|do you|will you|have you|if you|did you)/i.test(n);
}

function peekEeoAnswer(norm, profile) {
  if (/please select your gender|please select your sex/i.test(norm) || norm === 'gender' || norm === 'sex') {
    return profile?.eeo?.gender || null;
  }
  if (/hispanic|latino/i.test(norm)) {
    return profile?.eeo?.hispanic_latino || null;
  }
  if (
    /^race$|^ethnicity$|^race\/ethnicity$|^race ethnicity$/i.test(norm)
    || /please select your race-ethnicity|please select the race which most accurately|please select the race or ethnicity|please select the ethnicity which most accurately|ethnicity single selection/i.test(norm)
  ) {
    return profile?.eeo?.race || null;
  }
  if (/^veteran status$|protected veteran categories|please select the veteran status which most accurately|^veteran$/i.test(norm)) {
    return profile?.eeo?.veteran_status || null;
  }
  return null;
}

function peekExpectedAnswer(questionLabel, profile, tenant = '') {
  return peekEeoAnswer(normalizeLabel(questionLabel), profile)
    || peekClientAnswer(questionLabel, profile, { tenant });
}

function isQuestionDomFilled(q, questionLabel, expectedAnswer = '', profile = null) {
  return isDiscoveredFieldFilled(q, questionLabel);
}

const SELECT_ONE_WIDGET_SELECTOR = '[data-automation-id="selectOne"], [data-automation-id="selectWidget"]';
const DROPDOWN_FORM_FIELD_SELECTOR = '[data-automation-id*="formField"]';
const DROPDOWN_TRIGGER_IN_FIELD = 'button[aria-haspopup="listbox"], [role="combobox"], [data-automation-id="promptIcon"], [data-automation-id="arrow"], [data-automation-id="selectWidget"], select, [data-automation-id="selectOne"] button, [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button';

function buildSelectOneOptionCandidates(answer, labelText = '') {
  const opts = [String(answer)];
  const a = String(answer || '').trim();
  if (/^yes$/i.test(a)) opts.push('Yes');
  if (/^no$/i.test(a)) opts.push('No');
  if (/relocat/i.test(a) || /relocat/i.test(labelText)) {
    opts.push('Yes, I would consider relocating for this role', 'Yes');
  }
  if (/workday system/i.test(labelText)) {
    opts.push('No, I do not use the Workday system in my current job', 'No');
  }
  if (/authorized to work|legally authorized/i.test(labelText)) {
    opts.push('Yes', 'Yes, I am authorized to work in the country where this job is located');
  }
  if (/sponsor|visa|immigration filing/i.test(labelText)) {
    opts.push('No', 'No, I will not require sponsorship', 'No, I do not require sponsorship');
  }
  if (/acknowledge|truthfully/i.test(labelText)) {
    opts.push('Yes', 'yes');
  }
  if (/veteran/i.test(labelText)) {
    opts.push(
      'No, I am not a veteran',
      'I am not a veteran',
      'I AM NOT A VETERAN',
      'I am not a protected veteran',
      'I am not a protected veteran.',
      'No',
    );
  }
  if (/race/i.test(labelText) && !/hispanic|latino/i.test(labelText)) {
    opts.push(
      'Asian',
      'Asian (United States of America)',
      'Asian, not Hispanic or Latino (United States of America)',
      'Asian (Not Hispanic or Latino)',
    );
  }
  if (/hispanic|latino/i.test(labelText)) {
    opts.push('No', 'Not Hispanic or Latino', 'No, not Hispanic or Latino', 'Hispanic or Latino', 'Yes');
  }
  if (/gender|please select your sex|^sex$/i.test(labelText)) {
    opts.push('Male', 'Female', 'Non-Binary');
  }
  if (/education|bachelor|degree/i.test(labelText)) {
    opts.push("Bachelor's Degree", 'Bachelors Degree', "Bachelor's", 'Bachelor of Science', 'Bachelors of Technology');
  }
  if (/notice\s*period/i.test(labelText) || /notice\s*period/i.test(a)) {
    opts.push(...WORKDAY_NOTICE_PERIOD_OPTIONS);
  }
  return [...new Set(opts.filter(Boolean))];
}

async function markSelectOneWidget(page, { labelText = '', selectOneIndex = null, formFieldIndex = null, dropdownPageIndex = null } = {}) {
  if (dropdownPageIndex != null && dropdownPageIndex >= 0) {
    return await page.evaluate(({ idx, triggerSel }) => {
      function readDropdownValue(root) {
        const selected = root.querySelector('[data-automation-id="selectedItem"]');
        if (selected?.textContent?.trim()) {
          const t = selected.textContent.trim();
          if (!/^select(\s+one)?\.?$/i.test(t)) return t;
        }
        const btn = root.querySelector(triggerSel) || root.querySelector('button[aria-haspopup="listbox"]');
        if (btn) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
        }
        return '';
      }

      document.querySelectorAll('[data-wd-so-target]').forEach((el) => el.removeAttribute('data-wd-so-target'));
      const seen = new Set();
      const roots = [];
      const scopes = document.querySelectorAll(
        '[data-automation-id*="secondaryQuestionnaire"] [data-automation-id*="formField"], [data-automation-id*="formField"], [data-automation-id*="secondaryQuestionnaire"]'
      );
      for (const scope of scopes) {
        const btn = scope.querySelector(triggerSel) || scope.querySelector('button[aria-haspopup="listbox"]');
        if (!btn || seen.has(btn)) continue;
        seen.add(btn);
        roots.push(scope.closest('[data-automation-id*="formField"]') || scope);
      }
      const root = roots[idx];
      if (!root) return { found: false, current: '' };
      root.setAttribute('data-wd-so-target', '1');
      return { found: true, current: readDropdownValue(root) };
    }, { idx: dropdownPageIndex, triggerSel: DROPDOWN_TRIGGER_IN_FIELD });
  }

  if (formFieldIndex != null && formFieldIndex >= 0) {
    return await page.evaluate(({ idx, triggerSel }) => {
      function readDropdownValue(field) {
        const selected = field.querySelector('[data-automation-id="selectedItem"]');
        if (selected?.textContent?.trim()) {
          const t = selected.textContent.trim();
          if (!/^select(\s+one)?\.?$/i.test(t)) return t;
        }
        const btn = field.querySelector(triggerSel);
        if (btn) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
        }
        return '';
      }

      document.querySelectorAll('[data-wd-so-target]').forEach((el) => el.removeAttribute('data-wd-so-target'));
      const fields = Array.from(document.querySelectorAll('[data-automation-id*="formField"]'))
        .filter((field) => field.querySelector(triggerSel));
      const field = fields[idx];
      if (!field) return { found: false, current: '' };
      field.setAttribute('data-wd-so-target', '1');
      return { found: true, current: readDropdownValue(field) };
    }, { idx: formFieldIndex, triggerSel: DROPDOWN_TRIGGER_IN_FIELD });
  }

  if (selectOneIndex != null && selectOneIndex >= 0) {
    const widgets = page.locator(SELECT_ONE_WIDGET_SELECTOR);
    const widgetCount = await widgets.count().catch(() => 0);
    if (selectOneIndex >= widgetCount) return { found: false, current: '' };
    const widget = widgets.nth(selectOneIndex);
    await page.evaluate(() => {
      document.querySelectorAll('[data-wd-so-target]').forEach((el) => el.removeAttribute('data-wd-so-target'));
    });
    await widget.evaluate((el) => el.setAttribute('data-wd-so-target', '1'));
    const current = await readMarkedSelectOneValue(page);
    return { found: true, current };
  }

  return await page.evaluate((target) => {
    function norm(s) {
      return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function isShortEeoLabel(label) {
      return /^(race|ethnicity|gender|sex|hispanic|veteran(\s*status)?)$/i.test(
        String(label || '').replace(/\*+/g, '').trim()
      );
    }
    function labelsMatch(a, b) {
      if (!a || !b) return false;
      const A = norm(a);
      const B = norm(b);
      if (A === B) return true;
      // Exact short EEO labels (Race ↔ Race)
      if (isShortEeoLabel(a) || isShortEeoLabel(b)) return A === B || A.includes(B) || B.includes(A);
      if (A.length > 12 && B.length > 12 && (A.includes(B.slice(0, 40)) || B.includes(A.slice(0, 40)))) return true;
      return false;
    }
    function readValueFromWidget(widget) {
      if (!widget) return '';
      const selected = widget.querySelector('[data-automation-id="selectedItem"]');
      if (selected?.textContent?.trim()) {
        const t = selected.textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const btn = widget.querySelector(
        'button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, button'
      );
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
      }
      return '';
    }
    function extractQuestionFromText(raw) {
      const text = (raw || '').replace(/\s+/g, ' ').trim().replace(/\*+$/, '');
      const questions = [...text.matchAll(/([^.!?]{8,500}\?)/g)].map((m) => m[1].trim());
      if (questions.length) {
        const preferred = questions.find((q) => /are you|have you|do you|will you|years old|age of|please select|please indicate/i.test(q));
        return preferred || questions[questions.length - 1];
      }
      const ageish = text.match(/((?:are you|must be|at least|over the age).{0,80}(?:1[68]).{0,40})/i);
      if (ageish) return ageish[1].trim();
      return text;
    }

    function labelForSelectWidget(widget) {
      const fieldRoot = widget.closest('[data-automation-id*="formField"]');
      if (fieldRoot) {
        const labelEl = fieldRoot.querySelector(
          '[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]'
        );
        const fromField = extractQuestionFromText(labelEl?.textContent || '');
        if (
          fromField
          && (fromField.length >= 14 || isShortEeoLabel(fromField))
          && !/indicates a required field|application questions \d+ of/i.test(fromField)
        ) {
          return fromField;
        }
      }
      const richTexts = Array.from(document.querySelectorAll(
        '[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]'
      ));
      let best = '';
      let bestDist = Infinity;
      const wrect = widget.getBoundingClientRect();
      for (const el of richTexts) {
        const label = extractQuestionFromText(el.textContent || '');
        if (!label || (label.length < 14 && !isShortEeoLabel(label))) continue;
        if (/indicates a required field|application questions \d+ of/i.test(label)) continue;
        if (!(el.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const rect = el.getBoundingClientRect();
        const dist = wrect.top - rect.bottom;
        if (dist >= -40 && dist < bestDist) {
          bestDist = dist;
          best = label;
        }
      }
      return best;
    }

    document.querySelectorAll('[data-wd-so-target]').forEach((el) => el.removeAttribute('data-wd-so-target'));
    const targetNorm = norm(target);
    const widgets = document.querySelectorAll('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]');
    for (const widget of widgets) {
      const label = labelForSelectWidget(widget);
      if (!label || !labelsMatch(label, target)) continue;
      widget.setAttribute('data-wd-so-target', '1');
      return { found: true, current: readValueFromWidget(widget) };
    }

    // Fallback: mark formField whose short label text equals target (Race / Gender / Hispanic)
    if (isShortEeoLabel(target) || targetNorm.length <= 12) {
      const fields = Array.from(document.querySelectorAll('[data-automation-id*="formField"]'));
      for (const field of fields) {
        const labelEl = field.querySelector('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]');
        const label = (labelEl?.textContent || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
        if (!labelsMatch(label, target)) continue;
        const trigger = field.querySelector(
          'button[aria-haspopup="listbox"], [role="combobox"], [data-automation-id="selectOne"] button, [data-automation-id="selectWidget"] button'
        );
        if (!trigger) continue;
        field.setAttribute('data-wd-so-target', '1');
        return { found: true, current: readValueFromWidget(field) };
      }
    }

    return { found: false, current: '' };
  }, labelText);
}

async function pickWorkdayPromptOption(page, answer, labelText = '') {
  // The candidate list carries both polarities for some labels (e.g. hispanic
  // pushes "Not Hispanic or Latino" and "Hispanic or Latino"). Once the answer
  // is a Yes or a No, only options of that polarity may ever be clicked.
  const intended = leadingYesNo(answer);
  const candidates = buildSelectOneOptionCandidates(answer, labelText)
    .filter((opt) => !intended || leadingYesNo(opt) === intended);
  if (!candidates.length) return false;

  await page.waitForSelector(
    '[data-automation-id="promptOption"], [role="option"], [data-automation-id="menuItem"]',
    { timeout: 2500 }
  ).catch(() => {});

  const OPTION_SELECTOR = '[data-automation-id="promptOption"], [role="option"], [data-automation-id="menuItem"]';
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const clickFirstVisible = async (locator) => {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      if (!(await el.isVisible({ timeout: 400 }).catch(() => false))) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ force: true });
      return true;
    }
    return false;
  };

  // Exact option text wins. Then an option that *starts* with the answer, which
  // covers "No, I have never ...". A loose substring is only allowed when the
  // answer is not Yes/No — otherwise "Yes, I have been notified" matches "No".
  for (const opt of candidates) {
    const exact = page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(`^\\s*${escapeRe(opt)}\\s*$`, 'i') });
    if (await clickFirstVisible(exact)) return true;
  }

  for (const opt of candidates) {
    const leading = page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(`^\\s*${escapeRe(opt)}\\b`, 'i') });
    if (await clickFirstVisible(leading)) return true;
  }

  const looseCandidates = candidates.filter((opt) => !leadingYesNo(opt));
  for (const opt of looseCandidates) {
    const loose = page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(escapeRe(opt), 'i') });
    if (await clickFirstVisible(loose)) return true;
  }

  if (!looseCandidates.length) return false;
  const picked = await clickVisiblePromptOption(page, looseCandidates);
  return Boolean(picked);
}

async function readMarkedSelectOneValue(page) {
  return await page.evaluate((triggerSel) => {
    const root = document.querySelector('[data-wd-so-target="1"]');
    if (!root) return '';
    const selected = root.querySelector('[data-automation-id="selectedItem"]');
    if (selected?.textContent?.trim()) {
      const t = selected.textContent.trim();
      if (!/^select(\s+one)?\.?$/i.test(t)) return t;
    }
    const btn = root.querySelector(triggerSel)
      || root.querySelector('button[aria-haspopup="listbox"], button');
    if (btn) {
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
    }
    return '';
  }, DROPDOWN_TRIGGER_IN_FIELD);
}

/**
 * Fill a single Workday selectOne/selectWidget dropdown by label or widget index.
 * Clicks the listbox button and picks a visible prompt option — never uses .fill() on buttons.
 */
export async function fillWorkdaySelectOneDropdown(page, labelText, answer, { selectOneIndex = null, formFieldIndex = null, dropdownPageIndex = null } = {}) {
  if (labelText && String(answer || '').trim()) {
    const custom = await fillWorkdayCustomDropdown(page, { label: labelText, fieldType: 'dropdown' }, answer);
    if (custom.success) {
      console.log(`    ✅ [selectOne] "${labelText.slice(0, 55)}..." ← "${String(custom.verifiedValue || answer).slice(0, 40)}"`);
      return true;
    }
  }

  const mark = await markSelectOneWidget(page, {
    labelText,
    selectOneIndex,
    formFieldIndex,
    dropdownPageIndex,
  });
  if (!mark?.found) {
    console.log(`    ⚠️  dropdown field not found for: "${labelText.slice(0, 55)}..."`);
    return false;
  }
  if (valuesFuzzyMatch(mark.current, answer)) return true;

  const fieldBox = page.locator('[data-wd-so-target="1"]').first();
  const trigger = fieldBox.locator(DROPDOWN_TRIGGER_IN_FIELD).first();
  if (!(await trigger.isVisible({ timeout: 1500 }).catch(() => false))) {
    console.log(`    ⚠️  selectOne trigger not visible for: "${labelText.slice(0, 55)}..."`);
    return false;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true });
  await page.waitForTimeout(500);

  let picked = await pickWorkdayPromptOption(page, answer, labelText);
  if (!picked && !/^(yes|no)$/i.test(String(answer || '').trim())) {
    const typed = await typeAndClickOption(page, fieldBox, answer);
    picked = typed.ok;
  }
  // Race/ethnicity: try short leaf "Asian" if full "Asian (United States of America)" missed
  if (!picked && /race|ethnicity/i.test(labelText) && /asian/i.test(String(answer))) {
    picked = await pickWorkdayPromptOption(page, 'Asian', labelText);
    if (!picked) {
      const typed = await typeAndClickOption(page, fieldBox, 'Asian');
      picked = typed.ok;
    }
  }
  if (!picked) {
    console.log(`    ⚠️  No prompt option matched for: "${labelText.slice(0, 45)}..." → "${String(answer).slice(0, 40)}"`);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await waitForDomSettled(page);

  const after = await readMarkedSelectOneValue(page);
  let verified = valuesFuzzyMatch(after, answer);
  if (!verified && /race|ethnicity/i.test(labelText) && after && /asian/i.test(after) && /asian/i.test(String(answer))) {
    verified = true;
  }
  if (verified) {
    console.log(`    ✅ [selectOne] "${labelText.slice(0, 55)}..." ← "${String(after || answer).length > 40 ? String(after || answer).slice(0, 40) + '...' : (after || answer)}"`);
  }
  return verified;
}

/**
 * Fill every visible Workday selectOne widget on the current page (Application Questions).
 */
async function resolveDropdownAnswer(page, profile, questionLabel, q, stepName) {
  const hit = await resolveDynamicAnswer(
    {
      ...q,
      label: questionLabel,
      fieldType: q.fieldType || 'dropdown',
      required: q.required ?? true,
    },
    profile,
    {
      stepName,
      pageNumber: 1,
      resumePath: profile?._resumePath,
      allowLlm: true,
    },
  );
  return hit?.answer || null;
}

/**
 * Fill all empty selectOne dropdowns on this page in one efficient pass.
 * A second pass runs only if new conditional dropdowns appeared (Yes/No follow-ups).
 */
export async function fillAllWorkdaySelectOneDropdowns(page, profile, stepName = '') {
  if (!/application questions|voluntary disclosures/i.test(stepName)) return 0;

  const tenant = profile?._tenant || getWorkdayTenant(page.url());
  const stepTag = /voluntary disclosures/i.test(stepName) ? 'VD' : 'AQ';
  let totalFilled = 0;
  // Pass 1: fill every empty required dropdown. Pass 2: only if conditional fields appeared.
  const maxPasses = 2;

  for (let pass = 0; pass < maxPasses; pass++) {
    await waitForDomSettled(page, { timeout: 1200 });

    const discovered = (await discoverFormFieldQuestions(page))
      .filter((q) => q.fieldType === 'dropdown' || q.fieldType === 'select');

    if (pass === 0) {
      const formFieldCount = await page.evaluate((triggerSel) => {
        return Array.from(document.querySelectorAll('[data-automation-id*="formField"]'))
          .filter((field) => field.querySelector(triggerSel)).length;
      }, DROPDOWN_TRIGGER_IN_FIELD).catch(() => 0);
      console.log(`  📋 ${stepTag} dropdown batch: ${formFieldCount} formField(s), ${discovered.length} question(s)`);
    }

    let filledThisPass = 0;
    for (let index = 0; index < discovered.length; index++) {
      const q = discovered[index];
      const questionLabel = extractQuestionLabel(q.label);
      const fieldIndex = q.formFieldIndex ?? index;

      if (isDropdownAnsweredInDom(q.currentValue)) {
        recordField(profile, questionLabel, q.currentValue);
        continue;
      }
      if (profile?._fillOptionalFields !== true && !isMandatoryField(questionLabel, q)) {
        continue;
      }

      const answer = await resolveDropdownAnswer(page, profile, questionLabel, q, stepName);
      if (!answer) {
        if (isDropdownAnsweredInDom(q.currentValue)) {
          recordField(profile, questionLabel, q.currentValue);
          continue;
        }
        console.log(`    ⚠️  No answer for: "${questionLabel.slice(0, 55)}..."`);
        continue;
      }

      const ok = await fillWorkdaySelectOneDropdown(page, questionLabel, answer, {
        dropdownPageIndex: index,
        formFieldIndex: fieldIndex,
        selectOneIndex: q.selectOneIndex ?? null,
      });
      if (ok) {
        recordField(profile, questionLabel, answer);
        await saveAnswerToYaml(questionLabel, answer).catch(() => {});
        if (tenant) {
          await saveAnswerToTenantYaml(tenant, {
            label: questionLabel,
            answer,
            fieldType: 'dropdown',
            options: q.options || [],
            step: stepName,
          }).catch(() => {});
        }
        filledThisPass++;
        totalFilled++;
        // Short settle only — keep filling remaining dropdowns in this same pass
        await waitForDomSettled(page, { timeout: 500 });
      }
    }

    if (filledThisPass === 0) break;

    // Only need another pass if Workday revealed new Select One fields after Yes/No
    const stillSelectOne = await page.evaluate((triggerSel) => {
      return Array.from(document.querySelectorAll(triggerSel)).some((btn) => {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        return /^select(\s+one)?\.?$/i.test(t);
      });
    }, DROPDOWN_TRIGGER_IN_FIELD).catch(() => false);

    if (!stillSelectOne) break;
    console.log(`  ↻ ${stepTag}: conditional dropdown(s) appeared — one more pass`);
  }

  if (totalFilled > 0) {
    console.log(`  ✓ ${stepTag}: ${totalFilled} dropdown(s) filled in one sweep`);
  }
  return totalFilled;
}

/**
 * Count mandatory questions on the current step that are still empty in the live DOM.
 */
export async function countUnfilledMandatoryQuestions(page, profile, stepName = '') {
  const tenant = profile?._tenant || getWorkdayTenant(page.url());
  const questions = await discoverFormFieldQuestions(page);
  let unfilled = 0;
  for (const q of questions) {
    const questionLabel = extractQuestionLabel(q.label);
    if (shouldSkipOptionalFill(questionLabel, q, profile, stepName)) continue;
    const expected = peekExpectedAnswer(questionLabel, profile, tenant);
    if (!isQuestionDomFilled(q, questionLabel, expected, profile)) unfilled++;
  }
  return unfilled;
}

/** Prompt terminal for any remaining Select One dropdowns; save answer to tenant DB only. */
async function promptRemainingSelectOneDropdowns(page, profile, stepName = '') {
  if (profile?._scanMode) return 0;
  const tenant = profile?._tenant || getWorkdayTenant(page.url());
  const questions = (await discoverFormFieldQuestions(page))
    .filter((q) => q.fieldType === 'dropdown' || q.fieldType === 'select');
  let filled = 0;
  for (const q of questions) {
    if (isDropdownAnsweredInDom(q.currentValue)) continue;
    const questionLabel = extractQuestionLabel(q.label);
    if (shouldSkipOptionalFill(questionLabel, q, profile, stepName)) continue;
    console.log(`    ❓ Unknown required dropdown: "${questionLabel.slice(0, 70)}"`);
    const answer = await resolveField({
      ...q,
      label: questionLabel,
      fieldType: 'dropdown',
      options: q.options || [],
      required: true,
    }, profile, createQAStore(), {
      company: profile?._company || profile?.company,
      step: stepName,
      page,
      tenant,
      skipPrompt: true,
    });
    if (!answer) continue;
    const idx = q.formFieldIndex ?? questions.indexOf(q);
    const ok = await fillWorkdaySelectOneDropdown(page, questionLabel, answer, {
      dropdownPageIndex: idx >= 0 ? idx : null,
      formFieldIndex: q.formFieldIndex ?? null,
      selectOneIndex: q.selectOneIndex ?? null,
    });
    if (ok) {
      recordField(profile, questionLabel, answer);
      if (tenant) {
        await saveAnswerToTenantYaml(tenant, {
          label: questionLabel,
          answer,
          fieldType: 'dropdown',
          options: q.options || [],
          step: stepName,
        }).catch(() => {});
      }
      filled++;
      await waitForDomSettled(page);
    }
  }
  return filled;
}

/**
 * Fill all Application Questions sub-pages, then advance with Next until the last page is complete.
 * Save and Continue is clicked later by the wizard loop.
 */
export async function ensureApplicationQuestionsComplete(page, profile, plan) {
  for (let subPage = 0; subPage < 3; subPage++) {
    await waitForDomSettled(page, { timeout: 1200 });

    // Brief wait for widgets — don't spin 8 seconds if empty
    let dropdownCount = 0;
    for (let waitPass = 0; waitPass < 3; waitPass++) {
      dropdownCount = await page.evaluate((triggerSel) => {
        const seen = new Set();
        let count = 0;
        document.querySelectorAll('[data-automation-id*="formField"], [data-automation-id*="secondaryQuestionnaire"]').forEach((scope) => {
          scope.querySelectorAll(triggerSel).forEach((btn) => {
            if (!seen.has(btn)) {
              seen.add(btn);
              count++;
            }
          });
        });
        return count;
      }, DROPDOWN_TRIGGER_IN_FIELD).catch(() => 0);
      if (dropdownCount > 0) break;
      await page.waitForTimeout(400);
    }

    await fillAllWorkdaySelectOneDropdowns(page, profile, 'Application Questions');
    await promptRemainingSelectOneDropdowns(page, profile, 'Application Questions');

    const remaining = await countUnfilledMandatoryQuestions(page, profile, 'Application Questions');
    const stillSelectOne = await page.evaluate((triggerSel) => {
      return Array.from(document.querySelectorAll(triggerSel)).some((btn) => {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        return /^select(\s+one)?\.?$/i.test(t);
      });
    }, DROPDOWN_TRIGGER_IN_FIELD).catch(() => false);
    const aqInfo = await getApplicationQuestionsPageInfo(page);

    if (stillSelectOne) {
      console.log(`  ⚠️  Application Questions still have "Select One" dropdown(s) on page ${aqInfo?.current || 1}`);
      return false;
    }
    if (remaining > 0) {
      console.log(`  ✓ Application Questions DOM complete (${remaining} field(s) with expected-answer mismatch — proceeding)`);
    }

    if (aqInfo && aqInfo.current < aqInfo.total) {
      await acknowledgeAllPageAgreements(page, profile, 'Application Questions');
      console.log(`  ✓ Application Questions page ${aqInfo.current} complete — clicking Next`);
      const moved = await advanceApplicationQuestionsPage(page);
      if (!moved) {
        console.log('  ⚠️  Could not click Next on Application Questions sub-page');
        return false;
      }
      await waitForDomSettled(page);
      continue;
    }

    console.log('  ✓ Application Questions complete — ready for Save and Continue');
    return true;
  }
  return false;
}

export async function getApplicationQuestionsPageInfo(page) {
  return await page.evaluate(() => {
    function isOnApplicationQuestionsStep() {
      const headings = Array.from(document.querySelectorAll(
        'h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="compositeHeader"], legend'
      ));
      for (const h of headings) {
        const text = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (/application\s*questions/i.test(text)) return true;
      }
      const active = document.querySelector(
        '[data-automation-id*="wizardStep"][aria-current="step"], [data-automation-id*="currentStep"], [aria-selected="true"]'
      );
      if (active && /application\s*questions/i.test(active.textContent || '')) return true;
      return false;
    }

    if (!isOnApplicationQuestionsStep()) return null;

    const searchRoots = [
      ...Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="compositeHeader"], legend')),
      document.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="mainContent"], main'),
    ].filter(Boolean);

    for (const el of searchRoots) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = text.match(/Application Questions\s*(\d+)\s*of\s*(\d+)/i);
      if (m) return { current: Number(m[1]), total: Number(m[2]) };
    }

    return { current: 1, total: 1 };
  }).catch(() => null);
}

export async function advanceApplicationQuestionsPage(page) {
  const info = await getApplicationQuestionsPageInfo(page);
  if (!info || info.current >= info.total) return false;

  await page.evaluate(() => {
    const footer = document.querySelector(
      '[data-automation-id="footerContainer"], [data-automation-id*="pageFooter"], footer'
    );
    footer?.scrollIntoView({ block: 'end', behavior: 'instant' });
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await page.waitForTimeout(500);

  const clicked = await page.evaluate(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && (el.offsetParent !== null || el.getClientRects().length > 0);
    };
    const isEnabled = (btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';

    const buttons = Array.from(document.querySelectorAll(
      'button, [role="button"], [data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]'
    ));
    const nextButtons = buttons.filter((btn) => {
      if (!isVisible(btn) || !isEnabled(btn)) return false;
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      const autoId = (btn.getAttribute('data-automation-id') || '').toLowerCase();
      if (/save and continue|save & continue|submit|previous|back/i.test(text)) return false;
      return /^next$/i.test(text) || autoId.includes('next');
    });

    const target = nextButtons[nextButtons.length - 1];
    if (!target) return { clicked: false, reason: 'no-enabled-next-button' };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { clicked: true, reason: '' };
  });

  if (clicked?.clicked) {
    await waitForDomSettled(page);
    await page.waitForTimeout(1200);
    const after = await getApplicationQuestionsPageInfo(page);
    if (after && after.current > info.current) {
      console.log(`    ↳ Application Questions: advanced to page ${after.current} of ${after.total}`);
      return true;
    }
  }

  const locators = [
    page.locator('[data-automation-id="pageFooterNextButton"]').last(),
    page.locator('[data-automation-id="bottom-navigation-next-button"]').last(),
    page.getByRole('button', { name: /^next$/i }).last(),
  ];
  for (const loc of locators) {
    if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) continue;
    if (!(await loc.isEnabled().catch(() => true))) continue;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ force: true });
    await waitForDomSettled(page);
    await page.waitForTimeout(1200);
    const after = await getApplicationQuestionsPageInfo(page);
    if (after && after.current > info.current) {
      console.log(`    ↳ Application Questions: advanced to page ${after.current} of ${after.total}`);
      return true;
    }
  }

  if (clicked?.reason === 'no-enabled-next-button') {
    console.log('    ⚠️  Next button disabled — one or more required dropdowns may still be empty');
  }
  return false;
}

function parseCheckboxGroupAnswers(answer, options = []) {
  const list = (options || []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (Array.isArray(answer)) {
    return answer.map((part) => String(part).trim()).filter(Boolean);
  }
  const raw = String(answer || '').trim();
  if (list.length && raw) {
    const lower = raw.toLowerCase();
    const hits = list.filter((opt) => lower.includes(opt.toLowerCase()));
    if (hits.length) return hits;
  }
  return raw.split(/[,;|]/).map((part) => String(part).trim()).filter(Boolean);
}

function isWorkTypeCheckboxLabel(label = '') {
  const text = String(label || '');
  return /work\s*types?|employment\s*types?|schedule\s*preference|shift\s*preference|what.*schedule|hours?\s*per\s*week|available\s*for/i.test(text)
    || /what\s*work\s*types?\s*are\s*you\s*open\s*to/i.test(text);
}

function isFullTimeWorkTypeLabel(label = '') {
  return /^full[-\s]?time$/i.test(String(label || '').replace(/\*+/g, '').trim());
}

function isPartTimeWorkTypeLabel(label = '') {
  return /^part[-\s]?time$/i.test(String(label || '').replace(/\*+/g, '').trim());
}

function isWorkTypeContainerText(text = '') {
  return isWorkTypeCheckboxLabel(text) || /full[-\s]?time.*part[-\s]?time|part[-\s]?time.*full[-\s]?time/i.test(String(text || ''));
}

export function adjustAnswerForFieldType(questionLabel, answer, q, profile) {
  const options = (q?.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .filter(Boolean);

  // Align an existing client/LLM answer to the live options — never invent one.
  if (answer == null || String(answer).trim() === '') return null;

  const yesNoOptions = options.length > 0 && options.every((o) => /^(yes|no)\b/i.test(String(o).trim()));
  if (yesNoOptions && !isYesNoAnswer(answer)) {
    console.log(`    ⛔ [Yes/No guard] "${String(answer).slice(0, 40)}" is not valid for "${questionLabel.slice(0, 50)}" — leaving empty`);
    return null;
  }

  if (isSalaryQuestion(questionLabel) && profile) {
    if (options.length) {
      const picked = pickCompensationFromOptions(options, profile, answer);
      if (picked) return picked;
    }
    if (q?.fieldType === 'text' || q?.fieldType === 'input' || !options.length) {
      return compensationInputValue(profile, questionLabel) || answer;
    }
  }

  return answer;
}

/**
 * Read the visible option labels of a checkbox group, scoped to the field.
 * @param {import('playwright').Locator} fieldBox
 * @returns {Promise<string[]>}
 */
async function readCheckboxGroupOptions(fieldBox) {
  return await fieldBox.evaluate((root) => {
    const doc = root.ownerDocument || document;
    let boxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));
    return boxes.map((cb) => {
      const lab = cb.id ? doc.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : cb.closest('label');
      return (lab?.textContent || cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
  }).catch(() => []);
}

export async function fillCheckboxGroupField(page, fieldBox, label, answer, profile = null) {
  // "Check every option" is only safe when the options really are shifts — a group
  // offering Full Time / Part Time / Per Diem stays a single-choice work-type group.
  const groupOptions = await readCheckboxGroupOptions(fieldBox);
  const employmentTypeOptions = groupOptions.some((o) => /part[-\s]?time|per\s*diem|contingent/i.test(o));
  const shiftGroup = isShiftAvailabilityQuestion(label) && !employmentTypeOptions;
  const workTypeGroup = !shiftGroup && (isWorkTypeCheckboxLabel(label) || isWorkTypeContainerText(label));
  const salaryGroup = !shiftGroup && isSalaryQuestion(label);

  let desired = parseCheckboxGroupAnswers(answer, groupOptions);
  if (salaryGroup && !desired.length) {
    const picked = pickCompensationFromOptions(groupOptions, profile, answer);
    if (picked) desired = [picked];
  }

  // Only check boxes named by Apply Wizz / LLM. Do not invent Full Time or every shift.
  const targets = desired;
  if (!targets.length) {
    console.log(`    ⚠️  No client/LLM picks for checkbox group "${String(label).slice(0, 50)}" — leaving empty`);
    return false;
  }
  const mode = salaryGroup ? 'one' : workTypeGroup ? 'worktype' : 'match';

  const result = await fieldBox.evaluate((root, { targets, mode }) => {
    const doc = root.ownerDocument || document;
    const norm = (v) => String(v || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

    // Scope to this field; only fall back to the page when the group sits outside it.
    let boxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));

    const labelOf = (cb) => {
      const lab = cb.id ? doc.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : cb.closest('label');
      return (lab?.textContent || cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    };
    const setChecked = (cb, want) => {
      if (cb.checked === want) return;
      cb.click();
      if (cb.checked !== want) {
        const lab = cb.id ? doc.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : cb.closest('label');
        lab?.click();
      }
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const picked = [];

    if (mode === 'all') {
      for (const cb of boxes) {
        setChecked(cb, true);
        const text = labelOf(cb);
        if (text) picked.push(text);
      }
    } else {
      if (mode === 'worktype') {
        for (const cb of boxes) {
          if (/part\s*time/.test(norm(labelOf(cb)))) setChecked(cb, false);
        }
      }

      for (const target of targets) {
        const needle = norm(target);
        if (!needle) continue;
        const squash = (v) => v.replace(/\s+/g, '');
        const cb = boxes.find((node) => {
          const hay = norm(labelOf(node));
          if (!hay) return false;
          if (mode === 'worktype' && /part\s*time/.test(hay)) return false;
          if (hay === needle || hay.includes(needle) || needle.includes(hay)) return true;
          // "Full Time" must still match a "Full-time" target.
          return squash(hay) === squash(needle);
        });
        if (!cb) continue;
        setChecked(cb, true);
        const text = labelOf(cb);
        if (text) picked.push(text);
        if (mode === 'one') break;
      }

      if (picked.length === 0 && boxes.length > 0 && mode !== 'one') {
        const cb = boxes.find((node) => (
          mode === 'worktype' ? /full\s*time/.test(norm(labelOf(node))) : !node.checked
        )) || boxes[0];
        setChecked(cb, true);
        const text = labelOf(cb);
        if (text) picked.push(text);
      }
    }

    const checked = boxes.filter((cb) => cb.checked).map(labelOf).filter(Boolean);
    return { picked, checked };
  }, { targets, mode }).catch(() => ({ picked: [], checked: [] }));

  if ((result.checked || []).length > 0) {
    console.log(`    ✓ Checkbox group "${label.slice(0, 50)}..." → [${result.checked.join(', ')}]`);
    return true;
  }
  return false;
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

  const ageYes = resolveMinimumAgeAnswer(label, profile);
  if (ageYes) return ageYes;

  // Salary must only match an exact cached answer — never fuzzy or profile guess.
  const threshold = isSalaryQuestion(label) ? 1 : settings.fuzzy_threshold;
  const fuzzy = await findBestMatch(label, profile, store, threshold);
  if (fuzzy?.answer) return fuzzy.answer;

  if (!isSalaryQuestion(label)) {
    const fromClient = peekClientAnswer(label, profile);
    if (fromClient) return fromClient;

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
  const clean = String(label)
    .replace(/\s+/g, ' ')
    .replace(/^\*+|\*+$/g, '')
    .replace(/\s+select(\s+one)?(\s+required)?\s*$/i, '')
    .replace(/\s+required\s*$/i, '')
    .trim();
  const question = clean.match(/[^.?!]*\?/);
  if (question && question[0].length >= 15) return question[0].trim();
  if (/please\s+enter\s+your\s+name/i.test(clean)) return 'Please enter your name:';
  if (/please\s+enter\s+today['’]?s\s+date/i.test(clean)) return "Please enter today's date:";
  return clean;
}

function isYesNoDropdownQuestion(label = '') {
  const norm = normalizeLabel(label);
  return /relative of a current public official/i.test(norm)
    || /relative of a current senior level person or senior commercial person/i.test(norm)
    || /would you like to proceed|do you (wish|want) to proceed/i.test(norm)
    || isYesNoQuestion(label);
}

const DROPDOWN_TRIGGER_SELECTOR = [
  'select',
  '[role="combobox"]',
  'button[aria-haspopup="listbox"]',
  '[data-automation-id="selectWidget"] button',
  '[data-automation-id="selectOne"] button',
  '[data-automation-id*="select"] button',
].join(', ');

async function fillDropdownInFieldBox(page, fieldBox, label, answer) {
  const combo = fieldBox.locator(DROPDOWN_TRIGGER_SELECTOR).first();
  if (!(await combo.isVisible({ timeout: 1000 }).catch(() => false))) {
    const typedOnly = await typeAndClickOption(page, fieldBox, answer);
    return typedOnly.ok;
  }

  await combo.scrollIntoViewIfNeeded().catch(() => {});

  const directAgreementSelected = await selectExactAgreementOption(page, label, answer);
  if (directAgreementSelected) return true;

  const yesNo = /^(yes|no)$/i.test(String(answer || '').trim()) || isYesNoDropdownQuestion(label);
  if (!yesNo) {
    const typed = await typeAndClickOption(page, fieldBox, answer);
    if (typed.ok) return true;
  }

  const result = await handleDropdown(page, combo, answer, label);
  const visibleValue = (await combo.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  const selectionStuck = /^select(\s+one)?$/i.test(visibleValue);
  if (result.success && !selectionStuck) return true;

  await combo.click({ force: true });
  const options = /notice\s*period/i.test(label)
    ? buildSelectOneOptionCandidates(answer, label)
    : /mutual\s+arbitration\s+agreement/i.test(label)
      ? [answer, 'I have read and agree to the Mutual Arbitration Agreement', 'I agree', 'Agree']
      : /non\s+disclosure\s+agreement/i.test(label)
        ? [answer, 'I have read and agree to the Non Disclosure Agreement', 'I agree', 'Agree']
        : [answer, 'Yes', 'No'];
  const clicked = await clickVisiblePromptOption(page, options);
  if (clicked) return true;
  if (yesNo) return false;
  const typed = await typeAndClickOption(page, fieldBox, answer);
  return typed.ok;
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
  const questionLabel = extractQuestionLabel(label);
  if (/type to add skills|enter a skill below/i.test(questionLabel)) {
    if (profile?._fillOptionalFields !== true && !isMandatoryField(questionLabel, fieldMetadata)) {
      return true;
    }
    const ok = await fillWorkdaySkillsField(page, null, profile);
    if (ok && profile) recordField(profile, questionLabel, answer || 'skills-filled');
    return ok;
  }

  const normTarget = normalizeLabel(questionLabel);
  let marked = false;
  if (fieldMetadata?.wdQId) {
    marked = await page.evaluate((id) => {
      const el = document.querySelector(`[data-wd-q-id="${id}"]`);
      if (!el) return false;
      document.querySelectorAll('[data-auto-fill-target]').forEach((node) => node.removeAttribute('data-auto-fill-target'));
      el.setAttribute('data-auto-fill-target', '1');
      return true;
    }, fieldMetadata.wdQId).catch(() => false);
  }
  if (!marked) marked = await page.evaluate((target) => {
    function norm(s) {
      return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function labelsMatch(a, b) {
      if (!a || !b) return false;
      const A = String(a).toLowerCase();
      const B = String(b).toLowerCase();
      if (A === B) return true;
      if (A.length > 12 && B.length > 12 && (A.includes(B.slice(0, 28)) || B.includes(A.slice(0, 28)))) return true;
      if (A.slice(0, 40) === B.slice(0, 40) && A.length > 24) return true;
      if (A.length > 20 && B.length > 20 && (A.includes(B.slice(0, 20)) || B.includes(A.slice(0, 20)))) return true;

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
      if (/relative of a current public official/i.test(A) && /relative of a current public official/i.test(B)) return true;
      if (/relative of a current senior level person/i.test(A) && /relative of a current senior level person/i.test(B)) return true;
      if (/please select one of the below options/i.test(A) && /please select one of the below options/i.test(B)) return true;
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
    } else if (
      fieldType === 'dropdown'
      || fieldType === 'select'
      || fieldType === 'combobox'
      || fieldType === 'typeahead'
      || isYesNoDropdownQuestion(questionLabel)
      || (['Yes', 'No'].includes(String(answer)) && await fieldBox.locator(DROPDOWN_TRIGGER_SELECTOR).first().isVisible({ timeout: 400 }).catch(() => false))
    ) {
      ok = await fillDropdownInFieldBox(page, fieldBox, label, answer);
    } else if (/^(text|textarea|number|input|tel|email)$/i.test(fieldType) || !fieldType) {
      const fillValue = isSalaryQuestion(questionLabel)
        ? (compensationInputValue(profile, questionLabel) || answer)
        : answer;
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
          await input.fill(String(fillValue));
          await input.press('Tab').catch(() => {});
          const actual = (await input.inputValue().catch(() => '') || '').trim();
          if (actual || String(fillValue).length > 0) {
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
        }, { value: String(fillValue) });
      }
    } else if (fieldType === 'checkbox') {
      if (isPartTimeWorkTypeLabel(questionLabel)) {
        ok = true;
      } else if (isFullTimeWorkTypeLabel(questionLabel) || isWorkTypeCheckboxLabel(questionLabel)) {
        const cb = fieldBox.locator('input[type="checkbox"]').first();
        if (await cb.isVisible({ timeout: 800 }).catch(() => false)) {
          const isChecked = await cb.isChecked().catch(() => false);
          if (!isChecked) await cb.click({ force: true });
          ok = await cb.isChecked().catch(() => false);
        }
      } else {
        const wantChecked = isCheckboxAckAnswer(answer) || isForegoingStatementCertifyLabel(label);
        const cb = fieldBox.locator('input[type="checkbox"]').first();
        if (await cb.isVisible({ timeout: 800 }).catch(() => false)) {
          const isChecked = await cb.isChecked().catch(() => false);
          if (wantChecked && !isChecked) await cb.click({ force: true });
          ok = wantChecked ? (await cb.isChecked().catch(() => false)) : true;
        }
        if (!ok && wantChecked) {
          const certLabel = fieldBox.locator('label').filter({ hasText: /certify.*foregoing statement/i }).first();
          if (await certLabel.isVisible({ timeout: 800 }).catch(() => false)) {
            await certLabel.click({ force: true });
            ok = true;
          }
        }
      }
    } else if (fieldType === 'checkbox-group') {
      ok = await fillCheckboxGroupField(page, fieldBox, label, answer, profile);
      if (!ok) {
        const area = fieldBox.locator('textarea, input[type="text"]').first();
        if (await area.isVisible({ timeout: 600 }).catch(() => false)) {
          await area.scrollIntoViewIfNeeded().catch(() => {});
          await area.fill(String(answer));
          ok = Boolean((await area.inputValue().catch(() => '') || '').trim());
        }
      }
    } else if (fieldType === 'radio') {
      const escaped = String(answer).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A bare "No" must anchor to the leading word, otherwise it also matches
      // a "Yes, I have been notified" option.
      const answerRe = leadingYesNo(answer)
        ? new RegExp(`^\\s*${escaped}\\b`, 'i')
        : new RegExp(escaped, 'i');
      const radio = fieldBox.getByRole('radio', { name: answerRe }).first();
      if (await radio.isVisible({ timeout: 800 }).catch(() => false)) {
        await radio.click({ force: true });
        ok = true;
      } else {
        const opt = fieldBox.locator('label').filter({ hasText: answerRe }).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click({ force: true });
          ok = true;
        }
      }
      if (!ok && /please\s+check\s+one\s+of\s+the\s+boxes|disability/i.test(label)) {
        const pageRadio = page.getByRole('radio', { name: answerRe }).first();
        if (await pageRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
          await pageRadio.click({ force: true });
          ok = true;
        } else {
          const pageLabel = page.locator('label').filter({ hasText: answerRe }).first();
          if (await pageLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
            await pageLabel.click({ force: true });
            ok = true;
          }
        }
      }
    } else {
      ok = await fillDropdownInFieldBox(page, fieldBox, label, answer);
          if (ok && /mutual\s+arbitration\s+agreement/i.test(label)) {
        const combo = fieldBox.locator(DROPDOWN_TRIGGER_SELECTOR).first();
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
  let totalFilled = 0;

  // At most 3 sub-page advances — stop as soon as current page has nothing left to fill
  for (let pagePass = 0; pagePass < 3; pagePass++) {
  await waitForDomSettled(page, { timeout: 1000 });
  const qaStore = createQAStore();
  let questions = await discoverFormFieldQuestions(page);

    const pageInfo = await getApplicationQuestionsPageInfo(page);
    const pageHint = pageInfo ? `page ${pageInfo.current} of ${pageInfo.total}` : (stepName || 'form fields');

  console.log(`  📋 DOM [${pageHint}]: ${questions.length} formField question(s) detected`);

  if (questions.length === 0) {
    await page.waitForTimeout(400);
    questions = await discoverFormFieldQuestions(page);
    if (questions.length > 0) {
      console.log(`    ↳ After wait: ${questions.length} formField question(s)`);
    }
  }

  let filled = 0;
  let skipped = 0;

    if (/application questions|voluntary disclosures/i.test(stepName)) {
      const batchFilled = await fillAllWorkdaySelectOneDropdowns(page, profile, stepName);
      filled += batchFilled;
      if (batchFilled > 0) {
        await waitForDomSettled(page);
        questions = await discoverFormFieldQuestions(page);
      }
    }

  for (const q of questions) {
    if (isCheckboxOnlyLabel(q.label)) continue;
    if (/employee\s*id.*if applicable/i.test(q.label)) continue;

    const questionLabel = extractQuestionLabel(q.label);
      if (shouldSkipOptionalFill(questionLabel, q, profile, stepName)) {
        skipped++;
        continue;
      }
    const norm = normalizeLabel(questionLabel);
      const tenantForPeek = profile?._tenant || getWorkdayTenant(page.url());
      const expectedPeek = peekExpectedAnswer(questionLabel, profile, tenantForPeek);
      const domFilled = isQuestionDomFilled(q, questionLabel, expectedPeek, profile);
      const isDropdown = q.fieldType === 'dropdown' || q.fieldType === 'select';
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

      const sessionRecorded = profile?._filledValues
        && Object.keys(profile._filledValues).some((k) => normalizeLabel(k) === norm);

      if (!dynamicDateAction && sessionRecorded && domFilled && !isDropdown) {
      skipped++;
      continue;
    }
      if (sessionRecorded && !domFilled && profile?._filledValues) {
        for (const key of Object.keys(profile._filledValues)) {
          if (normalizeLabel(key) === norm) delete profile._filledValues[key];
        }
      }
      if (isDropdown && isDropdownAnsweredInDom(q.currentValue)) {
        recordField(profile, questionLabel, q.currentValue);
        skipped++;
        continue;
      } else if (domFilled && (!dynamicDateAction || isCurrentDateAlreadyCorrect)) {
      if (dynamicDateAction && isCurrentDateAlreadyCorrect) {
        console.log(`[date] Current-date field already verified: ${currentDateValue}`);
      }
        recordField(profile, questionLabel, expectedPeek || q.currentValue);
      skipped++;
      continue;
    }

      const optionPreview = (q.options || []).map((o) => (typeof o === 'string' ? o : o?.text)).filter(Boolean);
      console.log(`    🔎 Live parse [${q.fieldType}]: "${questionLabel.slice(0, 70)}"${optionPreview.length ? ` | options: ${optionPreview.slice(0, 6).join(', ')}${optionPreview.length > 6 ? ', ...' : ''}` : ' | input field'}`);

      const tenant = profile?._tenant || getWorkdayTenant(page.url());
      const resolved = await resolveDynamicAnswer(
        {
          ...q,
          label: questionLabel,
          required: q.required ?? true,
          fieldType: q.fieldType,
          type: q.fieldType,
        },
        profile,
        {
          stepName: stepName || profile?._currentStep || '',
          pageNumber: 1,
          resumePath: profile?._resumePath,
          qaStore,
          allowLlm: true,
        },
      );
      let answer = resolved?.answer || null;
    if (!answer) {
      console.log(`    ⚠️  No answer supplied for: "${q.label.slice(0, 70)}..."`);
      continue;
    }

    answer = adjustAnswerForFieldType(questionLabel, answer, q, profile) || answer;
    if (!answer) {
      skipped++;
      continue;
    }

      let ok = false;
      if (isDropdown || isYesNoDropdownQuestion(questionLabel)) {
        const dropdownIdx = q.formFieldIndex ?? q.selectOneIndex ?? questions.indexOf(q);
        ok = await fillWorkdaySelectOneDropdown(page, questionLabel, answer, {
          dropdownPageIndex: dropdownIdx >= 0 ? dropdownIdx : null,
          formFieldIndex: q.formFieldIndex ?? null,
          selectOneIndex: q.selectOneIndex ?? null,
        });
      }
      if (!ok) {
        ok = await fillApplicationQuestionField(page, questionLabel, q.fieldType, answer, profile, q);
      }
      if (!ok && (isDropdown || isYesNoDropdownQuestion(questionLabel))) {
        ok = await fillWorkdayDropdownByLabel(page, questionLabel, answer);
      }
      if (ok && isDropdown) {
        const verifyIdx = q.formFieldIndex ?? q.selectOneIndex ?? questions.indexOf(q);
        const verifyMark = await markSelectOneWidget(page, {
          labelText: questionLabel,
          dropdownPageIndex: verifyIdx >= 0 ? verifyIdx : null,
          formFieldIndex: q.formFieldIndex ?? null,
          selectOneIndex: q.selectOneIndex ?? null,
        });
        ok = verifyMark?.found && (valuesFuzzyMatch(verifyMark.current, answer) || isDropdownAnsweredInDom(verifyMark.current));
      }
    if (ok) {
      recordField(profile, questionLabel, answer);
        await saveAnswerToYaml(questionLabel, answer).catch(() => {});
        if (!profile.qa_answers) profile.qa_answers = {};
        profile.qa_answers[normalizeLabel(questionLabel)] = answer;
        if (tenant) {
          await saveAnswerToTenantYaml(tenant, {
            label: questionLabel,
            answer,
            fieldType: q.fieldType,
            options: q.options || [],
            step: stepName || profile?._currentStep || '',
          }).catch(() => {});
        }
        if (!isDropdown) {
          console.log(`    ✅ [${q.fieldType}] "${q.label.slice(0, 55)}..." ← "${String(answer).length > 40 ? String(answer).slice(0, 40) + '...' : answer}"`);
        }
      filled++;
      await waitForDomSettled(page);
    } else {
      const live = (q.options || []).map((o) => (typeof o === 'string' ? o : o?.text)).filter(Boolean);
      const options = live.length ? live : await collectLiveFieldOptions(page, questionLabel, q.fieldType).catch(() => []);
      const nearest = options.length
        ? await pickNearestSelectOption({
          question: questionLabel,
          options,
          preferred: answer,
          profile,
          company: profile?._company,
        })
        : await resolveUnknownWithLlm(questionLabel, q, { page, profile, preferred: answer });
      if (nearest && nearest !== answer) {
        ok = await fillApplicationQuestionField(page, questionLabel, q.fieldType, nearest, profile, q);
        if (!ok) ok = Boolean(await typeAndClickOption(page, page.locator('[data-auto-fill-target="1"]').first(), nearest).then((r) => r.ok).catch(() => false));
        if (ok) {
          answer = nearest;
          recordField(profile, questionLabel, nearest);
          await saveAnswerToYaml(questionLabel, nearest).catch(() => {});
          if (tenant) {
            await saveAnswerToTenantYaml(tenant, {
              label: questionLabel,
              answer: nearest,
              fieldType: q.fieldType,
              options,
              step: stepName || profile?._currentStep || '',
            }).catch(() => {});
          }
          console.log(`    ✅ [nearest] "${questionLabel.slice(0, 55)}..." ← "${String(nearest).slice(0, 40)}"`);
          filled++;
          await waitForDomSettled(page);
          continue;
        }
      }
      console.log(`    ⚠️  Could not fill: "${q.label.slice(0, 55)}..."`);
    }
  }

  if (skipped > 0 && filled === 0) {
      console.log(`    ℹ️  ${skipped} field(s) skipped (verified filled in live DOM)`);
    }

    totalFilled += filled;

    if (/application questions/i.test(stepName)) {
      const refreshedInfo = await getApplicationQuestionsPageInfo(page);
      if (refreshedInfo && refreshedInfo.current < refreshedInfo.total) {
        const advanced = await advanceApplicationQuestionsPage(page);
        if (advanced) continue;
      }
    }
    break;
  }

  return totalFilled;
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

const SELF_IDENTIFY_DISABILITY_ANSWER = 'No, I do not have a disability and have not had one in the past';

async function readSelfIdentifyFieldStatus(page) {
  return await page.evaluate(() => {
    const status = { language: '', name: '', date: '', disability: false };
    const fields = document.querySelectorAll('[data-automation-id*="formField"]');
    for (const field of fields) {
      const label = (field.querySelector('label, legend, [data-automation-id*="label"]')?.textContent || '')
        .replace(/\*+/g, '').trim().toLowerCase();
      if (label === 'language') {
        const btn = field.querySelector('button[aria-haspopup="listbox"], [role="combobox"]');
        const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select/i.test(t)) status.language = t;
      }
      if (label === 'name') {
        const input = field.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
        status.name = (input?.value || '').trim();
      }
      if (label === 'date') {
        const spins = field.querySelectorAll('input[role="spinbutton"]');
        if (spins.length >= 3) {
          status.date = `${spins[0]?.value || ''}/${spins[1]?.value || ''}/${spins[2]?.value || ''}`;
        } else {
          const input = field.querySelector('input[type="date"], input[type="text"]');
          status.date = (input?.value || '').trim();
        }
      }
    }
    for (const input of document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')) {
      const id = input.id;
      const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : input.closest('label');
      const text = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
      if (/do not have a disability|no disability|not have a disability/i.test(text)) {
        status.disability = true;
      }
    }
    return status;
  });
}

/**
 * Select English from the Language dropdown on Self Identify (CC-305).
 */
async function fillSelfIdentifyLanguage(page, profile) {
  const langFieldCount = await page.locator('[data-automation-id*="formField"]').filter({ hasText: /^Language\b/i }).count().catch(() => 0);
  if (langFieldCount === 0) return true;

  const language = profile?.eeo?.language || profile?.personal?.language || 'English';
  const current = await readSelfIdentifyFieldStatus(page);
  if (current.language && /english/i.test(current.language)) {
    recordField(profile, 'Language', current.language);
    return true;
  }

  let ok = await fillWorkdaySelectOneDropdown(page, 'Language', language, { dropdownPageIndex: 0 });
  if (!ok) {
    const langField = page.locator('[data-automation-id*="formField"]').filter({ hasText: /^Language\b/i }).first();
    const trigger = langField.locator(DROPDOWN_TRIGGER_IN_FIELD).first();
    if (await trigger.isVisible({ timeout: 1500 }).catch(() => false)) {
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await trigger.click({ force: true });
      await page.waitForTimeout(450);
      ok = Boolean(await clickVisiblePromptOption(page, [language, 'English', 'english', 'English (US)', 'English (United States)']));
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  const after = await readSelfIdentifyFieldStatus(page);
  if (after.language && !/^select/i.test(after.language)) {
    recordField(profile, 'Language', after.language);
    console.log(`    ✅ [dropdown] Language ← "${after.language}"`);
    return true;
  }
  console.log('    ⚠️  Language dropdown not verified');
  return false;
}

/**
 * Click "No, I do not have a disability..." radio or checkbox on Self Identify.
 */
async function fillSelfIdentifyDisability(page, profile) {
  const disabilityAnswer = profile?.eeo?.disability_status
    || profile?.qa_answers?.[normalizeLabel('please check one of the boxes below:')]
    || SELF_IDENTIFY_DISABILITY_ANSWER;

  const current = await readSelfIdentifyFieldStatus(page);
  if (current.disability) {
    recordField(profile, 'Please check one of the boxes below:', disabilityAnswer);
    return true;
  }

  let ok = await fillApplicationQuestionField(
    page,
    'Please check one of the boxes below:',
    'radio',
    disabilityAnswer,
    profile,
    { containerText: 'Voluntary Self-Identification of Disability CC-305' }
  );

  if (!ok) {
    const patterns = [
      /no,?\s*i do not have a disability/i,
      /do not have a disability and have not had one in the past/i,
      /i don't have a disability/i,
    ];
    for (const pattern of patterns) {
      const radio = page.getByRole('radio', { name: pattern }).first();
      if (await radio.isVisible({ timeout: 600 }).catch(() => false)) {
        await radio.click({ force: true });
        ok = true;
        break;
      }
      const label = page.locator('label').filter({ hasText: pattern }).first();
      if (await label.isVisible({ timeout: 600 }).catch(() => false)) {
        await label.click({ force: true });
        ok = true;
        break;
      }
    }
  }

  if (!ok) {
    ok = await page.evaluate(() => {
      const needles = [/do not have a disability/i, /no disability/i];
      for (const input of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
        const id = input.id;
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : input.closest('label');
        const text = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!needles.some((re) => re.test(text))) continue;
        if (!input.checked) {
          input.click();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return input.checked;
      }
      return false;
    });
  }

  const after = await readSelfIdentifyFieldStatus(page);
  if (after.disability || ok) {
    recordField(profile, 'Please check one of the boxes below:', disabilityAnswer);
    console.log(`    ✅ [disability] "${disabilityAnswer.slice(0, 55)}..."`);
    return true;
  }
  console.log('    ⚠️  Disability attestation not verified');
  return false;
}

/**
 * Fill all Self Identify fields in order: Language → Name → Date → Disability.
 * @returns {Promise<boolean>}
 */
export async function ensureSelfIdentifyComplete(page, profile) {
  // One fill + at most one retry if something is still empty
  for (let pass = 0; pass < 2; pass++) {
    await waitForDomSettled(page, { timeout: 1000 });
    await handleSelfIdentifyStep(page, profile);

    const fieldPresence = await page.evaluate(() => ({
      language: Array.from(document.querySelectorAll('[data-automation-id*="formField"]')).some((f) =>
        /^language$/i.test((f.querySelector('label, legend')?.textContent || '').replace(/\*+/g, '').trim())
      ),
    }));
    const status = await readSelfIdentifyFieldStatus(page);
    const missing = [];
    if (fieldPresence.language && (!status.language || /^select/i.test(status.language))) missing.push('Language');
    if (!status.name) missing.push('Name');
    if (!status.date || /^m+\/d+\/y+$/i.test(status.date)) missing.push('Date');
    if (!status.disability) missing.push('Disability');

    if (missing.length === 0) {
      console.log('  ✓ Self Identify complete (Language, Name, Date, Disability) — ready for Save and Continue');
      return true;
    }

    if (pass === 0) {
      console.log(`  ↻ Self Identify one retry — missing: ${missing.join(', ')}`);
      await page.waitForTimeout(500);
    }
  }
  console.log('  ⚠️  Self Identify may still be incomplete — will try Save and Continue anyway');
  return false;
}

/**
 * OFCCP Self Identify step (CC-305): Language, Name, Date, disability attestation.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<number>}
 */
export async function handleSelfIdentifyStep(page, profile) {
  console.log('  📋 Self Identify (OFCCP CC-305) — Language → Name → Date → Disability...');
  await waitForDomSettled(page);

  const fullName = profile?.personal?.full_name
    || `${profile?.personal?.first_name || ''} ${profile?.personal?.last_name || ''}`.trim();
  const selfIdentifyMeta = {
    containerText: 'Voluntary Self-Identification of Disability CC-305 OMB Control Number current value is MM/DD/YYYY',
    placeholder: 'MM/DD/YYYY',
  };

  let filled = 0;
  const today = getTodayMMDDYYYY('Asia/Kolkata');

  if (await fillSelfIdentifyLanguage(page, profile)) filled++;

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

  if (await fillSelfIdentifyDisability(page, profile)) filled++;

  return filled;
}

/**
 * Fill Gender dropdown on Voluntary Disclosures (combobox only — not checkbox).
 * @param {import('playwright').Page} page
 * @param {string} gender
 * @param {object} [profile]
 * @returns {Promise<boolean>}
 */
export async function fillGenderDropdown(page, gender = '', profile = null) {
  const wanted = String(
    gender
    || profile?.eeo?.gender
    || peekExpectedAnswer('Please select your gender.', profile)
    || ''
  ).trim();
  if (!wanted) return false;
  gender = wanted;

  for (const label of ['Please select your gender.', 'Gender', 'Sex']) {
    const custom = await fillWorkdayCustomDropdown(page, { label, fieldType: 'dropdown' }, wanted);
    if (custom.success) {
      recordField(profile, 'Gender', custom.verifiedValue);
      return true;
    }
  }

  // The DOM decides, not the session record — a remembered value can belong to
  // an earlier page while this one is still empty.
  const dom = await discoverVoluntaryDisclosureDom(page);
  if (dom.gender.currentValue && /male|female|non-binary/i.test(dom.gender.currentValue)) {
    recordField(profile, 'Gender', dom.gender.currentValue);
    console.log(`    ✓ Gender already "${dom.gender.currentValue}" in DOM`);
    return true;
  }
  if (!dom.gender.label && profile?._filledValues?.Gender === gender) {
    console.log('    ✓ Gender field not on this page — skipping');
    return true;
  }

  const genderField = page.locator('[data-automation-id*="formField"]').filter({ hasText: /^Gender\b|^Sex\b|Please\s*select\s*your\s*sex/i }).first();
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

  const byRole = page.getByRole('combobox', { name: /^gender|^sex|please select your sex/i }).first();
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
      .find((el) => /^(gender|sex)$/i.test(normalize(el.textContent)) || /please select your sex/i.test(normalize(el.textContent).toLowerCase()));
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
 * Fill veteran status on Voluntary Disclosures. Opens the dropdown and clicks
 * "I am not a veteran" when that is the stored profile answer.
 * @param {import('playwright').Page} page
 * @param {string} [veteran]
 * @param {object} [profile]
 * @returns {Promise<boolean>}
 */
export async function fillVeteranStatusDropdown(page, veteran = '', profile = null) {
  const stored = String(
    veteran
    || profile?.eeo?.veteran_status
    || peekExpectedAnswer('Please select the veteran status which most accurately describes how you identify yourself.', profile)
    || peekExpectedAnswer('Please select your veteran status.', profile)
    || peekExpectedAnswer('Veteran status', profile)
    || ''
  ).trim();
  if (!stored) return false;

  const clickText = veteranStatusKind(stored) === 'not_protected'
    ? 'I am not a protected veteran'
    : /not a veteran/i.test(stored)
      ? 'I am not a veteran'
      : stored;
  const labels = [
    'Please select the veteran status which most accurately describes how you identify yourself.',
    'Please select the veteran status which most accurately describes your status.',
    'Please indicate whether you are in one or more of the protected veteran categories.',
    'Please select your veteran status.',
    'Please select veterans status.',
    'Veteran status',
    'Veterans status',
  ];

  for (const label of labels) {
    const custom = await fillWorkdayCustomDropdown(page, { label, fieldType: 'dropdown' }, clickText);
    if (custom.success) {
      recordField(profile, label, custom.verifiedValue);
      console.log(`    ✅ Veteran status ← "${custom.verifiedValue}"`);
      return true;
    }
  }

  if (await clickVeteranRadioOrCheckbox(page, clickText)) {
    recordField(profile, 'Veteran status', clickText);
    console.log(`    ✅ Veteran status ← "${clickText}" (radio)`);
    return true;
  }

  if (await clickVeteranPromptOption(page, clickText)) {
    recordField(profile, 'Veteran status', clickText);
    console.log(`    ✅ Veteran status ← "${clickText}" (open list)`);
    return true;
  }

  const mark = await markDropdownByLabel(page, labels[0]);
  if (!mark?.found) {
    console.log(`    ⚠️  Veteran status dropdown not found (wanted "${clickText}")`);
    return false;
  }

  const widget = page.locator('[data-wd-eeo-target="1"]').first();
  await widget.scrollIntoViewIfNeeded().catch(() => {});
  const typed = await typeAndClickOption(page, widget, clickText);
  await waitForDomSettled(page, { timeout: 800 }).catch(() => {});
  const after = await page.evaluate(() => {
    const widget = document.querySelector('[data-wd-eeo-target="1"]');
    const selected = widget?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectedItem"]');
    return (selected?.textContent || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
  if (typed?.ok || (after && veteranStatusKind(after) === veteranStatusKind(clickText))) {
    recordField(profile, 'Veteran status', after || clickText);
    console.log(`    ✅ Veteran status ← "${after || clickText}"`);
    return true;
  }

  console.log(`    ⚠️  Veteran status could not be set (wanted "${clickText}")`);
  return false;
}

async function clickVeteranPromptOption(page, wanted) {
  const OPTION = '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"], [data-automation-id="menuItem"]';
  const exact = page.locator(OPTION).filter({ hasText: new RegExp(`^\\s*${String(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
  const count = await exact.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = exact.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => el.evaluate((n) => n.click()));
    return true;
  }
  return page.evaluate((text) => {
    const nodes = Array.from(document.querySelectorAll(
      '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"], [data-automation-id="menuItem"]',
    ));
    const hit = nodes.find((el) => {
      const t = (el.getAttribute('data-automation-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^i am not a veteran$/i.test(text)) {
        return /i am not a veteran/i.test(t) && !/protected/i.test(t);
      }
      return t.toLowerCase() === String(text).toLowerCase();
    });
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    hit.click();
    return true;
  }, wanted);
}

async function clickVeteranRadioOrCheckbox(page, wanted) {
  return page.evaluate((text) => {
    const nodes = Array.from(document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"]',
    ));
    const hit = nodes.find((el) => {
      const labelled = el.getAttribute('aria-label')
        || document.querySelector(`label[for="${el.id}"]`)?.textContent
        || el.closest('label')?.textContent
        || el.parentElement?.textContent
        || '';
      const t = labelled.replace(/\s+/g, ' ').trim();
      if (!/veteran/i.test(t)) return false;
      if (/^i am not a veteran$/i.test(text) || /not a veteran/i.test(text)) {
        return /i am not a veteran|not a veteran/i.test(t) && !/protected/i.test(t);
      }
      return t.toLowerCase().includes(String(text).toLowerCase());
    });
    if (!hit) return false;
    if (hit instanceof HTMLInputElement) {
      if (hit.checked) return true;
      hit.click();
      return hit.checked;
    }
    hit.click();
    return true;
  }, wanted).catch(() => false);
}

/**
 * Fill Race / Ethnicity dropdown on Voluntary Disclosures.
 * Short label "Race" was previously skipped by discovery (length < 8).
 * @param {import('playwright').Page} page
 * @param {string} [race]
 * @param {object} [profile]
 * @returns {Promise<boolean>}
 */
export async function fillRaceEthnicityDropdown(page, race = '', profile = null) {
  const wanted = String(
    race
    || profile?.eeo?.race
    || peekExpectedAnswer('Please select the ethnicity which most accurately describes how you identify yourself.', profile)
    || peekExpectedAnswer('Race', profile)
    || ''
  ).trim();
  if (!wanted) return false;

  const longLabels = [
    'Please select the ethnicity which most accurately describes how you identify yourself.',
    'Please select the race which most accurately describes how you identify yourself.',
    'Race',
    'Ethnicity',
  ];
  for (const label of longLabels) {
    const custom = await fillWorkdayCustomDropdown(page, { label, fieldType: 'dropdown' }, wanted);
    if (custom.success) {
      recordField(profile, label, custom.verifiedValue);
      await saveAnswerToYaml(label, custom.verifiedValue).catch(() => {});
      return true;
    }
  }

  const candidates = buildSelectOneOptionCandidates(wanted, 'Race');

  const already = await page.evaluate(() => {
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
    const label = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]'))
      .find((el) => /^(race|ethnicity|race\/ethnicity)$/i.test(normalize(el.textContent)));
    if (!label) return { found: false, value: '' };
    const field = label.closest('[data-automation-id*="formField"], fieldset, [role="group"]') || label.parentElement;
    const selected = field?.querySelector('[data-automation-id="selectedItem"]');
    const btn = field?.querySelector(
      '[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button'
    );
    let value = (selected?.textContent || btn?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^select(\s+one)?\.?$/i.test(value)) value = '';
    return { found: true, value };
  }).catch(() => ({ found: false, value: '' }));

  if (!already.found) {
    console.log('    ⚠️  Short Race/Ethnicity label not on this page — tried long-form custom dropdown first');
    return false;
  }
  if (already.value && /asian|white|black|hispanic|american indian|native|two or more|decline|prefer not/i.test(already.value)) {
    recordField(profile, 'Race', already.value);
    console.log(`    ✓ Race already "${already.value}" in DOM`);
    return true;
  }

  // Prefer dedicated selectOne fill by short label.
  const byLabel = await fillWorkdaySelectOneDropdown(page, 'Race', wanted);
  if (byLabel) {
    recordField(profile, 'Race', wanted);
    await saveAnswerToYaml('Race', wanted).catch(() => {});
    return true;
  }

  const raceField = page.locator('[data-automation-id*="formField"]').filter({
    hasText: /^Race\b|^Ethnicity\b|Race\/Ethnicity/i,
  }).first();
  const combo = raceField.locator(
    '[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button'
  ).first();

  if (await combo.isVisible({ timeout: 1500 }).catch(() => false)) {
    await combo.scrollIntoViewIfNeeded().catch(() => {});
    const result = await handleDropdown(page, combo, wanted, 'Race');
    if (result.success) {
      recordField(profile, 'Race', wanted);
      console.log(`    ✅ Race dropdown ← "${wanted}"`);
      return true;
    }
    await combo.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    const picked = await clickVisiblePromptOption(page, candidates);
    if (picked) {
      recordField(profile, 'Race', picked);
      console.log(`    ✅ Race dropdown ← "${picked}"`);
      await page.keyboard.press('Escape').catch(() => {});
      return true;
    }
    // Type "Asian" into searchable list then click matching option
    const typed = await typeAndClickOption(page, raceField, candidates.find((c) => /^asian$/i.test(c)) || 'Asian');
    if (typed.ok) {
      recordField(profile, 'Race', typed.matched || wanted);
      console.log(`    ✅ Race dropdown (typed) ← "${typed.matched || wanted}"`);
      return true;
    }
  }

  // Mark by exact short label and force-open
  const marked = await page.evaluate(() => {
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
    document.querySelectorAll('[data-auto-race-target]').forEach((el) => el.removeAttribute('data-auto-race-target'));
    const label = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]'))
      .find((el) => /^(race|ethnicity|race\/ethnicity)$/i.test(normalize(el.textContent)));
    if (!label) return false;
    const field = label.closest('[data-automation-id*="formField"], fieldset, [role="group"]') || label.parentElement;
    const control = field?.querySelector(
      '[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, [data-automation-id*="select"] button'
    );
    if (!control) return false;
    control.setAttribute('data-auto-race-target', 'true');
    return true;
  }).catch(() => false);

  if (marked) {
    const fallbackCombo = page.locator('[data-auto-race-target="true"]').first();
    try {
      await fallbackCombo.scrollIntoViewIfNeeded().catch(() => {});
      await fallbackCombo.click({ force: true }).catch(() => fallbackCombo.evaluate((el) => el.click()));
      await page.waitForTimeout(400);
      let picked = await clickVisiblePromptOption(page, candidates);
      if (!picked) {
        const typed = await typeAndClickOption(page, page.locator('body'), 'Asian');
        picked = typed.ok ? (typed.matched || 'Asian') : null;
      }
      await page.keyboard.press('Escape').catch(() => {});
      const after = await page.evaluate(() => {
        const normalize = (text) => (text || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
        const label = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"]'))
          .find((el) => /^(race|ethnicity)$/i.test(normalize(el.textContent)));
        const field = label?.closest('[data-automation-id*="formField"], fieldset, [role="group"]');
        const selected = field?.querySelector('[data-automation-id="selectedItem"]');
        const btn = field?.querySelector('[role="combobox"], button[aria-haspopup="listbox"]');
        return (selected?.textContent || btn?.textContent || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      if (picked || (after && !/^select(\s+one)?\.?$/i.test(after))) {
        const value = after && !/^select/i.test(after) ? after : (picked || wanted);
        recordField(profile, 'Race', value);
        console.log(`    ✅ Race dropdown ← "${value}"`);
        await saveAnswerToYaml('Race', value).catch(() => {});
        return true;
      }
    } finally {
      await page.evaluate(() => {
        document.querySelectorAll('[data-auto-race-target="true"]')
          .forEach((el) => el.removeAttribute('data-auto-race-target'));
      }).catch(() => {});
    }
  }

  console.log(`    ⚠️  Race dropdown could not be set (wanted "${wanted}")`);
  return false;
}

/**
 * Full Voluntary Disclosures step: gender dropdown + VIBE checkbox once, then DOM log.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ gender: boolean, vibe: boolean }>}
 */
/**
 * Fill Voluntary Disclosures / Terms and Conditions until no Select One remains.
 */
export async function ensureVoluntaryDisclosuresComplete(page, profile) {
  await handleVoluntaryDisclosuresStep(page, profile);
  const stillSelectOne = await page.evaluate((triggerSel) => {
    return Array.from(document.querySelectorAll(triggerSel)).some((btn) => {
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      return /^select(\s+one)?\.?$/i.test(t);
    });
  }, DROPDOWN_TRIGGER_IN_FIELD).catch(() => false);
  if (stillSelectOne) {
    await promptRemainingSelectOneDropdowns(page, profile, 'Voluntary Disclosures');
  }
  return true;
}

export async function handleVoluntaryDisclosuresStep(page, profile) {
  console.log('  📋 Voluntary Disclosures — reading DOM...');
  const before = await discoverVoluntaryDisclosureDom(page);
  console.log(`    DOM record: gender="${before.gender.currentValue || '(empty)'}" vibeChecked=${before.vibeAck.checked}`);

  // One efficient sweep: Race/ethnicity (long or short) → Hispanic → Veteran → Gender → remaining Select Ones
  await fillRaceEthnicityDropdown(page, profile?.eeo?.race || '', profile);
  const hispanic = peekExpectedAnswer('Are you Hispanic/Latino?', profile);
  if (hispanic) {
    await fillWorkdayCustomDropdown(page, {
      label: 'Are you Hispanic/Latino?',
      fieldType: 'dropdown',
    }, hispanic);
  }
  await fillVeteranStatusDropdown(page, profile?.eeo?.veteran_status || '', profile);
  const eeoDropdowns = await fillAllWorkdaySelectOneDropdowns(page, profile, 'Voluntary Disclosures');
  await fillGenderDropdown(page, profile?.eeo?.gender || '', profile);
  const veteranMark = await markDropdownByLabel(
    page,
    'Please select the veteran status which most accurately describes how you identify yourself.',
  ).catch(() => null);
  if (veteranMark?.found && (!veteranMark.current || /^select(\s+one)?\.?$/i.test(veteranMark.current))) {
    console.log('    ↻ Veteran status still Select One — retrying');
    await fillVeteranStatusDropdown(page, profile?.eeo?.veteran_status || '', profile);
  }
  const prompted = await promptRemainingSelectOneDropdowns(page, profile, 'Voluntary Disclosures');
  if (eeoDropdowns + prompted > 0) {
    console.log(`    📋 Voluntary Disclosures: ${eeoDropdowns + prompted} dropdown(s) filled`);
  }
  const terms = await acknowledgeTermsAndConditionsOnce(page, profile);
  const vibe = await acknowledgeVibePrivacyOnce(page, profile);
  const foregoing = await acknowledgeForegoingStatementOnce(page, profile);
  const agreements = await acknowledgeAllPageAgreements(page, profile, 'Voluntary Disclosures');

  const after = await discoverVoluntaryDisclosureDom(page);
  const genderOk = Boolean(after.gender?.currentValue && !/^select/i.test(after.gender.currentValue));
  console.log(`    DOM after fill: gender="${after.gender.currentValue || '(empty)'}" vibeChecked=${after.vibeAck.checked} terms=${terms} foregoingCert=${foregoing} agreements=${agreements}`);

  return { gender: genderOk, vibe, foregoing, terms, agreements };
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
/**
 * When the wizard is stuck, fill empty required fields with the nearest live option.
 * Personal name / phone / email stay on the profile.
 */
export async function fillEmptyRequiredWithNearestLlm(page, profile, stepName = '') {
  const questions = await discoverFormFieldQuestions(page).catch(() => []);
  const tenant = profile?._tenant || getWorkdayTenant(page.url());
  let filled = 0;

  for (const q of questions) {
    const questionLabel = extractQuestionLabel(q.label || '');
    if (!questionLabel) continue;
    if (q.required === false && shouldSkipOptionalFill(questionLabel, q, profile)) continue;
    if (isQuestionDomFilled(q, questionLabel, '', profile)) continue;

    let answer = null;
    if (isPersonalIdentityQuestion(questionLabel)) {
      answer = mapLabelToProfileValue(questionLabel, profile, { url: page.url(), tenant });
    } else {
      answer = peekExpectedAnswer(questionLabel, profile, tenant)
        || await resolveField({
          ...q,
          label: questionLabel,
          required: true,
        }, profile, createQAStore(), {
          skipPrompt: true,
          page,
          profile,
          company: profile?._company,
          url: page.url(),
          tenant,
          step: stepName,
        });
    }

    let options = (q.options || []).map((o) => (typeof o === 'string' ? o : o?.text)).filter(Boolean);
    if (!options.length && /dropdown|select|combobox|typeahead/i.test(String(q.fieldType || ''))) {
      options = await collectLiveFieldOptions(page, questionLabel, q.fieldType).catch(() => []);
    }
    if (options.length && isSalaryQuestion(questionLabel)) {
      answer = pickCompensationFromOptions(options, profile, answer || '') || answer;
    } else if (options.length) {
      answer = await pickNearestSelectOption({
        question: questionLabel,
        options,
        preferred: answer || '',
        profile,
        company: profile?._company,
      });
    } else if (!answer) {
      answer = await resolveUnknownWithLlm(questionLabel, q, { page, profile, company: profile?._company });
    }
    if (!answer) continue;

    let ok = await fillApplicationQuestionField(page, questionLabel, q.fieldType || 'dropdown', answer, profile, q);
    if (!ok && options.length) {
      const typed = await typeAndClickOption(page, null, answer);
      ok = typed.ok;
    }
    if (!ok) continue;

    filled++;
    recordField(profile, questionLabel, answer);
    await saveAnswerToYaml(questionLabel, answer).catch(() => {});
    if (tenant) {
      await saveAnswerToTenantYaml(tenant, {
        label: questionLabel,
        answer,
        fieldType: q.fieldType || 'dropdown',
        options,
        step: stepName,
      }).catch(() => {});
    }
    console.log(`    🤖 Unstick nearest: "${questionLabel.slice(0, 50)}" ← "${String(answer).slice(0, 40)}"`);
  }

  return filled;
}

export async function fillKnownWorkdayDropdowns(page, profile, stepName) {
  if (!/application questions/i.test(stepName)) return 0;
  return handleWorkdayFormFieldQuestions(page, profile, stepName);
}

/** @deprecated Use acknowledgeVibePrivacyOnce */
export async function checkVoluntaryDisclosureAcknowledgments(page, profile = null) {
  return acknowledgeVibePrivacyOnce(page, profile);
}
