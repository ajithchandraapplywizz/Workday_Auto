/**
 * engine.mjs — Core fill engine
 *
 * Fills application forms using a plan JSON. Handles every field type:
 * text, email, tel, file, checkbox, radio, dropdown, phone-country,
 * typeahead, yes-no-button, multi-select.
 *
 * Includes verification pass and submit retry loop.
 */

import { chromium } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { existsSync } from 'fs';
import {
  discoverApplicationForm,
  detectATS,
  getWorkdayTenant,
  detectWorkdayTenant,
  isWorkdayJobPageMissing,
  isWorkdayWizardVisible,
  ensureWorkdayApplicationWizard,
  extractWorkdayCompanyName,
  extractJobRoleFromDom,
} from './discovery.mjs';
import { findField, handleDropdown, handleHierarchicalDropdown, handleSearchableDropdown, clickVisiblePromptOption, verifyDropdownFilled, fuzzyScore } from './fields.mjs';
import { takeScreenshot, logToCSV } from './reporter.mjs';
import { isSubmitButton } from './scanner.mjs';
import { handleWorkday } from './workday.mjs';
import { loadProfile, mapLabelToProfileValue, resolveField, safeAskHuman, isFormAnswerTerminalEnabled } from './planner.mjs';
import { peekClientAnswer } from './clientAnswer.mjs';
import { getResumePathForApply, findExistingResumeFile } from './resumeParser.mjs';
import { cleanupClientResume } from './applyWizzResume.mjs';
import { fillWorkdaySkillsSection } from './workdaySkills.mjs';
import { normalizeLabel, createQAStore, isComplianceSensitive } from './qaStore.mjs';
import { isAutoApplyMode } from './openRouterLlm.mjs';
import { detectWorkdayStep } from './stateDetector.mjs';
import {
  getApplicationQuestionsPageInfo,
  countUnfilledMandatoryQuestions,
  acknowledgeAllPageAgreements,
} from './workdayQuestionFill.mjs';
import { runStepDomPrep } from './stepDomPrep.mjs';
import { rapidAdvanceOnce, RAPID, waitForWizardProgress } from './workdayRapidAdvance.mjs';
import { recordClientApplication, tryUsePreviousApplication } from './applicationHistory.mjs';
import {
  fillSourceFieldAuto,
  getReferralSourceDisplay,
  isReferralSourceFullySelected,
  SOURCE_LABEL,
} from './workdaySource.mjs';
import { handleStep2MyExperience, fillEducationFieldOfStudy } from './workdayExperience.mjs';
import { fillCityFromDom, getCityInputValue, cityValueMatches, CITY_LABEL, resolveCityValue } from './workdayCity.mjs';
import { fillStateFromDom, stateValueMatches, STATE_LABEL, resolveStateValue } from './workdayState.mjs';
import {
  harvestPageQuestions,
  summarizeQuestionsByStep,
  formatStepQuestionSummary,
} from './workdayScanHarvest.mjs';
import {
  isSkippableUnimportantLabel,
  isMandatoryField,
  shouldSkipOptionalFill,
  shouldIncludeInScan,
} from './scanFieldFilter.mjs';
import { toTitleCase } from './personName.mjs';
import {
  attachFormMutationObserver,
  detachFormMutationObserver,
  waitForDomSettled,
  discoverWorkdayFields,
  verifyRequiredFields,
  printUnresolvedFields,
  parseReviewDOM,
  crossCheckReview,
  parseCountryPhoneCode,
  filterTrulyEmptyRequired,
  locateWorkdayFieldByLabel,
  isFormFieldValueFilled,
} from './workdayDom.mjs';
import { runDynamicFieldLoop, resetPerApplicationSessionState } from './dynamicFieldEngine.mjs';
import { validatePage } from './interaction/index.mjs';
import { repairRequiredFieldsFromErrors, parseErrorFieldNames } from './workdayErrorRepair.mjs';
import { bootstrapClientContext } from './profileBootstrap.mjs';
import { resolvePostalForWorkday, workdayPhoneCodeForCountry } from './clientContact.mjs';
import { disarmRiskyAddButtons, installScriptOnlyClickGuard, drainBlockedScriptClicks } from './safeClick.mjs';
import { logFieldTrace, getTraceFilePath } from './trace.mjs';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { dispatchFillHandler, formatToMMDDYYYY } from './fillHandlers.mjs';
import { detectControlType } from './scanner.mjs';
import { validateResolvedValue } from './planner.mjs';
import { tokenSetRatio } from './fields.mjs';
import { writeFieldTraceLine, escalateToManualReview } from './reporter.mjs';

export const DEFAULT_MAX_FILL_ATTEMPTS = 2;

/**
 * Read the current on-screen value of a form field in the DOM.
 */
export async function readFieldState(page, field) {
  if (!page) return '';
  const controlType = field.controlType || detectControlType(field);

  try {
    return await page.evaluate(({ selector, automationId, wdQId, cType }) => {
      let root = null;
      if (wdQId) root = document.querySelector(`[data-wd-q-id="${wdQId}"]`);
      if (!root && automationId) root = document.querySelector(`[data-automation-id="${automationId}"]`);
      if (!root && selector) root = document.querySelector(selector);
      if (!root) return '';

      // Checkbox group
      if (cType === 'checkbox-group') {
        const cbs = Array.from(root.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
        const checkedLabels = cbs.filter(cb => cb.checked || cb.getAttribute('aria-checked') === 'true').map(cb => {
          const lbl = cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : cb.closest('label');
          return (lbl?.textContent || cb.getAttribute('aria-label') || cb.value || '').trim();
        }).filter(Boolean);
        return checkedLabels.join(', ');
      }

      // Radio group
      if (cType === 'radio-group') {
        const checked = root.querySelector('input[type="radio"]:checked, [role="radio"][aria-checked="true"]');
        if (checked) {
          const lbl = checked.id ? document.querySelector(`label[for="${CSS.escape(checked.id)}"]`) : checked.closest('label');
          return (lbl?.textContent || checked.getAttribute('aria-label') || checked.value || '').trim();
        }
        return '';
      }

      // Dropdown (native or custom)
      if (cType === 'native-select' || root.tagName?.toLowerCase() === 'select') {
        const sel = root.tagName?.toLowerCase() === 'select' ? root : root.querySelector('select');
        if (sel && sel.selectedOptions?.[0]) return (sel.selectedOptions[0].textContent || '').trim();
      }
      const selectedItem = root.querySelector('[data-automation-id="selectedItem"]');
      if (selectedItem?.textContent?.trim() && !/^select(\s+one)?\.?$/i.test(selectedItem.textContent.trim())) {
        return selectedItem.textContent.trim();
      }
      const btn = root.querySelector('button[aria-haspopup="listbox"], [data-automation-id*="select"] button, [role="combobox"]');
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t)) return t;
      }

      // Date spinbuttons
      const spinButtons = Array.from(root.querySelectorAll('input[role="spinbutton"], input[data-automation-id*="dateSection"]'));
      if (spinButtons.length >= 2) {
        const vals = spinButtons.map(s => (s.value || '').trim()).filter(v => v && !/^(mm|dd|yyyy)$/i.test(v));
        if (vals.length >= 2) return vals.join('/');
      }

      // Standard input or textarea
      const input = root.querySelector('input:not([type="hidden"]), textarea');
      if (input && input.value !== undefined) {
        return (input.value || '').trim();
      }

      return (root.value || root.innerText || root.textContent || '').trim();
    }, {
      selector: field.selector,
      automationId: field.automationId,
      wdQId: field.wdQId,
      cType: controlType,
    });
  } catch {
    return '';
  }
}

/**
 * 3d. Verify that a field actually changed to match the expected value.
 */
export async function verifyFieldFilled(page, field, expectedValue) {
  const actualValue = await readFieldState(page, field);
  const expectedStr = String(expectedValue || '').trim();
  const controlType = field.controlType || detectControlType(field);

  if (!actualValue) {
    return { verified: false, actualValue: '', expectedValue: expectedStr };
  }

  // Dropdown or radio comparison
  if (controlType === 'custom-dropdown' || controlType === 'native-select' || controlType === 'radio-group') {
    const score = tokenSetRatio(expectedStr, actualValue);
    return {
      verified: score >= 85 || actualValue.toLowerCase() === expectedStr.toLowerCase(),
      actualValue,
      expectedValue: expectedStr,
      score,
    };
  }

  // Checkbox group comparison
  if (controlType === 'checkbox-group') {
    const targets = (Array.isArray(expectedValue) ? expectedValue : expectedStr.split(/[,;\n]/))
      .map(t => String(t).trim().toLowerCase()).filter(Boolean);
    const actualLower = actualValue.toLowerCase();
    const verified = targets.some(t => actualLower.includes(t) || tokenSetRatio(t, actualValue) >= 80);
    return { verified, actualValue, expectedValue: expectedStr };
  }

  // Date comparison
  if (controlType === 'date-picker') {
    const formatted = formatToMMDDYYYY(expectedStr);
    const verified = actualValue === formatted || actualValue.replace(/^0+/, '') === formatted.replace(/^0+/, '');
    return { verified, actualValue, expectedValue: formatted };
  }

  // Free-text comparison
  const textScore = tokenSetRatio(expectedStr, actualValue);
  const verified = actualValue.toLowerCase().includes(expectedStr.toLowerCase()) || textScore >= 80;
  return { verified, actualValue, expectedValue: expectedStr, score: textScore };
}

/**
 * 3d. Post-Fill Verification + Capped Retry
 * Runs fill handler, verifies state, retries up to maxAttempts (default 2), then escalates.
 */
export async function executeFillWithVerification(page, field, resolvedValue, profile = {}, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_FILL_ATTEMPTS;
  const controlType = field.controlType || detectControlType(field);
  const candidateId = profile?.id || process.env.APPLYWIZZ_ID || 'default_candidate';
  const tenant = profile?._tenant || (page ? getWorkdayTenant(page.url?.() || '') : '');
  const step = options.step || profile?._currentStep || '';
  const tier = options.tier || 'tier1_supabase';

  let lastActualValue = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await dispatchFillHandler(page, field, resolvedValue, options);

    await page.waitForTimeout(options.settleMs ?? 80);

    const verification = await verifyFieldFilled(page, field, resolvedValue);
    lastActualValue = verification.actualValue;

    if (verification.verified) {
      recordFilled(profile, field.label, resolvedValue);

      await writeFieldTraceLine({
        automationId: field.automationId || field.id,
        label: field.label,
        controlType,
        tier,
        valueAttempted: resolvedValue,
        verified: true,
        step,
      });

      return {
        success: true,
        verified: true,
        attempts: attempt,
        actualValue: verification.actualValue,
      };
    }

    console.log(`    ⚠️  Attempt ${attempt}/${maxAttempts} unverified for "${(field.label || '').slice(0, 40)}" (actual="${verification.actualValue}")`);
  }

  // Cap reached — stop looping and escalate to manual review
  await escalateToManualReview({
    candidateId,
    tenant,
    automationId: field.automationId || field.id,
    questionLabel: field.label,
    controlType,
    visibleOptions: field.options || [],
    tierAttempted: tier,
    attemptedValue: resolvedValue,
    reason: `verification_failed_after_${maxAttempts}_attempts`,
    step,
  });

  return {
    success: false,
    verified: false,
    attempts: maxAttempts,
    actualValue: lastActualValue,
  };
}


function recordFilled(profile, label, value) {
  if (!profile) return;
  if (!profile._filledValues) profile._filledValues = {};
  if (label) profile._filledValues[label] = value;

  // Persist submitted answers for random/custom questions permanently to Supabase
  if (profile?._applyWizzId && label && value != null && String(value).trim()) {
    import('./supabaseClient.mjs').then((m) => {
      if (m.isSupabaseConfigured && m.isSupabaseConfigured()) {
        const normKey = m.normalizeQuestionKey ? m.normalizeQuestionKey(label) : String(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        m.upsertSupabaseAnswer({
          applywizzId: profile._applyWizzId,
          question: String(label).trim(),
          questionNormalized: normKey,
          answer: String(value).trim(),
          company: profile?._tenant || '',
          source: 'submitted_fill',
        }).catch(() => {});
      }
    }).catch(() => {});
  }
}

function clearStaleFilledValuesFromErrors(profile, errors = []) {
  if (!profile?._filledValues || !Array.isArray(errors) || errors.length === 0) return;
  const blob = errors.join(' ').toLowerCase();
  for (const key of Object.keys(profile._filledValues)) {
    const norm = normalizeLabel(key);
    if (!norm) continue;
    if (blob.includes(norm.slice(0, Math.min(norm.length, 40)))) {
      delete profile._filledValues[key];
    }
  }
}

function shouldPromptForUnknownField(label = '', field = {}, profile = {}) {
  return shouldIncludeInScan(String(label || '').trim(), field);
}

/**
 * Stable identity for the page the wizard is currently on.
 * Excludes timestamps so two scans of an unchanged page produce the same value.
 * @returns {Promise<string>}
 */
async function computeStepFingerprint(page, stepName) {
  const aq = stepName === 'Application Questions'
    ? await getApplicationQuestionsPageInfo(page).catch(() => null)
    : null;

  const domSignature = await page.evaluate(() => {
    const parts = [];
    document.querySelectorAll('[data-automation-id*="formField"], fieldset, [role="group"]').forEach((el) => {
      const label = (el.querySelector('label, legend')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (label) parts.push(label.slice(0, 60));
    });
    return parts.sort().join('|').slice(0, 3000);
  }).catch(() => '');

  let path = '';
  try {
    path = new URL(page.url()).pathname;
  } catch {
    path = page.url();
  }

  const aqPart = aq ? `aq:${aq.current}/${aq.total}` : 'aq:-';
  return `${path}::${stepName}::${aqPart}::${domSignature.length}::${domSignature}`;
}

async function locatePureDomDropdown(page, matchText) {
  const selector = await page.evaluate((needle) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(needle);
    const containers = Array.from(document.querySelectorAll('[data-automation-id*="formField"], fieldset, [role="group"], [data-automation-id*="question"], [data-automation-id*="source"], [data-automation-id*="phoneType"]'));

    for (const field of containers) {
      const text = normalize((field.textContent || '') + ' ' + (field.getAttribute('aria-label') || '') + ' ' + (field.getAttribute('name') || ''));
      if (!text.includes(target)) continue;
      const trigger = field.querySelector('button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button');
      if (trigger) {
        if (trigger.id) return `#${CSS.escape(trigger.id)}`;
        const automation = trigger.getAttribute('data-automation-id');
        if (automation) return `[data-automation-id="${CSS.escape(automation)}"]`;
        const parentId = field.id ? `#${CSS.escape(field.id)} ` : '';
        return `${parentId}${trigger.tagName.toLowerCase()}`;
      }
    }

    const globalTriggers = Array.from(document.querySelectorAll('button[aria-haspopup="listbox"], [role="combobox"], select'));
    for (const trigger of globalTriggers) {
      const text = normalize((trigger.textContent || '') + ' ' + (trigger.getAttribute('aria-label') || '') + ' ' + (trigger.getAttribute('name') || ''));
      if (text.includes(target)) {
        if (trigger.id) return `#${CSS.escape(trigger.id)}`;
        const automation = trigger.getAttribute('data-automation-id');
        if (automation) return `[data-automation-id="${CSS.escape(automation)}"]`;
        return trigger.tagName.toLowerCase();
      }
    }

    return '';
  }, matchText);

  return selector ? page.locator(selector).first() : null;
}

async function refreshWorkdayPageOnce(page) {
  const pageText = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text;
  }).catch(() => '');

  const transientError = /something went wrong|please refresh the page|error code:\s*i\|/i.test(pageText);
  if (!transientError) return false;

  console.log('    ⚠️  Workday transient page error detected. Refreshing once and continuing...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

function indiaSixDigitPostal(profile) {
  const raw = String(profile?.personal?.postal_code_6digit || profile?.personal?.postal_code || '').replace(/\D/g, '');
  if (raw.length >= 6) return raw.slice(0, 6);
  if (raw.length === 5) return `0${raw}`;
  if (raw.length > 0) return raw.padStart(6, '0');
  return '500001';
}

/**
 * Run a DOM-changing action, wait for Workday mutations to settle, then re-scan.
 * @param {import('playwright').Page} page
 * @param {Function} [actionFn]
 * @returns {Promise<object[]>}
 */
export async function interactAndRescan(page, actionFn) {
  if (typeof actionFn === 'function') {
    await actionFn();
  }
  await waitForDomSettled(page);
  return discoverWorkdayFields(page);
}

export { detectWorkdayStep };

// ─── Terminal Prompt Fallback for Unmapped Required Fields ─────────────────
export async function promptUserInTerminal(label, fieldType, options = [], { company, compliance, domCode, role, placeholder, page, profile } = {}) {
  const answer = await safeAskHuman(label || '(untitled field)', {
    type: fieldType,
    fieldType,
    role,
    placeholder,
    id: domCode,
    options: (options || []).map((o) => (typeof o === 'string' ? o : o?.text)).filter(Boolean),
  }, { company, compliance, page, profile });
  return answer || '';
}

// ─── Workday Resume Upload (direct setInputFiles — never open OS file picker) ─
async function findResumeFileInput(page) {
  const scoreInput = (el) => el.evaluate((node) => {
    let score = 0;
    let current = node;
    for (let depth = 0; depth < 16 && current; depth++, current = current.parentElement) {
      const text = (current.textContent || '').toLowerCase().replace(/\s+/g, ' ');
      const auto = (current.getAttribute?.('data-automation-id') || '').toLowerCase();
      const hasCoverLetter = /cover\s*letter|additional\s*attachment|supporting\s*document/i.test(text) || /coverletter|additionalattachment/i.test(auto);
      const hasResume = /resume\s*\/\s*cv|\bresume\b|\bcv\b/i.test(text) || /resume|\bcv\b/i.test(auto);

      if (hasCoverLetter && !hasResume) {
        return -100;
      }
      if (hasResume) score += 50;
      if (/upload a file|drop files here|select files|attachments?/i.test(text)) score += 10;
      if (/file-?upload|fileupload|attachment/i.test(auto)) score += 20;
    }
    const accept = (node.getAttribute('accept') || '').toLowerCase();
    if (/pdf|doc|\*/.test(accept) || !accept) score += 5;
    return score;
  }).catch(() => 0);

  const selectors = [
    '[data-automation-id*="file-upload"] input[type="file"]',
    '[data-automation-id*="fileUpload"] input[type="file"]',
    '[data-automation-id*="FileUpload"] input[type="file"]',
    '[data-automation-id*="attachment"] input[type="file"]',
    '[data-automation-id*="Attachments"] input[type="file"]',
    '[data-automation-id*="resume"] input[type="file"]',
    'input[type="file"][accept*="pdf"], input[type="file"][accept*=".pdf"]',
    'input[type="file"]',
  ];

  let best = null;
  let bestScore = -1;

  for (const sel of selectors) {
    const candidates = page.locator(sel);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const input = candidates.nth(i);
      const score = await scoreInput(input);
      if (score > bestScore) {
        bestScore = score;
        best = input;
      }
    }
    if (best && bestScore >= 40) return best;
  }

  if (best && bestScore >= 0) return best;
  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} [expectedFileName]
 * @returns {Promise<boolean>}
 */
async function waitForResumeUploadComplete(page, expectedFileName = '') {
  const expectBase = expectedFileName
    ? String(expectedFileName).replace(/\.[^.]+$/, '').slice(0, 24).toLowerCase()
    : '';
  console.log('    ⏳ Waiting for Workday file upload to complete...');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(700);
    const state = await page.evaluate((needle) => {
      const item = document.querySelector(
        '[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [data-automation-id*="uploadedFile"], [class*="file-upload-item"]'
      );
      const deleteBtn = document.querySelector('[data-automation-id="delete-file"]');
      const itemText = (item?.textContent || '').replace(/\s+/g, ' ').trim();
      const body = document.body?.innerText || '';
      const successBanner = /successfully\s*uploaded/i.test(body);
      const nameHit = needle
        ? itemText.toLowerCase().includes(needle) || (deleteBtn && body.toLowerCase().includes(needle))
        : /\.pdf\b/i.test(itemText);
      return {
        hasItem: Boolean(item && (item.offsetParent !== null || item.getClientRects().length > 0)),
        hasDelete: Boolean(deleteBtn),
        successBanner,
        nameHit,
        itemText: itemText.slice(0, 80),
      };
    }, expectBase).catch(() => ({ hasItem: false, hasDelete: false, successBanner: false, nameHit: false, itemText: '' }));

    if (state.hasItem || state.hasDelete || (state.successBanner && state.nameHit) || state.nameHit) {
      console.log(`    ✅ Resume uploaded successfully${state.itemText ? `: "${state.itemText}"` : ''}`);
      await waitForDomSettled(page);
      await discoverWorkdayFields(page);
      return true;
    }
  }
  console.log('    ⚠️  Resume upload not verified in DOM (no file chip / delete control)');
  return false;
}

/**
 * Upload resume PDF from resumes/ into Workday file input (no OS picker).
 * Re-resolves absolute path if the given path is stale/missing.
 */
async function handleWorkdayResumeUpload(page, resumePath, profile = null) {
  let absPath = findExistingResumeFile(resumePath)
    || (resumePath && existsSync(resumePath) ? resumePath : null);

  if (!absPath) {
    absPath = await getResumePathForApply(profile || {}, { resume: resumePath });
  }
  if (!absPath || !existsSync(absPath)) {
    console.log(`    ⚠️  Resume file not found (tried: ${resumePath || '(none)'}). Put a PDF in resumes/`);
    return false;
  }

  const fileName = basename(absPath);

  const already = await page.evaluate((needle) => {
    const item = document.querySelector(
      '[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [data-automation-id*="uploadedFile"], [class*="file-upload-item"]'
    );
    const deleteBtn = document.querySelector('[data-automation-id="delete-file"]');
    const text = ((item?.textContent || '') + ' ' + (document.body?.innerText || '')).toLowerCase();
    if (item && (item.offsetParent !== null || item.getClientRects().length > 0)) {
      if (!needle || text.includes(needle) || /\.pdf\b/i.test(item.textContent || '')) {
        return (item.textContent || '').replace(/\s+/g, ' ').trim() || 'uploaded file';
      }
    }
    if (deleteBtn && needle && text.includes(needle)) return needle;
    return '';
  }, fileName.replace(/\.[^.]+$/, '').slice(0, 24).toLowerCase()).catch(() => '');

  if (already) {
    console.log(`    📎 Resume already uploaded: "${already}"`);
    if (profile) profile._resumePath = absPath;
    return true;
  }

  const resumeUploadSectionMatches = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return /resume\s*\/\s*cv|\bresume\b|\bcv\b|upload a file|drop files here|select files|attachments?/i.test(text);
  });
  if (!resumeUploadSectionMatches) {
    console.log('    ℹ️  No resume upload section detected on this page');
    return false;
  }

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fileInput = await findResumeFileInput(page);
    if (!fileInput) {
      lastError = 'file input not found (will not open OS picker)';
      console.log(`    ⚠️  Resume upload attempt ${attempt}/3: ${lastError}`);
      await page.waitForTimeout(600);
      continue;
    }

    try {
      console.log(`    📎 Uploading resume: ${fileName} (attempt ${attempt}/3)...`);
      await fileInput.setInputFiles(absPath);
      const ok = await waitForResumeUploadComplete(page, fileName);
      if (ok) {
        if (profile) profile._resumePath = absPath;
        return true;
      }
      lastError = 'upload not confirmed in DOM';
    } catch (err) {
      lastError = err.message?.slice(0, 120) || String(err);
      console.log(`    ⚠️  Resume upload attempt ${attempt}/3 failed: ${lastError}`);
      await page.waitForTimeout(700);
    }
  }

  console.log(`    ⚠️  Resume section visible but upload did not complete (${lastError || 'unknown'})`);
  return false;
}

// ─── Step 1 ("My Information") Handler ───────────────────────────────────────
export async function handleStep1MyInformation(page, profile = {}, plan = {}) {
  console.log('\n  📋 [Step 1: My Information] Automating required form controls...');
  await attachFormMutationObserver(page);
  await discoverWorkdayFields(page);

  console.log('  🎯 [Field 1/4] Resolving "How Did You Hear About Us?" (yaml/mjs/URL — no terminal)...');
  try {
    const currentSourceText = await getReferralSourceDisplay(page);
    const contaminatedWithPhoneCode = /\+91|\(\+91\)|country\s*\/\s*territory\s*phone|phone\s*device/i.test(currentSourceText);

    if (contaminatedWithPhoneCode) {
      console.log('    ⚠️  Source field has phone/country text — clearing and re-selecting.');
      await page.keyboard.press('Escape').catch(() => {});
      const clearSource = page.locator('[data-automation-id="source--source"] [data-automation-id="delete-item"], #source--source [data-automation-id="delete-item"]').first();
      if (await clearSource.isVisible({ timeout: 800 }).catch(() => false)) {
        await clearSource.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    const isAlreadyFilled = !contaminatedWithPhoneCode && isReferralSourceFullySelected(currentSourceText);
    if (isAlreadyFilled) {
      console.log(`    ✓ "${SOURCE_LABEL}" already set: "${currentSourceText}"`);
      profile._step1SourceFilled = true;
      logFieldTrace({
        automationId: 'source--source',
        label: SOURCE_LABEL,
        controlType: 'combobox',
        tier: 'tier1_defaults',
        valueAttempted: currentSourceText,
        success: true,
        step: 'My Information',
      });
    } else {
      const sourceResult = await fillSourceFieldAuto(page, profile);
      const verifiedDisplay = await getReferralSourceDisplay(page);

      if (sourceResult.success && isReferralSourceFullySelected(verifiedDisplay)) {
        const selected = sourceResult.selected || verifiedDisplay;
        console.log(`    ✅ Field 1 Complete: "${SOURCE_LABEL}" → "${selected}" (DOM: "${verifiedDisplay}")`);
        profile._step1SourceFilled = true;
        profile.personal = profile.personal || {};
        profile.personal.source = selected;
        profile.qa_answers = profile.qa_answers || {};
        profile.qa_answers['how did you hear about us'] = selected;
        recordFilled(profile, SOURCE_LABEL, selected);
        logFieldTrace({
          automationId: 'source--source',
          label: SOURCE_LABEL,
          controlType: 'combobox',
          tier: 'tier1_defaults',
          valueAttempted: selected,
          success: true,
          step: 'My Information',
        });
      } else {
        console.log(`    ⚠️  Field 1: source not verified in DOM ("${verifiedDisplay || '(empty)'}") — continuing without terminal prompt`);
        logFieldTrace({
          automationId: 'source--source',
          label: SOURCE_LABEL,
          controlType: 'combobox',
          tier: 'tier1_defaults',
          valueAttempted: sourceResult.selected || '',
          success: false,
          reason: 'source_not_verified_in_dom',
          step: 'My Information',
        });
      }
    }
  } catch (err) {
    console.log(`    ⚠️  Field 1 warning: ${err.message?.substring(0, 100)}`);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  console.log('  🎯 [Field 2/4] Resolving Previous Worker radio group (default: "No")...');
  try {
    const previousWorkerGroup = page.getByRole('group', { name: /previously worked for or are you currently working for workday/i })
      .or(page.getByRole('radiogroup', { name: /previously worked for or are you currently working for workday/i }))
      .or(page.getByRole('group', { name: /prior employment.*contractor experience/i }))
      .or(page.getByRole('radiogroup', { name: /prior employment.*contractor experience/i }))
      .or(page.locator('fieldset').filter({ hasText: /previously worked.*workday|prior employment.*contractor experience|medtronic.*covidien/i }))
      .or(page.locator('[data-automation-id*="candidateIsPreviousWorker" i], [id*="candidateIsPreviousWorker" i]'))
      .first();

    let noRadio = null;
    if (await previousWorkerGroup.isVisible({ timeout: 1500 }).catch(() => false)) {
      noRadio = previousWorkerGroup.getByRole('radio', { name: /^no$/i })
        .or(previousWorkerGroup.locator('input[type="radio"][value="false"], input[type="radio"][value="No"], input[type="radio"][value="0"]'))
        .or(previousWorkerGroup.locator('label').filter({ hasText: /^no$/i }))
        .first();
    }
    if (!noRadio || !(await noRadio.count().catch(() => 0))) {
      noRadio = page.locator('input[name*="candidateIsPreviousWorker"][value="false"], input[name*="candidateIsPreviousWorker"][value="No"]')
        .or(page.getByRole('radio', { name: /^no$/i }))
        .first();
    }

    if (noRadio && await noRadio.count().catch(() => 0)) {
      const isAlreadyChecked = await noRadio.isChecked().catch(() => false);
      if (!isAlreadyChecked) {
        await interactAndRescan(page, async () => {
          await noRadio.scrollIntoViewIfNeeded().catch(() => {});
          await noRadio.check({ force: true }).catch(() => noRadio.click({ force: true }));
        });
      }
      const checkedNow = await noRadio.isChecked().catch(() => true);
      console.log('    ✅ Field 2 Complete: previous worker = "No"');
      recordFilled(profile, 'Previous Worker', 'No');
      logFieldTrace({
        automationId: 'candidateIsPreviousWorker',
        label: 'Previously worked for Workday',
        controlType: 'radio',
        tier: 'tier1_defaults',
        valueAttempted: 'No',
        success: checkedNow,
        step: 'My Information',
      });
    }
  } catch (err) {
    console.log(`    ⚠️  Field 2 warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 2b/4] Resolving Phone Device Type...');
  try {
    const phoneValue = profile?.qa_answers?.['phone device type'] || profile?.personal?.phone_device_type || 'Mobile';
    const phoneTypeBtn = await locateWorkdayFieldByLabel(page, 'phone\\s*device\\s*type')
      || page.locator('[data-automation-id*="phoneType"] button, #phoneNumber--phoneType, button[id*="phoneType"]')
      .first();
    if (await phoneTypeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      const btnText = (await phoneTypeBtn.textContent().catch(() => '')).trim();
      if (!btnText || btnText.includes('Select One') || btnText.includes('Select')) {
        await interactAndRescan(page, async () => {
          await phoneTypeBtn.click({ force: true }).catch(() => phoneTypeBtn.evaluate(el => el.click()));
        });
        const mobileOpt = page.getByRole('option', { name: new RegExp(`^${phoneValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
          .or(page.locator('[data-automation-id="promptOption"]:has-text("' + phoneValue + '")'))
          .or(page.getByText(phoneValue, { exact: true }))
          .first();
        await interactAndRescan(page, async () => {
          if (await mobileOpt.isVisible({ timeout: 1000 }).catch(() => false)) {
            await mobileOpt.click({ force: true }).catch(() => mobileOpt.evaluate(el => el.click()));
          } else {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
          }
        });
        recordFilled(profile, 'Phone Device Type', phoneValue);
        logFieldTrace({
          automationId: 'phoneNumber--phoneType',
          label: 'Phone Device Type',
          controlType: 'dropdown',
          tier: 'tier1_profile_fact',
          valueAttempted: phoneValue,
          success: true,
          step: 'My Information',
        });
      }
    }
  } catch {}

  // ─── Synchronize Country & Country Phone Code (Zero/Low Tokens) ───────────
  console.log('  🎯 [Field 2c/4] Checking Country at top (address / applicant)...');
  let selectedCountry = '';
  try {
    const countryControl = await locateWorkdayFieldByLabel(page, '^country$')
      || page.locator('#address--country, [data-automation-id="address--country"], [data-automation-id="addressSection_country"]')
          .locator('button, [role="combobox"], input').first();

    if (countryControl && await countryControl.isVisible({ timeout: 1200 }).catch(() => false)) {
      const liveText = ((await countryControl.innerText().catch(() => '')) ||
        (await countryControl.inputValue().catch(() => '')) ||
        (await countryControl.textContent().catch(() => '')) || '').trim();
      if (liveText && !/select\s*one|select/i.test(liveText)) {
        selectedCountry = liveText;
        console.log(`    ✓ Country already selected at top: "${selectedCountry}"`);
      }
    }

    selectedCountry = 'United States of America';
    profile.personal = profile.personal || {};
    profile.personal.country = selectedCountry;
    profile.personal.country_phone_code = 'United States of America (+1)';

    // If Country at top exists and is not yet set to selectedCountry, set it now
    if (countryControl && await countryControl.isVisible({ timeout: 800 }).catch(() => false)) {
      const cur = ((await countryControl.innerText().catch(() => '')) || (await countryControl.inputValue().catch(() => '')) || '').trim();
      const want = selectedCountry.toLowerCase();
      if (!cur || !cur.toLowerCase().includes('united states')) {
        await interactAndRescan(page, async () => {
          await countryControl.click({ force: true }).catch(() => countryControl.evaluate((el) => el.click()));
        });
        await handleSearchableDropdown(page, countryControl, 'united states', selectedCountry, { confirmWithEnter: true, alreadyOpen: true });
        recordFilled(profile, 'Country', selectedCountry);
        console.log(`    ✅ Country at top set from profile: "${selectedCountry}"`);
      }
    }
  } catch (err) {
    console.log(`    ⚠️  Country at top check warning: ${err.message?.substring(0, 80)}`);
  }

  console.log('  🎯 [Field 3/4] Resolving Country / Territory Phone Code (default: United States of America (+1))...');
  try {
    const expectedPhoneCode = 'United States of America (+1)';
    const query = 'united states';

    const countryPhoneCodeControl = await locateWorkdayFieldByLabel(page, 'country\\s*(\\/\\s*territory\\s*)?phone\\s*code')
      || page.locator('[data-automation-id="country-phone-code"]')
        .locator('[role="combobox"], input, button[aria-haspopup="listbox"]')
        .first()
      || page.locator('#phoneNumber--countryPhoneCode, [id*="countryPhoneCode"]')
        .first();

    const isCountryVisible = await countryPhoneCodeControl.isVisible({ timeout: 2000 }).catch(() => false);
    if (isCountryVisible) {
      const currentCode = ((await countryPhoneCodeControl.inputValue().catch(() => '')) ||
        (await countryPhoneCodeControl.innerText().catch(() => '')) ||
        (await countryPhoneCodeControl.textContent().catch(() => '')) || '').trim();

      const usHint = /united states|\+1/i.test(selectedCountry || '') || /united states|\+1/i.test(expectedPhoneCode || '');
      const inHint = /india|\+91/i.test(selectedCountry || '') || /india|\+91/i.test(expectedPhoneCode || '');
      let alreadySelected = false;
      if (inHint) alreadySelected = /india|\+91/i.test(currentCode);
      else if (usHint) alreadySelected = /united states|\+1/i.test(currentCode);
      else alreadySelected = currentCode && !/select\s*one|select/i.test(currentCode) && (
        currentCode.toLowerCase().includes(query.toLowerCase()) ||
        currentCode.toLowerCase().includes(selectedCountry.toLowerCase())
      );

      if (alreadySelected) {
        console.log(`    ✓ Country Phone Code already set and matches top country: "${currentCode}"`);
        recordFilled(profile, 'Country / Territory Phone Code', currentCode);
        logFieldTrace({
          automationId: 'country-phone-code',
          label: 'Country / Territory Phone Code',
          controlType: 'combobox',
          tier: 'tier1_profile_fact',
          valueAttempted: currentCode,
          success: true,
          step: 'My Information',
        });
      } else {
        // Only clear if previous selection was genuinely incorrect
        const clearBtn = page.locator('[data-automation-id="country-phone-code"] [data-automation-id="delete-item"], #phoneNumber--countryPhoneCode [data-automation-id="delete-item"], [data-automation-id="country-phone-code"] [data-automation-id="clear-button"]').first();
        if (await clearBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await interactAndRescan(page, async () => {
            await clearBtn.click({ force: true });
          });
          await page.waitForTimeout(150);
        }

        await interactAndRescan(page, async () => {
          await countryPhoneCodeControl.scrollIntoViewIfNeeded().catch(() => {});
          await countryPhoneCodeControl.click({ force: true }).catch(() => countryPhoneCodeControl.evaluate(el => el.click()));
        });

        // Search with robust dropdown handler that firmly focuses search box before typing
        const optionText = expectedPhoneCode;
        const result = await handleSearchableDropdown(page, countryPhoneCodeControl, query, optionText, { confirmWithEnter: true, alreadyOpen: true });
        if (!result.success) {
          const candidates = usHint ? [
            'United States of America (+1)',
            'United States (+1)',
            'United States of America',
            optionText,
            query,
          ] : inHint ? [
            'India (+91)',
            'India',
            optionText,
            query,
          ] : [
            optionText,
            expectedPhoneCode,
            selectedCountry,
            query,
          ];

          const clicked = await clickVisiblePromptOption(page, candidates);
          if (clicked) {
            await page.keyboard.press('Enter').catch(() => {});
            console.log(`    ✓ Country option via DOM text: "${clicked}"`);
          } else {
            // Direct input check with proper focus and clearing
            const searchInput = page.locator('input[data-automation-id="searchBox"], input[role="searchbox"], [data-automation-id*="search" i], [data-uxi-element-id*="searchBox" i]').filter({ has: page.locator(':visible') }).first();
            if (await searchInput.isVisible({ timeout: 600 }).catch(() => false)) {
              await searchInput.click().catch(() => {});
              await page.waitForTimeout(80);
              await searchInput.fill('');
              await page.waitForTimeout(50);
              await searchInput.pressSequentially(query, { delay: 40 });
            } else {
              await page.waitForTimeout(300);
              await page.keyboard.type(query, { delay: 50 });
            }
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
          }
        }

        await waitForDomSettled(page);
        const verified = ((await countryPhoneCodeControl.innerText().catch(() => '')) ||
          (await countryPhoneCodeControl.textContent().catch(() => '')) ||
          (await countryPhoneCodeControl.inputValue().catch(() => '')) || '').trim();
        console.log(`    ✅ Field 3 Complete: searched "${query}" → "${verified || optionText}"`);
        recordFilled(profile, 'Country / Territory Phone Code', verified || optionText);
        logFieldTrace({
          automationId: 'country-phone-code',
          label: 'Country / Territory Phone Code',
          controlType: 'combobox',
          tier: 'tier1_profile_fact',
          valueAttempted: optionText,
          success: Boolean(verified),
          step: 'My Information',
        });
        await discoverWorkdayFields(page);
      }
    }
  } catch (err) {
    console.log(`    ⚠️  Field 3 warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 4/4] Resolving Phone Number...');
  try {
    const { normalizePhoneForCountry } = await import('./clientContact.mjs');
    const phoneHint = `${profile?.personal?.country || ''} ${profile?.personal?.country_phone_code || ''}`;
    const phoneValue = normalizePhoneForCountry(profile?.personal?.phone || profile?.phone || '', phoneHint);
    if (!phoneValue) {
      throw new Error('profile.personal.phone is required');
    }
    profile.personal = profile.personal || {};
    profile.personal.phone = phoneValue;

    const phoneNumberInput = page.locator('input[data-automation-id="phone-number"], input#phoneNumber--phoneNumber, input[id*="phoneNumber--phoneNumber"], input[name="phoneNumber"], input[type="tel"]')
      .or(page.getByRole('textbox', { name: /^phone number/i }))
      .or(page.getByLabel('Phone Number', { exact: true }))
      .first();

    if (await phoneNumberInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await interactAndRescan(page, async () => {
        await phoneNumberInput.scrollIntoViewIfNeeded().catch(() => {});
        await phoneNumberInput.fill(phoneValue);
      });
      const verified = await phoneNumberInput.inputValue().catch(() => '');
      const phoneOk = String(verified).replace(/\D/g, '') === String(phoneValue).replace(/\D/g, '');
      if (!phoneOk) {
        console.log(`    ⚠️  Phone verify mismatch: expected ${phoneValue}, got ${verified}`);
      } else {
        console.log(`    ✅ Field 4 Complete: Phone Number "${phoneValue}"`);
      }
      recordFilled(profile, 'Phone Number', String(phoneValue).trim());
      logFieldTrace({
        automationId: 'phone-number',
        label: 'Phone Number',
        controlType: 'text',
        tier: 'tier1_profile_fact',
        valueAttempted: phoneValue,
        success: phoneOk,
        step: 'My Information',
      });
    }
  } catch (err) {
    console.log(`    ⚠️  Field 4 warning: ${err.message?.substring(0, 100)}`);
  }

  try {
    const postalInput = page.locator('input[data-automation-id*="postalCode"], input#address--postalCode, input[id*="postalCode"]')
      .or(page.getByLabel('Postal Code', { exact: false }))
      .first();
    if (await postalInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const pin = resolvePostalForWorkday(profile, indiaSixDigitPostal);
      await interactAndRescan(page, async () => { await postalInput.fill(pin); });
      recordFilled(profile, 'Postal Code', pin);
      console.log(`    📮 Postal Code set to "${pin}"`);
      logFieldTrace({
        automationId: 'addressSection_postalCode',
        label: 'Postal Code',
        controlType: 'text',
        tier: 'tier1_profile_fact',
        valueAttempted: pin,
        success: true,
        step: 'My Information',
      });
    }
  } catch {}

  console.log('  🎯 [Field 5] Resolving City (mandatory — DOM verify)...');
  try {
    let citySuccess = false;
    const cityResult = await fillCityFromDom(page, profile);
    if (cityResult.success && cityValueMatches(cityResult.domValue, cityResult.value)) {
      recordFilled(profile, CITY_LABEL, cityResult.value);
      citySuccess = true;
    }

    logFieldTrace({
      automationId: 'addressSection_city',
      label: CITY_LABEL,
      controlType: 'combobox',
      tier: 'tier1_profile_fact',
      valueAttempted: resolveCityValue(profile),
      success: citySuccess,
      step: 'My Information',
    });

    if (!citySuccess) {
      console.log(`    ⚠️  City is required but could not be verified in DOM (wanted "${resolveCityValue(profile)}")`);
    }
  } catch (err) {
    console.log(`    ⚠️  City field warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 5b] Resolving Address Line 1 (mandatory)...');
  try {
    const { mergeResumeContactIntoProfile } = await import('./clientContact.mjs');
    mergeResumeContactIntoProfile(profile);
    const addressValue = profile?.personal?.address_line1
      || profile?.qa_answers?.['address line 1']
      || '';
    if (!addressValue) {
      console.log('    ⚠️  Address Line 1 has no Apply Wizz / profile value — leaving empty');
    }
    const addressInput = page.locator('input[data-automation-id*="addressLine1"], input#address--addressLine1, input[id*="addressLine1"]')
      .or(page.getByLabel('Address Line 1', { exact: false }))
      .first();
    if (addressValue && await addressInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      const current = (await addressInput.inputValue().catch(() => '') || '').trim();
      if (!current || current !== addressValue) {
        await interactAndRescan(page, async () => {
          await addressInput.scrollIntoViewIfNeeded().catch(() => {});
          await addressInput.fill(addressValue);
        });
      }
      const verified = (await addressInput.inputValue().catch(() => '') || '').trim();
      const addrOk = (verified === addressValue);
      if (addrOk) {
        console.log(`    ✅ Address Line 1 DOM verified: "${verified}"`);
        profile.personal = profile.personal || {};
        profile.personal.address_line1 = addressValue;
        profile.qa_answers = profile.qa_answers || {};
        profile.qa_answers['address line 1'] = addressValue;
        recordFilled(profile, 'Address Line 1', addressValue);
      } else {
        console.log(`    ⚠️  Address Line 1 verify mismatch: wanted "${addressValue}", got "${verified}"`);
      }
      logFieldTrace({
        automationId: 'addressSection_addressLine1',
        label: 'Address Line 1',
        controlType: 'text',
        tier: 'tier1_profile_fact',
        valueAttempted: addressValue,
        success: addrOk,
        step: 'My Information',
      });
    }
  } catch (err) {
    console.log(`    ⚠️  Address Line 1 warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 5a] Resolving Country (address — from Apply Wizz / resume)...');
  try {
    const countryValue = String(profile?.personal?.country || 'United States of America').trim() || 'United States of America';
    if (countryValue) {
      const countryControl = await locateWorkdayFieldByLabel(page, '^country$')
        || page.locator('#address--country, [data-automation-id="address--country"]').locator('button, [role="combobox"], input').first();
      if (countryControl && await countryControl.isVisible({ timeout: 1500 }).catch(() => false)) {
        const current = ((await countryControl.innerText().catch(() => '')) || (await countryControl.inputValue().catch(() => '')) || '').trim();
        const want = countryValue.toLowerCase();
        if (!current || !current.toLowerCase().includes('united states')) {
          await interactAndRescan(page, async () => {
            await countryControl.click({ force: true }).catch(() => countryControl.evaluate((el) => el.click()));
          });
          await handleSearchableDropdown(page, countryControl, 'united states', countryValue, { confirmWithEnter: true, alreadyOpen: true });
        }
        recordFilled(profile, 'Country', countryValue);
        console.log(`    ✅ Country set from client profile: "${countryValue}"`);
        logFieldTrace({
          automationId: 'addressSection_country',
          label: 'Country',
          controlType: 'combobox',
          tier: 'tier1_profile_fact',
          valueAttempted: countryValue,
          success: true,
          step: 'My Information',
        });
      }
    }
  } catch (err) {
    console.log(`    ⚠️  Country field warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 5c] Resolving State dropdown (mandatory — DOM verify)...');
  try {
    const stateValue = resolveStateValue(profile, profile?._tenant || getWorkdayTenant(page.url()));
    if (stateValue) {
      const stateResult = await fillStateFromDom(page, profile);
      const stateOk = stateResult.success && stateValueMatches(stateResult.domValue, stateValue);
      if (stateOk) {
        console.log(`    ✅ State DOM verified: "${stateResult.domValue}"`);
        profile.personal = profile.personal || {};
        profile.personal.state = stateValue;
        profile.qa_answers = profile.qa_answers || {};
        profile.qa_answers.state = stateValue;
        recordFilled(profile, STATE_LABEL, stateValue);
      } else {
        console.log(`    ⚠️  State not verified in DOM (wanted "${stateValue}", got "${stateResult.domValue || '(empty)'}")`);
      }
      logFieldTrace({
        automationId: 'addressSection_countryRegion',
        label: STATE_LABEL,
        controlType: 'dropdown',
        tier: 'tier1_profile_fact',
        valueAttempted: stateValue,
        success: stateOk,
        step: 'My Information',
      });
    }
  } catch (err) {
    console.log(`    ⚠️  State field warning: ${err.message?.substring(0, 100)}`);
  }

  try {
    const textFields = [
      {
        match: /^(legal\s*name\s*[-–—:]\s*)?(first|given)\s*name/i,
        label: 'First Name',
        autoId: 'legalNameSection_firstName',
        selector: 'input[data-automation-id*="firstName" i], input#legalNameSection_firstName, input[name*="firstName" i]',
        keys: ['personal.first_name', 'first_name'],
      },
      {
        match: /^(legal\s*name\s*[-–—:]\s*)?(middle)\s*name/i,
        label: 'Middle Name',
        autoId: 'legalNameSection_middleName',
        selector: 'input[data-automation-id*="middleName" i], input#legalNameSection_middleName, input[name*="middleName" i]',
        keys: ['personal.middle_name', 'middle_name'],
      },
      {
        match: /^(legal\s*name\s*[-–—:]\s*)?(last|family|surname)\s*name/i,
        label: 'Last Name',
        autoId: 'legalNameSection_lastName',
        selector: 'input[data-automation-id*="lastName" i], input#legalNameSection_lastName, input[name*="lastName" i]',
        keys: ['personal.last_name', 'last_name'],
      },
    ];
    for (const tf of textFields) {
      let inputEl = page.locator(tf.selector).first();
      if (!await inputEl.isVisible({ timeout: 500 }).catch(() => false)) {
        inputEl = page.getByLabel(tf.match).first();
      }
      if (await inputEl.isVisible({ timeout: 500 }).catch(() => false)) {
        const val = await inputEl.inputValue().catch(() => '');
        let fillVal = '';
        for (const k of tf.keys) {
          const v = k.includes('.') ? k.split('.').reduce((o, i) => o?.[i], profile) : profile?.[k];
          if (v) { fillVal = String(v); break; }
        }
        if (fillVal) {
          fillVal = toTitleCase(fillVal);
          if (!val || val.trim() !== fillVal) {
            await interactAndRescan(page, async () => {
              await inputEl.scrollIntoViewIfNeeded().catch(() => {});
              await inputEl.fill(fillVal).catch(() => {});
            });
            recordFilled(profile, tf.label, fillVal);
            const verified = await inputEl.inputValue().catch(() => '');
            logFieldTrace({
              automationId: tf.autoId,
              label: tf.label,
              controlType: 'text',
              tier: 'tier1_profile_fact',
              valueAttempted: fillVal,
              success: verified.trim() === fillVal,
              step: 'My Information',
            });
          }
        }
      }
    }
  } catch {}


  try {
    const postalInput = page.locator('input[data-automation-id*="postalCode"], input#address--postalCode, input[id*="postalCode"]')
      .or(page.getByLabel('Postal Code', { exact: false }))
      .first();
    if (await postalInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const pin = resolvePostalForWorkday(profile, indiaSixDigitPostal);
      await interactAndRescan(page, async () => { await postalInput.fill(pin); });
      recordFilled(profile, 'Postal Code', pin);
      console.log(`    📮 Postal Code set to "${pin}"`);
    }
  } catch {}

  console.log('  ℹ️  Step 1 important fields done — clicking Save and Continue next.');
  return true;
}


async function fieldOptions(field) {
  if (!field.options) return [];
  return field.options.map(o => (typeof o === 'string' ? o : (o.text || o.value || ''))).filter(Boolean);
}

/**
 * Fill a single discovered Workday field using DOM locators (not vision).
 */
async function fillWorkdayField(page, field, mappedVal, profile) {
  const label = field.label || field.id;
  let el = await findField(page, field);
  if (!el) return false;
  const isVisible = await el.isVisible().catch(() => false);
  if (!isVisible) return false;

  const meta = await el.evaluate(node => ({
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute('role') || '',
    type: node.getAttribute('type') || '',
    hasPopup: Boolean(node.getAttribute('aria-haspopup')),
  })).catch(() => ({ tag: '', role: '', type: '', hasPopup: false }));

  if (meta.tag === 'label') return false;

  const currentVal = await el.inputValue().catch(() => '');
  if (currentVal && currentVal.trim() !== '' && currentVal !== 'Select...' && currentVal !== 'Select' && field.type !== 'checkbox' && field.type !== 'radio') {
    return false;
  }

  await el.scrollIntoViewIfNeeded().catch(() => {});

  const isCombo = field.type === 'select' || field.type === 'custom-select' || field.automationId === 'select-widget' || field.role === 'combobox' || meta.role === 'combobox' || meta.hasPopup || meta.tag === 'button';
  const canFill = ['input', 'textarea', 'select'].includes(meta.tag) && meta.type !== 'button';

  if (field.type === 'checkbox') {
    const shouldCheck = mappedVal === true || mappedVal === 'true' || mappedVal === 'yes' || mappedVal === 'y' || mappedVal === '_static.true' || mappedVal === '1' || mappedVal === 'on';
    if (shouldCheck) {
      const isChecked = await el.isChecked().catch(() => false);
      if (!isChecked) {
        await el.click({ force: true }).catch(() => el.evaluate(e => e.click()));
        console.log(`    ☑️  Checked: ${label}`);
        recordFilled(profile, label, mappedVal);
        return true;
      }
    }
    return false;
  }

  if (field.type === 'radio') {
    let radioVal = String(mappedVal || '').trim();
    if (!/^(yes|no|true|false)$/i.test(radioVal)) {
      const fromClient = peekClientAnswer(label, profile);
      if (fromClient && /^(yes|no)$/i.test(String(fromClient).trim())) {
        radioVal = fromClient;
      } else {
        return false;
      }
    }
    if (/^(true|false)$/i.test(radioVal)) radioVal = /^true$/i.test(radioVal) ? 'Yes' : 'No';
    try {
      if (field.name) {
        await page.click(`input[name="${field.name}"][value="${radioVal}"]`, { force: true }).catch(() => {});
        await page.click(`input[name="${field.name}"][value="${/^no$/i.test(radioVal) ? 'false' : 'true'}"]`, { force: true }).catch(() => {});
      } else {
        await page.getByRole('radio', { name: new RegExp(`^${radioVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first().click({ force: true });
      }
    } catch {
      await page.click(`label:has-text("${radioVal}")`, { force: true }).catch(() => {});
    }
    console.log(`    ✅ Radio: ${label} ← "${radioVal}"`);
    recordFilled(profile, label, radioVal);
    return true;
  }

  if (isCombo || field.type === 'select' || field.type === 'custom-select' || field.automationId === 'select-widget' || field.role === 'combobox') {
    const result = await handleDropdown(page, el, mappedVal, label);
    if (result.success) {
      console.log(`    ✅ Dropdown [${result.method}]: ${label} ← "${mappedVal}"`);
      recordFilled(profile, label, mappedVal);
      return true;
    }
  }

  const isReadonly = await el.evaluate(e => e.readOnly || e.getAttribute('aria-haspopup') || e.getAttribute('role') === 'combobox').catch(() => false);
  const labelLower = String(label).toLowerCase();
  const isPhoneOrCountryField = /phone\s*device|country.*phone|phone\s*code|territory\s*phone/i.test(labelLower);
  const couldBeDropdown = !isPhoneOrCountryField && (isReadonly || isCombo || ['gender', 'veteran', 'disability', 'race', 'how did you hear'].some(k => labelLower.includes(k))
    || (/^country$/i.test(labelLower) && !/phone/i.test(labelLower)));
  if (couldBeDropdown) {
    const result = await handleDropdown(page, el, mappedVal, label);
    if (result.success) {
      console.log(`    ✅ Dropdown: ${label} ← "${mappedVal}"`);
      recordFilled(profile, label, mappedVal);
      return true;
    }
    if (!canFill) return false;
  }

  if (!canFill) {
    console.log(`    ⚠️  Skip fill — "${label}" is not an input (Workday label/for mismatch).`);
    return false;
  }

  await el.click().catch(() => {});
  await el.fill(String(mappedVal));
  const display = String(mappedVal).length > 50 ? String(mappedVal).substring(0, 50) + '...' : mappedVal;
  console.log(`    ✅ Filled: ${label} ← "${display}"`);
  recordFilled(profile, label, mappedVal);
  return true;
}

/**
 * Scan DOM/a11y fields, resolve answers from profile/qa_answers, prompt unknowns, fill, re-scan.
 * Re-discovers from live DOM after every successful fill so newly revealed controls are seen.
 */
async function fillWorkdayFieldsFromScan(page, profile, plan, stepName) {
  const qaStore = createQAStore();
  let fields = await discoverWorkdayFields(page);
  console.log(`  🔍 DOM scan: ${fields.length} visible field(s) on "${stepName}"`);
  let stepFilled = 0;
  const company = profile?._company || profile?.company;
  const seenNorms = new Set();
  const maxIters = Math.max(fields.length * 2, 24);

  for (let i = 0; i < maxIters; i++) {
    if (i > 0 && i % 3 === 0) {
      fields = await discoverWorkdayFields(page);
    }
    const field = fields.find((f) => {
      if (f.disabled || f.type === 'file') return false;
      const label = f.label || f.id;
      const norm = normalizeLabel(label);
      if (!norm || seenNorms.has(norm)) return false;
      const mandatory = isMandatoryField(label, f) || f.required === true;
      if (!mandatory) {
        if (isSkippableUnimportantLabel(label, f)) return false;
        if (shouldSkipOptionalFill(label, f, profile)) return false;
        if (/how did you hear|previous(ly)? work|prior employment|contractor experience with|covidien|country.*phone code|phone number|postal code|city|given name|family name|address line/i.test(String(label)) && stepName === 'My Information') return false;
      }
      if (/vibe philosophy|recruitment privacy statement.*vibe/i.test(String(label))) return false;
      return true;
    });
    if (!field) break;

    const label = field.label || field.id;
    const norm = normalizeLabel(label);
    seenNorms.add(norm);

    const sessionHit = profile._filledValues && Object.keys(profile._filledValues).some((k) => {
      const kn = normalizeLabel(k);
      return kn === norm || norm.includes(kn) || kn.includes(norm);
    });
    const liveValue = field.currentValue ?? field.value ?? '';
    if (sessionHit && isFormFieldValueFilled(liveValue, label)) continue;
    if (sessionHit && !isFormFieldValueFilled(liveValue, label) && profile._filledValues) {
      for (const key of Object.keys(profile._filledValues)) {
        const kn = normalizeLabel(key);
        if (kn === norm || norm.includes(kn) || kn.includes(norm)) delete profile._filledValues[key];
      }
    }

    let mappedVal = await resolveField(field, profile, qaStore, {
      skipPrompt: true,
      plan,
      company,
      resumePath: plan?.resume || profile?._resumePath,
      url: plan?.url || page.url(),
      page,
    });
    if (/postal/i.test(String(label)) && mappedVal) {
      const countryHint = `${profile?.personal?.country_phone_code || ''} ${profile?.personal?.country || ''}`;
      if (/india|\+91/i.test(countryHint)) {
        mappedVal = indiaSixDigitPostal(profile);
      } else if (/united states|\+1/i.test(countryHint)) {
        mappedVal = resolvePostalForWorkday(profile, indiaSixDigitPostal);
      }
    }

    if (!mappedVal) continue;

    try {
      const filled = await fillWorkdayField(page, field, mappedVal, profile);
      if (filled) {
        stepFilled++;
        if (isComplianceSensitive(label)) {
          recordFilled(profile, label, mappedVal);
        }
        fields = await interactAndRescan(page);
      }
    } catch (err) {
      console.log(`    ⚠️  Could not fill ${label}: ${err.message?.substring(0, 60)}`);
    }
  }

  console.log(`  ✓ Completed fill pass for ${stepName}: ${stepFilled} action(s) performed.`);
  return stepFilled;
}

/**
 * Central page workflow: scan → intent → evidence → validate → fill → verify → rescan.
 */
async function runWorkdayQuestionWorkflow(page, profile, plan, stepName, options = {}) {
  console.log(`  🔄 Page workflow: "${stepName}" (orchestrator — all required questions)`);
  const dynamicResult = await runDynamicFieldLoop(page, profile, plan, stepName, {
    maxPasses: options.maxPasses ?? 7,
    maxOuterPasses: options.maxOuterPasses ?? 2,
  });
  if (dynamicResult.humanRequired?.length) {
    profile._stepBlocked = profile._stepBlocked || {};
    profile._stepBlocked[stepName] = dynamicResult.humanRequired;
  }
  return dynamicResult;
}

// ─── Fill Current Workday Step ──────────────────────────────────────────────
async function fillCurrentWorkdayStep(page, stepName, profile, plan) {
  console.log(`\n  📝 [Workday] Filling Step: "${stepName}" (script-only: required fields)...`);

  // Disarm Certifications / Languages / bare Add / chrome before any fill on this step.
  await installScriptOnlyClickGuard(page);
  const blocked = await disarmRiskyAddButtons(page);
  if (blocked > 0) {
    console.log(`    🚫 Disarmed ${blocked} non-required button(s) on "${stepName}"`);
  }

  if (stepName === 'My Information') {
    await handleStep1MyInformation(page, profile, plan);
    await runWorkdayQuestionWorkflow(page, profile, plan, stepName, { maxPasses: 6, maxOuterPasses: 1 });
    return;
  }

  if (stepName === 'My Experience') {
    // Section expansion is owned by handleStep2MyExperience(): it only clicks Add
    // when Workday marks the section required, and never for optional sections.
    const resumePath = await getResumePathForApply(profile, plan);
    const needsResume = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return /resume\s*\/\s*cv|\bresume\b|upload a file|drop files here|select files/i.test(text);
    }).catch(() => false);
    if (resumePath && needsResume) {
      let uploaded = await handleWorkdayResumeUpload(page, resumePath, profile);
      if (!uploaded) {
        console.log('    ↻ Resume upload retry after short wait...');
        await page.waitForTimeout(800);
        uploaded = await handleWorkdayResumeUpload(page, resumePath, profile);
      }
      if (!uploaded) {
        console.log('    ⚠️  Resume still not confirmed — continuing required fields only (check resumes/ PDF)');
      }
    } else if (needsResume && !resumePath) {
      console.log('    ⚠️  Resume required but no PDF found in resumes/ folder');
    }
    await handleStep2MyExperience(page, profile);
    await fillWorkdaySkillsSection(page, profile);
    await runWorkdayQuestionWorkflow(page, profile, plan, stepName, { maxPasses: 6, maxOuterPasses: 1 });
    return;
  }

  const resumePath = await getResumePathForApply(profile, plan);
  const resumeSectionText = await page.evaluate(() => {
    const label = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return /resume\s*\/\s*cv|resume|upload a file|drop files here|select files/i.test(label);
  }).catch(() => false);

  if (resumeSectionText && resumePath && stepName !== 'My Experience') {
    await handleWorkdayResumeUpload(page, resumePath, profile);
  }

  await runStepDomPrep(page, stepName, profile);

  await runWorkdayQuestionWorkflow(page, profile, plan, stepName, {
    maxPasses: /application questions|voluntary disclosures|self identify/i.test(stepName) ? 6 : 5,
    maxOuterPasses: 1,
  });

  const agreementsChecked = await acknowledgeAllPageAgreements(page, profile, stepName);
  if (agreementsChecked > 0) {
    console.log(`    ☑️  Bottom-of-page agreements: ${agreementsChecked} checkbox(es) checked on "${stepName}"`);
  }
}

/**
 * Fill the current wizard step once (one retry only if required fields remain).
 * Do not re-loop after important questions are already answered.
 */
async function fillStepUntilReady(page, stepName, profile, plan, { fingerprint = '' } = {}) {
  if (!(profile._filledFingerprints instanceof Set)) profile._filledFingerprints = new Set();

  if (fingerprint && profile._filledFingerprints.has(fingerprint)) {
    const remaining = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => -1);
    if (remaining === 0) {
      console.log(`  ⏭️  "${stepName}" already filled — skip re-fill (efficient)`);
      return true;
    }
    console.log(`  ↻ "${stepName}" revisited with ${remaining} empty required — fill those only`);
  }
  if (fingerprint) profile._filledFingerprints.add(fingerprint);

  // Single efficient fill pass (specialized handlers live inside fillCurrentWorkdayStep)
  await fillCurrentWorkdayStep(page, stepName, profile, plan);

  const remaining = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => 0);
  if (remaining === 0) {
    console.log(`  ✓ "${stepName}" — all required fields filled (1 pass)`);
    return true;
  }

  // One targeted retry only — never multi-loop the whole step
  console.log(`  ↻ ${remaining} required still empty — one quick retry then Save and Continue`);
  await page.waitForTimeout(400);
  await fillCurrentWorkdayStep(page, stepName, profile, plan);

  const after = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => 0);
  if (after === 0) {
    console.log(`  ✓ "${stepName}" — complete after retry`);
  } else {
    console.log(`  ⚠️  ${after} field(s) may still be empty — advancing with Save and Continue`);
  }
  return true;
}

/** Click Save and Continue / Next repeatedly until the wizard step changes. */
async function clickSaveAndContinueAtAnyCost(page, stepName, profile, plan) {
  const before = stepName || await detectWorkdayStep(page);

  const maxAdvance = 3;
  let lastErrors = [];

  for (let attempt = 0; attempt < maxAdvance; attempt++) {
    if (attempt > 0) {
      console.log(`  ↻ Advance retry ${attempt + 1}/${maxAdvance}...`);

      // Workday named the offending fields — fix exactly those instead of
      // re-filling the whole step.
      const flagged = lastErrors.length ? parseErrorFieldNames(lastErrors) : [];
      let repaired = 0;
      if (flagged.some((n) => /field\s*of\s*study/i.test(n))) {
        const fos = await fillEducationFieldOfStudy(page, profile?.education?.major || 'Computer Science').catch(() => false);
        if (fos) repaired++;
      }
      if (lastErrors.length) {
        repaired += await repairRequiredFieldsFromErrors(page, profile, before, lastErrors).catch(() => 0);
      }

      if (repaired > 0) {
        console.log(`  🔧 Repaired ${repaired} flagged field(s) — skipping full re-fill`);
      } else {
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await fillCurrentWorkdayStep(page, before, profile, plan);
      }
      await page.waitForTimeout(RAPID.settleMs);
    }

    await acknowledgeAllPageAgreements(page, profile, before);

    const rapid = await rapidAdvanceOnce(page, before);
    if (rapid.transitioned) {
      console.log(`  ✓ Rapid advance: "${before}" → "${rapid.step}" (${rapid.clicked || 'footer'})`);
      return { transitioned: true, step: rapid.step, hasSaveButton: true, hasErrors: false, aqPageAdvanced: rapid.aqPageAdvanced };
    }
    if (rapid.submitBlocked) {
      return { ...rapid, transitioned: false, step: before, submitBlocked: true };
    }

    const result = await advanceWorkdayStepWithVerification(page, before);
    if (result.transitioned) return result;
    if (result.errors?.length) lastErrors = result.errors;
    if (result.submitBlocked) {
      return { ...result, transitioned: false, step: before, submitBlocked: true };
    }
  }

  return {
    transitioned: false,
    step: before,
    hasSaveButton: false,
    hasErrors: lastErrors.length > 0,
    errors: lastErrors,
    submitBlocked: false,
  };
}


// ─── Workday Step Advance (Save and Continue) ───────────────────────────────
async function advanceWorkdayStep(page, currentStep = '') {
  const step = currentStep || await detectWorkdayStep(page);

  if (step === 'Application Questions') {
    const aqInfo = await getApplicationQuestionsPageInfo(page);
    if (aqInfo && aqInfo.current < aqInfo.total) {
      const moved = await advanceApplicationQuestionsPage(page);
      if (moved) {
        return { hasSaveButton: true, hasErrors: false, aqPageAdvanced: true };
      }
      console.log(`\n  ℹ️  Application Questions ${aqInfo.current} of ${aqInfo.total} — fill required fields, then Next`);
      return { hasSaveButton: false, aqSubpagesRemain: true };
    }
  }

  const saveBtnSelectors = [
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button[data-automation-id="bottom-navigation-next-button"]',
    'button[data-automation-id="page-footer-next-button"]',
    'button[data-automation-id*="next-button" i]',
    'button[data-automation-id*="nextButton" i]',
    'button:has-text("Next")',
  ];

  await page.keyboard.press('Escape').catch(() => {});

  let saveBtn = null;
  for (const sel of saveBtnSelectors) {
    const btn = await page.$(sel);
    if (!btn || !(await btn.isVisible().catch(() => false))) continue;
    // On Review, the footer "next" button IS the Submit button — never click it here.
    const text = ((await btn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (/submit|apply\s*now|send\s*application|complete\s*application/i.test(text)) {
      console.log(`  🛑 Footer button is "${text}" — this submits the application, so it is left alone.`);
      return { hasSaveButton: false, submitBlocked: true };
    }
    saveBtn = btn;
    break;
  }

  if (!saveBtn) {
    return { hasSaveButton: false };
  }

  const btnText = (await saveBtn.textContent().catch(() => '')).trim();
  console.log(`\n  ➡️  Clicking "${btnText || 'Save and Continue'}" to advance...`);
  await saveBtn.click({ force: true }).catch(() => saveBtn.evaluate(el => el.click()));

  try {
    await page.waitForSelector('[data-automation-id="loading-spinner"], div[class*="loading-spinner"], div.loading-backdrop', { state: 'detached', timeout: 15000 });
  } catch {}
  try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch {}
  await waitForDomSettled(page, { timeout: RAPID.settleMs });

  const errorMessages = await page.evaluate(() => {
    const errs = [];
    const isSuccessNoise = (text) => /successfully\s*uploaded|successfully\s*saved|^\s*success[!.\s]*$/i.test(text);
    document.querySelectorAll('.error, .field-error, .error-message, .invalid-feedback, [class*="error"], [class*="Error"], [role="alert"], [data-automation-id*="error"]').forEach(el => {
      const text = (el.textContent || '').trim();
      if (!text || text.length < 3 || text.length > 200) return;
      if (isSuccessNoise(text)) return;
      if (/alert/i.test(el.getAttribute('role') || '') && /success|uploaded|complete/i.test(text)) return;
      errs.push(text);
    });
    return [...new Set(errs)];
  });

  if (errorMessages.length > 0) {
    console.log(`  ⚠️  ${errorMessages.length} validation error(s) after Save and Continue:`);
    errorMessages.forEach(e => console.log(`    • ${e}`));
    return { hasSaveButton: true, hasErrors: true, errors: errorMessages, transitioned: false };
  }

  return { hasSaveButton: true, hasErrors: false };
}

/**
 * Click Save & Continue and verify the wizard step actually changed.
 */
async function advanceWorkdayStepWithVerification(page, previousStep) {
  const before = previousStep || await detectWorkdayStep(page);
  const aqBefore = before === 'Application Questions' ? await getApplicationQuestionsPageInfo(page) : null;
  const result = await advanceWorkdayStep(page, before);
  if (!result.hasSaveButton) return { ...result, transitioned: false, step: before };
  if (result.hasErrors) return { ...result, transitioned: false, step: before };

  if (result.aqPageAdvanced) {
    await waitForDomSettled(page);
    const aqAfter = await getApplicationQuestionsPageInfo(page);
    if (aqAfter && aqBefore && aqAfter.current > aqBefore.current) {
      console.log(`  ✓ Application Questions sub-page: ${aqBefore.current} → ${aqAfter.current} of ${aqAfter.total}`);
      return { ...result, transitioned: true, step: before, aqPageAdvanced: true };
    }
  }

  const prog = await waitForWizardProgress(page, before, {
    aqBefore: before === 'Application Questions' ? aqBefore : null,
  });
  if (prog.changed) {
    console.log(`  ✓ Step transitioned: "${before}" → "${prog.step}"`);
    return { ...result, transitioned: true, step: prog.step, aqPageAdvanced: prog.aqAdvanced };
  }

  console.log(`  ⚠️  Step did not change after Save and Continue (still "${before}")`);
  return { ...result, transitioned: false, step: before };
}

/**
 * Always ask before Submit unless --confirm-submit was passed.
 * In --dry-run mode, auto-skips (never submits) and signals 'reached-review'.
 * @returns {'submit'|'decline'|'skip'|'dry-run-skip'}
 */
async function confirmSubmitInTerminal(autoConfirm, dryRun = false) {
  if (dryRun) {
    console.log('  🎯 --dry-run — reached Review page! Counting as success and skipping (not submitting).');
    return 'dry-run-skip';
  }
  if (autoConfirm) {
    console.log('  ✅ --confirm-submit — submitting without prompt');
    return 'submit';
  }
  let rl;
  try {
    rl = readline.createInterface({ input, output });
    process.stdin.resume();
    console.log(`\n${'═'.repeat(60)}`);
    console.log('READY TO SUBMIT — Review is on screen');
    console.log('   [Y] Yes  — submit this application');
    console.log('   [N] No   — do not submit (stop batch here)');
    console.log('   [S] Skip — do not submit, continue to the next URL');
    console.log(`${'═'.repeat(60)}`);
    while (true) {
      const answer = await rl.question('\n> Submit? [Y/N/S]: ');
      const choice = answer.trim().toLowerCase();
      if (choice === 'y' || choice === 'yes') return 'submit';
      if (choice === 'n' || choice === 'no') return 'decline';
      if (choice === 's' || choice === 'skip') return 'skip';
      console.log('   Type Y (submit), N (stop), or S (skip to next URL).');
    }
  } catch (err) {
    console.log(`  ⚠️  Submit prompt unavailable (${err.message?.slice(0, 60) || 'no stdin'}) — not submitting.`);
    return 'skip';
  } finally {
    rl?.close();
  }
}

/**
 * Scan-batch pause at Review — user decides next URL, submit, or stop batch.
 * @returns {'next'|'submit'|'stop'}
 */
/**
 * When the wizard cannot advance, let the user fix in browser or quit batch.
 * @returns {'retry'|'quit'}
 */
export async function promptStuckStepDecision({ stepName = '', company = '' } = {}) {
  if (!isFormAnswerTerminalEnabled() || isAutoApplyMode()) {
    console.log(`  🤖 Auto mode — retrying stuck step "${stepName || 'unknown'}" without terminal`);
    return 'retry';
  }
  const rl = readline.createInterface({ input, output });
  try {
    process.stdin.resume();
    console.log(`\n${'═'.repeat(60)}`);
    console.log('⚠️  APPLICATION INCOMPLETE — could not advance wizard step');
    if (company) console.log(`   Company: ${company}`);
    if (stepName) console.log(`   Stuck on: ${stepName}`);
    console.log('\n   Fill missing required fields in the browser (or answer prompts above).');
    console.log('   [R] or Enter — Retry fill + advance on this application');
    console.log('   [Q] Quit — stop batch here (will NOT open next URL)');
    console.log(`${'═'.repeat(60)}`);
    const answer = await rl.question('\n> Your choice [R/q]: ');
    const choice = answer.trim().toLowerCase();
    if (choice === 'q' || choice === 'quit' || choice === 'stop') return 'quit';
    return 'retry';
  } finally {
    rl.close();
  }
}

export async function promptScanReviewDecision({ company = '', url = '' } = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    process.stdin.resume();
    console.log(`\n${'═'.repeat(60)}`);
    console.log('⏸️  SCAN PAUSED — Review step (browser left open for you)');
    if (company) console.log(`   Company: ${company}`);
    if (url) console.log(`   URL: ${url}`);
    console.log('\n   Check the application in the browser, then choose:');
    console.log('   [Y] or Enter — Next URL (do NOT submit, continue batch)');
    console.log('   [S] Submit — submit this application, then continue batch');
    console.log('   [Q] Quit — stop batch scan here');
    console.log(`${'═'.repeat(60)}`);
    const answer = await rl.question('\n> Your choice [Y/s/q]: ');
    const choice = answer.trim().toLowerCase();
    if (choice === 'q' || choice === 'quit' || choice === 'stop') return 'stop';
    if (choice === 's' || choice === 'submit') return 'submit';
    return 'next';
  } finally {
    rl.close();
  }
}

async function verifyAndSubmitReview(page, profile, { confirmSubmit = false, dryRun = false } = {}) {
  console.log('\n📋 Review step — parsing DOM before submit.');

  if (profile?._humanRequired?.length) {
    console.log('\n  🛑 Cannot auto-submit — unresolved required field(s):');
    for (const item of profile._humanRequired.slice(0, 8)) {
      console.log(`     • [${item.section}] ${String(item.label || '').slice(0, 80)} (${item.field_type || 'field'})`);
    }
    if (profile._humanRequired.length > 8) {
      console.log(`     … and ${profile._humanRequired.length - 8} more`);
    }
    return 'human-required';
  }

  await takeScreenshot(page, 'workday-review-step');
  await attachFormMutationObserver(page);
  await acknowledgeAllPageAgreements(page, profile, 'Review');
  const review = await parseReviewDOM(page);

  const expected = {
    'Country': profile?.personal?.country || profile?.personal?.country_phone_code,
    'Country code': profile?.personal?.country_phone_code,
    'Phone Number': profile?.personal?.phone,
    'Name': profile?.personal?.full_name || `${profile?.personal?.first_name || ''} ${profile?.personal?.last_name || ''}`.trim(),
    'Email': profile?.personal?.email,
    ...(profile?._filledValues || {}),
  };

  const mismatches = crossCheckReview(expected, review);
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.log(`  ⚠️  Review note: ${m.field} expected "${m.expected}" / page "${m.displayed}"`);
    }
  }

  const canonicalJobUrl = profile._canonicalJobUrl || profile._jobUrl || page.url();

  const decision = await confirmSubmitInTerminal(confirmSubmit, dryRun);
  if (decision === 'dry-run-skip') {
    console.log('  🎯 Dry-run — reached Review. Moving to next URL.');
    await takeScreenshot(page, 'post-submit');
    await recordClientApplication(profile, { url: canonicalJobUrl, status: 'skipped', failureReason: 'dry_run' }).catch(() => {});
    return 'reached-review';
  }
  if (decision === 'decline') {
    console.log('  ✋ N — not submitting. Stopping here.');
    await recordClientApplication(profile, { url: canonicalJobUrl, status: 'skipped', failureReason: 'review_declined' }).catch(() => {});
    return 'review-declined';
  }
  if (decision === 'skip') {
    console.log('  ⏭️  S — skipped (not submitted). Continuing to the next URL.');
    await recordClientApplication(profile, { url: canonicalJobUrl, status: 'skipped' }).catch(() => {});
    return 'skipped';
  }

  console.log('🚀 Clicking final "Submit" button...');
  await clickSubmitButton(page, { allowSubmit: true });
  await waitForDomSettled(page);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  const confirmationFound = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /thank\s*you\s*for\s*applying|application\s*submitted|congratulations|submission\s*complete/i.test(text) ||
           !!document.querySelector('[data-automation-id="submissionSuccess"], [data-automation-id="applicationSubmitted"]');
  });

  if (confirmationFound) {
    console.log('✅ Workday application successfully submitted!');
    await takeScreenshot(page, 'workday-submitted');
    await recordClientApplication(profile, { url: canonicalJobUrl, status: 'submitted' }).catch(() => {});
    await cleanupClientResume(profile);
    return 'submitted';
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/verification\s*code|enter.*code|confirm.*human|code\s*was\s*sent/i.test(bodyText)) {
    console.log('Post-submit verification appeared — mailbox OTP is not connected (Zoho Mail can be added later).');
    await recordClientApplication(profile, { url: canonicalJobUrl, status: 'in_progress', failureReason: 'needs_manual_verification' }).catch(() => {});
    return 'needs-manual-verification';
  }

  await recordClientApplication(profile, { url: canonicalJobUrl, status: 'submitted' }).catch(() => {});
  await cleanupClientResume(profile);
  return 'submitted';
}

// ─── Workday 5-Step Wizard Loop ─────────────────────────────────────────────
export async function runWorkdayWizardLoop(page, profile, plan, { confirmSubmit = false, dryRun = false } = {}) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`STARTING WORKDAY WIZARD LOOP (script-only Playwright)`);
  console.log(`  Policy: REQUIRED fields only — no optional / unimportant clicks`);
  console.log(`  Allowed: scripted fills + Save and Continue / Next / Submit`);
  console.log(`  Blocked: Certifications Add, bare Add, Help/Share, optional questions`);
  console.log(`${'═'.repeat(60)}`);

  // Fresh session markers for THIS job URL — never reuse prior page fingerprints/skips.
  resetPerApplicationSessionState(profile);

  const initialJobUrl = plan?.url || profile._jobUrl || page.url();
  profile._canonicalJobUrl = profile._canonicalJobUrl || initialJobUrl;
  profile._jobUrl = profile._canonicalJobUrl;

  // Browser refuses optional Add / chrome clicks even if a module tries.
  await installScriptOnlyClickGuard(page);

  const detected = detectWorkdayTenant(profile._canonicalJobUrl || plan?.url || page.url());
  const tenant = detected?.tenant || getWorkdayTenant(profile._canonicalJobUrl || plan?.url || page.url());
  // Hard lock: never fill optional fields unless explicitly opted in.
  profile._fillOptionalFields = profile._fillOptionalFields === true;
  profile._scriptOnly = true;

  if (tenant) {
    profile._tenant = tenant;
    profile._workdayPlatform = detected?.platform || '';
    if (detected?.platform) {
      console.log(`  🌐 Workday tenant=${tenant} platform=${detected.platform} host=${detected.hostname}`);
    }
  }

  await bootstrapClientContext(profile, plan);

  const { isApplyWizzConfigured } = await import('./applyWizzClient.mjs');
  const { profileFactPresence } = await import('./questionEngine/profileFacts.mjs');
  if (isApplyWizzConfigured() && !profile._applyWizzHydrated) {
    console.error('❌ Apply Wizz client API did not hydrate — stopping this apply (no fabricated identity/contact answers).');
    console.error('     Fix TLS/network (APPLYWIZZ_TLS_INSECURE=1 on Windows CA issues) and confirm get-client-details returns client + additional_information.');
    await recordClientApplication(profile, { url: profile._canonicalJobUrl, status: 'incomplete', failureReason: 'applywizz_not_hydrated' }).catch(() => {});
    return 'incomplete';
  }
  if (isApplyWizzConfigured()) {
    const facts = profileFactPresence(profile);
    if (!facts.name || !facts.email) {
      console.error('❌ Apply Wizz profile missing legal name or email — My Information cannot be filled from API.');
      await recordClientApplication(profile, { url: profile._canonicalJobUrl, status: 'incomplete', failureReason: 'missing_name_or_email' }).catch(() => {});
      return 'incomplete';
    }
  }

  if (!profile?.personal?.phone) {
    const { ensureWorkdayContactFromClient } = await import('./clientContact.mjs');
    await ensureWorkdayContactFromClient(profile);
  }
  if (!profile?.personal?.phone) {
    console.error('❌ No phone after Apply Wizz bootstrap — set personal.phone or fix APPLYWIZZ_ID in .env');
    await recordClientApplication(profile, { url: profile._canonicalJobUrl, status: 'incomplete', failureReason: 'missing_phone' }).catch(() => {});
    return 'incomplete';
  }

  await recordClientApplication(profile, {
    url: profile._canonicalJobUrl,
    company: profile._company || plan?.company || '',
    jobTitle: plan?.jobTitle || '',
    status: 'started',
  }).catch(() => {});

  if (await isWorkdayWizardVisible(page)) {
    await tryUsePreviousApplication(page, profile).catch(() => false);
  }

  const maxSteps = 18;
  const maxNoProgress = 2;
  let currentIteration = 0;
  let lastFingerprint = '';
  let noProgressCount = 0;
  const stepStuck = { name: '', count: 0, lastUnfilled: -1 };

  while (currentIteration < maxSteps) {
    currentIteration++;

    const refreshed = await refreshWorkdayPageOnce(page);
    let stepName = await detectWorkdayStep(page);

    if (stepName === 'Unknown' && !await isWorkdayWizardVisible(page)) {
      console.log('  🔎 Not on wizard yet — looking for Continue Application / Apply...');
      const entry = await ensureWorkdayApplicationWizard(page, { mode: 'signin' });
      if (entry.entered) {
        console.log(`  ✅ Entered wizard via ${entry.method}`);
        stepName = await detectWorkdayStep(page);
        await tryUsePreviousApplication(page, profile).catch(() => false);
      }
    }

    if (refreshed) {
      console.log(`\n📍 [Wizard Step ${currentIteration}] Page refreshed; re-detected Page: "${stepName}"`);
    } else {
      console.log(`\n📍 [Wizard Step ${currentIteration}] Detected Page: "${stepName}"`);
    }

    if (stepName === 'Review') {
      return await verifyAndSubmitReview(page, profile, { confirmSubmit, dryRun });
    }

    const fingerprint = await computeStepFingerprint(page, stepName);
    const unfilledBefore = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => -1);

    await detachFormMutationObserver(page);
    await attachFormMutationObserver(page);
    const liveFields = await discoverWorkdayFields(page);
    console.log(`  🔍 Fresh DOM scan for this page: ${liveFields.length} control(s) (fingerprint labels=${fingerprint.split('::').pop()?.length || 0})`);

    await fillStepUntilReady(page, stepName, profile, plan, { fingerprint });

    const blockedClicks = await drainBlockedScriptClicks(page);
    if (blockedClicks.length) {
      console.log(`  🛡️  Blocked ${blockedClicks.length} non-required click(s): ${[...new Set(blockedClicks)].join(', ')}`);
    }

    takeScreenshot(page, `workday-step-${currentIteration}-${stepName.replace(/\s+/g, '-').toLowerCase()}`).catch(() => {});

    const pageGate = await validatePage(page, profile, stepName).catch(() => null);
    if (pageGate && !pageGate.ok) {
      console.log(`  ⚠️  Page not ready for Next: ${pageGate.reason}`);
    }

    const orch = profile._lastOrchestrator;
    if (orch?.status === 'blocked') {
      console.log(`  ℹ️  Orchestrator note (${orch.reason}) — proceeding to rapid advance`);
    }

    console.log('  ➡️  Fill done — instant Save and Continue...');
    let advanceResult;
    try {
      advanceResult = await clickSaveAndContinueAtAnyCost(page, stepName, profile, plan);
    } catch (err) {
      console.log(`  ⚠️  Save and Continue threw (${err.message?.slice(0, 120) || err}) — staying on this URL to repair`);
      advanceResult = { transitioned: false, hasErrors: true, errors: [], submitBlocked: false };
    }

    if (advanceResult.transitioned) {
      noProgressCount = 0;
      lastFingerprint = fingerprint;
      if (/my information/i.test(stepName) || /my experience|application questions/i.test(advanceResult.step || '')) {
        await recordClientApplication(profile, {
          url: profile._canonicalJobUrl || plan?.url || page.url(),
          company: profile._company || plan?.company || '',
          status: 'in_progress',
          tenantProgress: true,
        }).catch(() => {});
      }
      continue;
    }

    const maybeReview = await detectWorkdayStep(page);
    if (maybeReview === 'Review' || advanceResult.submitBlocked) {
      await recordClientApplication(profile, {
        url: profile._canonicalJobUrl || plan?.url || page.url(),
        company: profile._company || '',
        status: 'in_progress',
        success: true,
      }).catch(() => {});
      return await verifyAndSubmitReview(page, profile, { confirmSubmit, dryRun });
    }

    if (advanceResult.hasErrors) {
      clearStaleFilledValuesFromErrors(profile, advanceResult.errors || []);
      const repaired = await repairRequiredFieldsFromErrors(page, profile, stepName, advanceResult.errors || [])
        .catch(() => 0);
      if (repaired > 0) {
        console.log(`  🔧 Repaired ${repaired} field(s) named in the validation errors — retrying Save and Continue`);
        noProgressCount = 0;
        lastFingerprint = fingerprint;
        continue;
      }
    }

    const unfilledAfter = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => -1);
    const fingerprintAfter = await computeStepFingerprint(page, stepName);
    const reducedRequired = unfilledBefore >= 0 && unfilledAfter >= 0 && unfilledAfter < unfilledBefore;
    const madeProgress = reducedRequired;

    lastFingerprint = fingerprint;

    if (stepStuck.name !== stepName) {
      stepStuck.name = stepName;
      stepStuck.count = 0;
      stepStuck.lastUnfilled = unfilledAfter;
    } else if (unfilledAfter === stepStuck.lastUnfilled) {
      stepStuck.count += 1;
    } else {
      stepStuck.count = 0;
      stepStuck.lastUnfilled = unfilledAfter;
    }

    if (stepStuck.count >= 3) {
      console.log(`  ⛔ Stuck on "${stepName}" (${stepStuck.count} passes, ${unfilledAfter} required empty) — stop refill loop`);
      break;
    }

    if (madeProgress) {
      noProgressCount = 0;
      console.log(`  ↻ Required count improved (${unfilledBefore} → ${unfilledAfter}) — retry Save and Continue`);
      continue;
    }

    noProgressCount++;

    if (noProgressCount === 1 && unfilledAfter > 0) {
      const retryWorkflow = await runWorkdayQuestionWorkflow(page, profile, plan, stepName, { maxPasses: 6, maxOuterPasses: 1 }).catch(() => null);
      if (retryWorkflow?.filled > 0) {
        console.log(`  🔄 Question workflow filled ${retryWorkflow.filled} stuck field(s) — retrying Save and Continue`);
        noProgressCount = 0;
        continue;
      }
    }

    if (noProgressCount >= maxNoProgress) {
      console.log(`  ⛔ Still on "${stepName}" after ${maxNoProgress} failed advances — stopping this URL (no refill loop)`);
      break;
    }

    console.log(`  ℹ️  No progress (${noProgressCount}/${maxNoProgress}) — one more fill + Save and Continue attempt...`);
  }

  const finalStep = await detectWorkdayStep(page);
  if (finalStep === 'Review') {
    await recordClientApplication(profile, {
      url: profile._canonicalJobUrl || plan?.url || page.url(),
      company: profile._company || '',
      status: 'in_progress',
      success: true,
    }).catch(() => {});
    return await verifyAndSubmitReview(page, profile, { confirmSubmit, dryRun });
  }
  await recordClientApplication(profile, {
    url: profile._canonicalJobUrl || plan?.url || page.url(),
    company: profile._company || plan?.company || '',
    status: 'failed',
    failureReason: 'wizard_did_not_reach_review',
  }).catch(() => {});
  return 'incomplete';
}

/**
 * Walk the full Workday wizard for scan-batch: harvest every step + AQ sub-pages.
 * Fills known fields from profile (no terminal prompts) so Save and Continue works.
 * Stops at Review — does not submit.
 */
export async function runWorkdayQuestionScanLoop(page, profile, plan = {}, {
  company = '',
  url = '',
  interactive = true,
  waitAtReview = true,
} = {}) {
  // Each scan URL is a new application layout — clear session fill/skip caches.
  resetPerApplicationSessionState(profile);
  await installScriptOnlyClickGuard(page);
  profile._mandatoryOnlyScan = true;
  profile._mandatoryOnlyFill = true;
  profile._scriptOnly = true;
  profile._fillOptionalFields = false;

  if (interactive) {
    delete profile._scanMode;
    profile._scanInteractive = true;
    console.log('\n  🔍 Interactive wizard scan — mandatory fields; Apply Wizz/YAML/LLM (no form terminal)...');
  } else {
    profile._scanMode = true;
    delete profile._scanInteractive;
    console.log('\n  🔍 Silent wizard scan — mandatory fields only; yaml/mjs (no terminal)...');
  }

  if (company) profile._company = company;
  if (url) {
    const detected = detectWorkdayTenant(url);
    profile._tenant = detected?.tenant || getWorkdayTenant(url);
    profile._workdayPlatform = detected?.platform || '';
    if (detected?.platform) {
      console.log(`  🌐 Workday tenant=${profile._tenant} platform=${detected.platform} host=${detected.hostname}`);
    }
  }

  const steps = [];
  const questions = [];
  let stuckCount = 0;

  for (let i = 0; i < 12; i++) {
    await refreshWorkdayPageOnce(page);
    let stepName = await detectWorkdayStep(page);

    if (stepName === 'Unknown' && !await isWorkdayWizardVisible(page)) {
      console.log('  🔎 Not on wizard yet — looking for Continue Application / Apply...');
      const entry = await ensureWorkdayApplicationWizard(page, { mode: 'signin' });
      if (entry.entered) {
        console.log(`  ✅ Entered wizard via ${entry.method}`);
        stepName = await detectWorkdayStep(page);
      }
    }

    profile._currentStep = stepName;
    console.log(`\n  📍 [Scan ${i + 1}] Wizard step: "${stepName}"`);

    if (stepName === 'Review') {
      if (!steps.includes('Review')) steps.push('Review');
      const reviewBatch = await harvestPageQuestions(page, { company, url, stepName: 'Review' });
      questions.push(...reviewBatch);
      console.log(`    📋 Harvested ${reviewBatch.length} field(s) on Review`);

      await takeScreenshot(page, `scan-review-${(getWorkdayTenant(url) || company || 'tenant').replace(/[^a-z0-9]+/gi, '-')}`);

      let reviewDecision = 'next';
      if (waitAtReview) {
        reviewDecision = await promptScanReviewDecision({ company, url });
        console.log(`    ⏸️  Review decision: ${reviewDecision}`);
      }

      if (reviewDecision === 'submit') {
        console.log('    🚀 Submitting application (your choice at Review)...');
        const submitted = await clickSubmitButton(page, { allowSubmit: true });
        await waitForDomSettled(page);
        if (submitted) {
          console.log('    ✅ Submit clicked — check browser for confirmation');
        } else {
          console.log('    ⚠️  Submit button not found — review manually in browser');
        }
      }

      const byStep = summarizeQuestionsByStep(questions);
      console.log(`\n  ✅ Scan complete: ${questions.length} question(s) across [${steps.join(' → ')}]`);
      console.log(`     Breakdown: ${formatStepQuestionSummary(byStep)}`);

      return {
        steps,
        questions,
        byStep,
        reachedReview: true,
        reviewDecision,
      };
    }

    if (!steps.includes(stepName)) steps.push(stepName);

    const batch = await harvestPageQuestions(page, { company, url, stepName });
    questions.push(...batch);
    console.log(`    📋 Harvested ${batch.length} field(s) on "${stepName}"`);

    await fillCurrentWorkdayStep(page, stepName, profile, plan);

    if (stepName === 'Application Questions') {
      for (let aqPass = 0; aqPass < 8; aqPass++) {
        const aqInfo = await getApplicationQuestionsPageInfo(page);
        if (!aqInfo || aqInfo.current >= aqInfo.total) break;
        const moved = await advanceApplicationQuestionsPage(page);
        if (!moved) break;
        const subBatch = await harvestPageQuestions(page, { company, url, stepName });
        questions.push(...subBatch);
        console.log(`    📋 Harvested ${subBatch.length} field(s) on Application Questions page ${aqInfo.current + 1} of ${aqInfo.total}`);
        await fillCurrentWorkdayStep(page, stepName, profile, plan);
      }
    }

    let advanced = false;
    const maxAdvanceAttempts = interactive ? 6 : 2;
    for (let attempt = 0; attempt < maxAdvanceAttempts; attempt++) {
      const advanceResult = await advanceWorkdayStepWithVerification(page, stepName);
      if (advanceResult.transitioned) {
        advanced = true;
        stuckCount = 0;
        break;
      }
      if (attempt < maxAdvanceAttempts - 1) {
        console.log(`    ⚠️  Could not advance from "${stepName}" — fill retry ${attempt + 2}/${maxAdvanceAttempts}...`);
        await fillCurrentWorkdayStep(page, stepName, profile, plan);
      }
    }
    if (!advanced) {
      stuckCount++;
      const stillEmpty = await countUnfilledMandatoryQuestions(page, profile, stepName).catch(() => -1);
      console.log(`    ⚠️  Stuck on "${stepName}" (${stuckCount}/2) — ${stillEmpty} required field(s) still empty.`);
      if (stuckCount < 2) {
        await fillCurrentWorkdayStep(page, stepName, profile, plan);
        continue;
      }
      console.log('    🛑 No progress — moving on instead of looping.');
      break;
    }
  }

  const byStep = summarizeQuestionsByStep(questions);
  console.log(`\n  ✅ Scan complete: ${questions.length} question(s) across [${steps.join(' → ')}]`);
  console.log(`     Breakdown: ${formatStepQuestionSummary(byStep)}`);

  return {
    steps,
    questions,
    byStep,
    reachedReview: steps.includes('Review'),
    reviewDecision: 'next',
  };
}


// Adaptive scan/fill loop — login is email + password only (no mailbox OTP)
export async function runAdaptiveScanFillLoop(page, profile, plan = {}, { mode = 'signin' } = {}) {
  const maxIterations = 15;
  for (let iter = 0; iter < maxIterations; iter++) {
    console.log(`\n=== Adaptive Loop iteration ${iter + 1} ===`);

    await refreshWorkdayPageOnce(page);

    // Check if on Step 1 "My Information"
    const stepName = await detectWorkdayStep(page);
    if (stepName === 'My Information') {
      console.log('  📍 Detected Step 1: "My Information". Executing dedicated Step 1 handler...');
      await handleStep1MyInformation(page, profile, plan);
      await advanceWorkdayStepWithVerification(page, stepName);
      continue;
    }

    // 1) Collect visible fields
    const visibleFields = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      function getLabel(el) {
        try {
          if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) return label.textContent.trim();
          }
          const parentLabel = el.closest && el.closest('label');
          if (parentLabel) return parentLabel.textContent.trim();
          if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label');
          if (el.placeholder) return el.placeholder;
          const autoId = el.getAttribute && (el.getAttribute('data-automation-id') || '');
          const idOrName = el.id || el.name || autoId;
          if (idOrName) {
            const clean = idOrName.replace(/--/g, ' ').replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
            if (clean) return clean;
          }
          return el.name || el.id || '';
        } catch { return ''; }
      }

      document.querySelectorAll('input, select, textarea, [data-automation-id="select-widget"]').forEach(el => {
        try {
          const type = el.type || el.tagName.toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return;
          const key = el.id || el.name || (el.getAttribute && el.getAttribute('data-automation-id')) || `f-${results.length}`;
          if (seen.has(key)) return;
          seen.add(key);
          results.push({
            id: el.id || '',
            name: el.name || '',
            label: getLabel(el) || '',
            type,
            required: el.required || (el.getAttribute && el.getAttribute('aria-required') === 'true') || false,
            selector: el.id ? `#${CSS.escape(el.id)}` : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : ''),
          });
        } catch {}
      });
      return results;
    });

    // 2) Log scanned fields
    console.log('Scanned fields:', JSON.stringify(visibleFields, null, 2));

    // 3) Fill mapped fields
    let anyAction = false;
    for (const f of visibleFields) {
      if (!f.label && !f.id && !f.name) continue;
      const label = (f.label || f.id || f.name).trim();
      if (shouldSkipOptionalFill(label, f, profile)) continue;
      const mappedVal = mapLabelToProfileValue(label, profile)
        || await resolveField({ label, type: f.type, required: f.required }, profile, createQAStore(), {
          skipPrompt: true,
          company,
          page,
          url: page.url(),
        });
      if (!mappedVal) {
        continue;
      }

      try {
        const el = await findField(page, f);
        if (!el) continue;
        let currentVal = '';
        try { currentVal = await el.inputValue(); } catch {}
        if (currentVal && currentVal.trim() !== '' && f.type !== 'checkbox') continue;

        await el.scrollIntoViewIfNeeded().catch(() => {});
        if (f.type === 'checkbox') {
          const shouldCheck = ['true','yes','1','on'].includes(String(mappedVal).toLowerCase());
          if (shouldCheck) { await el.click({ force: true }).catch(() => el.evaluate(e => e.click())); anyAction = true; console.log(`Checked: ${label}`); }
        } else if (f.type === 'select' || f.type === 'custom-select') {
          const res = await handleDropdown(page, el, mappedVal, label).catch(() => ({ success: false }));
          if (res && res.success) { anyAction = true; console.log(`Selected: ${label} <- ${mappedVal}`); }
        } else if (f.type === 'file') {
          if (mappedVal) {
            const fileAbs = findExistingResumeFile(mappedVal) || resolve(process.cwd(), mappedVal);
            if (existsSync(fileAbs)) {
              await el.setInputFiles(fileAbs).catch(() => {});
              anyAction = true;
              console.log(`Uploaded file for: ${label}`);
            } else {
              console.log(`File not found for ${label}: ${mappedVal}`);
            }
          }
        } else {
          await el.click().catch(() => {});
          await page.waitForTimeout(80);
          await el.fill(String(mappedVal)).catch(() => {});
          anyAction = true;
          console.log(`Filled: ${label} <- "${String(mappedVal).slice(0,80)}"`);
        }
      } catch (err) {
        console.log(`Could not fill ${label}: ${err?.message?.substring(0,80)}`);
      }
    }

    // 4) Try action buttons
    const actionClicked = await (async () => {
      const actions = [
        'button:has-text("Sign In")',
        'button:has-text("Sign in")',
        'button:has-text("Create Account")',
        'button:has-text("Save and Continue")',
        'button:has-text("Save & Continue")',
      ];
      // Submit / bare Create / Add buttons are deliberately absent — never misclick.
      for (const sel of actions) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible().catch(() => false)) {
            const text = await btn.textContent().catch(() => sel);
            console.log(`Clicking action button: ${text.trim()}`);
            await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
            await page.waitForTimeout(2500);
            try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
            return true;
          }
        } catch {}
      }
      return false;
    })();

    // 5) Detect Review/Submission
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/review(\s*application)?|review and submit|review your application/i.test(bodyText)) {
      console.log('Review page reached — stopping without submitting. Submit it yourself in the browser.');
      return 'review-reached';
    }

    // 6) Detect verification prompts and exit for manual verification
    if (/verification\s*code|confirm.*email|check your email|enter.*code/i.test(bodyText)) {
      console.log('Verification prompt appeared — mailbox OTP is not connected (Zoho Mail can be added later).');
      return 'needs-manual-verification';
    }

    if (!actionClicked && !anyAction) {
      console.log('No action or fills performed this iteration; waiting before next scan...');
      await page.waitForTimeout(2000);
    }
  }

  console.log('Adaptive loop ended (max iterations reached).');
  return 'done';
}

// ─── Submit button finder ───────────────────────────────────────────────────
/**
 * Click the final Submit button. Submission is never automatic: the caller must
 * pass `allowSubmit: true`, which only happens after the operator answered the
 * Review prompt (or passed --confirm-submit).
 * @param {import('playwright').Page} page
 * @param {{allowSubmit?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
async function clickSubmitButton(page, { allowSubmit = false } = {}) {
  if (!allowSubmit) {
    console.log('  🛑 Submit blocked — no operator confirmation for this run. Nothing was submitted.');
    return false;
  }
  const submitSelectors = [
    'button:has-text("Submit application")',
    'button:has-text("Submit Application")',
    'button:has-text("Review and Submit")',
    'button:has-text("Review & Submit")',
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button[data-automation-id="bottom-navigation-next-button"]',
    'button[data-automation-id="page-footer-next-button"]',
    'button[data-automation-id="submit-button"]',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply Now")',
    'button:has-text("Send Application")',
    'button:has-text("Complete Application")',
    'a:has-text("Submit Application")',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        const text = await btn.textContent().catch(() => '');
        console.log(`  🚀 Clicking Submit: "${text.trim()}"...`);
        await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
        await page.waitForTimeout(3000);
        return true;
      }
    } catch { /* try next */ }
  }
  console.log('  ⚠️  No Submit button found.');
  return false;
}

// ─── Yes/No button handler ──────────────────────────────────────────────────
async function handleYesNoButton(page, entry, value) {
  const labelText = entry.label || '';
  const targetValue = value;

  // Strategy 1: DOM traversal from label to sibling buttons
  let clicked = await page.evaluate(({ labelText, targetValue }) => {
    const labels = Array.from(document.querySelectorAll('label'));
    let targetLabel = labels.find(l => l.textContent.trim().startsWith(labelText.substring(0, 40)));
    if (!targetLabel) {
      const allEls = document.querySelectorAll('div, span, p, h3, h4');
      targetLabel = Array.from(allEls).find(el =>
        el.textContent.includes(labelText.substring(0, 40)) &&
        el.textContent.length < labelText.length + 50
      );
    }
    if (!targetLabel) return false;
    const container = targetLabel.closest('[class*="field"], [class*="question"], [class*="Field"], [class*="Question"]') || targetLabel.parentElement;
    if (!container) return false;
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === targetValue) { btn.click(); return true; }
    }
    return false;
  }, { labelText, targetValue });

  if (!clicked) {
    // Strategy 2: Playwright text selector with label proximity
    const btns = await page.$$(`button:has-text("${targetValue}")`);
    for (const btn of btns) {
      const parentText = await btn.evaluate(el => {
        const p = el.closest('[class*="field"], [class*="question"], [class*="Field"]') || el.parentElement?.parentElement;
        return p ? p.textContent : '';
      });
      if (parentText.includes(labelText.substring(0, 30))) {
        await btn.click();
        clicked = true;
        break;
      }
    }
  }

  return clicked;
}

// ─── Typeahead handler ──────────────────────────────────────────────────────
async function handleTypeahead(page, el, value, fieldName) {
  await el.click();
  await page.waitForTimeout(200);
  await el.fill('');
  await page.waitForTimeout(100);
  await el.type(value, { delay: 80 });
  await page.waitForTimeout(1500);

  const optionSelectors = [
    '[role="option"]', '[class*="option"]', '[class*="suggestion"]',
    '[class*="result"]', 'li[class*="item"]', '[class*="autocomplete"] li',
    '[class*="dropdown"] li', '[class*="listbox"] [role="option"]',
  ];

  for (const sel of optionSelectors) {
    const options = await page.$$(sel);
    if (options.length > 0) {
      await options[0].click();
      console.log(`  ✅ Typeahead: ${fieldName} ← "${value}" (picked suggestion)`);
      return true;
    }
  }

  console.log(`  ✅ Typeahead (typed): ${fieldName} ← "${value}"`);
  return true;
}

// ─── Multi-select handler ───────────────────────────────────────────────────
async function handleMultiSelect(page, el, values, fieldName) {
  let selectedCount = 0;
  for (const val of values) {
    try {
      await el.click();
      await page.waitForTimeout(300);
      await el.evaluate(e => { e.value = ''; });
      await page.waitForTimeout(100);
      await el.type(val.substring(0, 15), { delay: 80 });
      await page.waitForTimeout(800);

      const optionSelectors = ['.select__option', '[role="option"]', '[class*="option"]'];
      let picked = false;

      for (const optSel of optionSelectors) {
        const options = await page.$$(optSel);
        for (const opt of options) {
          const isVisible = await opt.isVisible().catch(() => false);
          if (!isVisible) continue;
          const text = (await opt.textContent().catch(() => '')).trim();
          if (!text || text === 'No options' || text.length > 100) continue;
          if (text.toLowerCase() === val.toLowerCase() || fuzzyScore(val, text) >= 0.5) {
            await opt.click();
            picked = true;
            selectedCount++;
            console.log(`  ✅ Multi-select: ${fieldName} += "${val}"`);
            break;
          }
        }
        if (picked) break;
      }

      if (!picked) console.log(`  ⚠️  Multi-select option not found: "${val}"`);
      await page.waitForTimeout(400);
    } catch (err) {
      console.log(`  ⚠️  Multi-select error for "${val}": ${err.message}`);
    }
  }

  if (selectedCount > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  return selectedCount > 0;
}

// ─── Main fill function ─────────────────────────────────────────────────────
export async function fillForm(url, plan, { workdayEmail, workdayPassword, mode = 'signin', browser: existingBrowser, context: existingContext, page: existingPage, confirmSubmit = false, dryRun = false, isBatch = false, profile: profileIn = null } = {}) {
  console.log(`📝 Fill mode: ${url}`);

  const ats = detectATS(url);
  const ownBrowser = !existingBrowser;
  const browser = existingBrowser || await chromium.launch({ headless: false });
  const context = existingContext || (existingBrowser ? await browser.newContext() : await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }));
  const page = existingPage || await context.newPage();

  const fieldResults = []; // for learner
  let activeProfile = profileIn;

  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('data:')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* partial load OK */ }
      await page.waitForTimeout(800);
      if (await isWorkdayJobPageMissing(page)) {
        console.log('❌ Job page does not exist (dead/expired URL) — skipping');
        return 'job_not_found';
      }
    }

    const profile = profileIn || await loadProfile().catch(() => ({}));
    activeProfile = profile;
    if (url) {
      profile._canonicalJobUrl = url;
      profile._jobUrl = url;
      profile._company = profile._company || extractWorkdayCompanyName(url);
      profile._jobTitle = profile._jobTitle || plan?.jobTitle || plan?.role || await extractJobRoleFromDom(page, url);
    }

    // Handle Workday multi-step wizard
    if (ats === 'workday') {
      if (!await isWorkdayWizardVisible(page)) {
        const wdOk = await handleWorkday(page, {
          email: workdayEmail,
          password: workdayPassword,
          mode,
          profile,
        });
        if (!wdOk) {
          console.log('  ❌ Workday authentication could not be confirmed — aborting wizard loop.');
          if (ownBrowser) await browser.close();
          return 'auth-failed';
        }
      }
      if (!await isWorkdayWizardVisible(page)) {
        const entry = await ensureWorkdayApplicationWizard(page, { mode, profile });
        if (entry.entered) {
          console.log(`  ✅ Entered application wizard via ${entry.method}`);
        }
      }

      console.log('  ✅ Workday authentication confirmed — starting 5-step wizard loop...');
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1000);

      const status = await runWorkdayWizardLoop(page, profile, plan, { confirmSubmit, dryRun });

      const postSubmitSS = await takeScreenshot(page, 'post-submit');
      const statusLabel = typeof status === 'object' && status?.status ? status.status : status;
      await logToCSV(url, plan.company || '', plan.role || '', statusLabel, postSubmitSS, { ats });

      try {
        await recordResult(url, plan, status, fieldResults);
      } catch { /* non-critical */ }

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🏁 Result: ${typeof status === 'object' ? JSON.stringify(status) : status}`);
      console.log(`   Screenshots: screenshots/`);
      console.log(`   Report: data/applied.csv`);
      console.log(`${'─'.repeat(60)}`);

      // Determine hold time before browser close based on outcome:
      // — quick close for skipped/declined/blocked/reached-review
      // — batch mode: never block batch loop with long pauses
      // — extended hold for incomplete/verification states in interactive single-job mode
      let holdMs;
      if (dryRun || isBatch || statusLabel === 'reached-review' || statusLabel === 'skipped' || statusLabel === 'review-declined' || statusLabel === 'blocked') {
        holdMs = isBatch ? 1000 : 2500;
      } else if (statusLabel === 'incomplete' || statusLabel === 'needs-manual-verification' || statusLabel === 'human-required') {
        holdMs = 120000; // 2 minutes — keep open for manual intervention in single-job mode
        console.log(`\n   ⚠️  Bot could not complete automatically (${statusLabel}). Browser stays open for 2 minutes so you can review/fix.`);
      } else {
        holdMs = 8000;
      }
      console.log(`\n   — Closing browser in ${Math.round(holdMs / 1000)}s...`);
      try {
        await page.waitForTimeout(holdMs);
      } catch {}
      try {
        await browser.close();
      } catch {}
      return status;
    } else if (!existingPage) {
      await discoverApplicationForm(page, url, { mode, profile });
    }

    const fills = plan.fills || plan.fields || [];
    let filled = 0, skipped = 0, errors = 0;

    for (const entry of fills) {
      const { value, type, label } = entry;
      if (value === undefined || value === null || value === '') {
        skipped++;
        continue;
      }

      const fieldName = label || entry.id || entry.selector || 'unknown';

      try {
        // ─── Types that locate elements themselves ──────────────────
        if (type === 'yes-no-button') {
          const clicked = await handleYesNoButton(page, entry, value);
          if (clicked) {
            console.log(`  ✅ Button: ${fieldName} ← "${value}"`);
            filled++;
            fieldResults.push({ field: fieldName, type, status: 'ok' });
          } else {
            console.log(`  ❌ Yes/No button not found: ${fieldName}`);
            errors++;
            fieldResults.push({ field: fieldName, type, status: 'not-found' });
          }
          await page.waitForTimeout(300 + Math.random() * 400);
          continue;
        }

        if (type === 'multi-select' && Array.isArray(value)) {
          const el = await findField(page, entry);
          if (!el) { errors++; continue; }
          await el.scrollIntoViewIfNeeded().catch(() => {});
          const ok = await handleMultiSelect(page, el, value, fieldName);
          if (ok) filled++; else errors++;
          await page.waitForTimeout(300 + Math.random() * 400);
          continue;
        }

        // ─── Find the element ───────────────────────────────────────
        const el = await findField(page, entry);
        if (!el) {
          // Checkbox fallback: find by label text
          if (type === 'checkbox') {
            const checkboxLabel = entry.label || entry.name || '';
            const cb = await page.$(`label:has-text("${checkboxLabel}") input[type="checkbox"]`);
            if (cb) {
              const isChecked = await cb.isChecked().catch(() => false);
              if (!isChecked && (value === true || value === 'true' || value === 'yes')) {
                await cb.click();
                console.log(`  ☑️  Checked (label): ${fieldName}`);
                filled++;
              }
              await page.waitForTimeout(300 + Math.random() * 400);
              continue;
            }
            const labelEl = await page.$(`label:has-text("${checkboxLabel}")`);
            if (labelEl) {
              await labelEl.click();
              console.log(`  ☑️  Checked (click label): ${fieldName}`);
              filled++;
              await page.waitForTimeout(300 + Math.random() * 400);
              continue;
            }
          }
          console.log(`  ❌ Not found: ${fieldName}`);
          errors++;
          fieldResults.push({ field: fieldName, type, status: 'not-found' });
          continue;
        }

        await el.scrollIntoViewIfNeeded().catch(() => {});

        // ─── Route to the right handler ─────────────────────────────
        if (type === 'file') {
          const filePath = findExistingResumeFile(value) || resolve(process.cwd(), value);
          if (!existsSync(filePath)) {
            console.log(`  ❌ File not found: ${value}`);
            errors++;
            continue;
          }
          await el.setInputFiles(filePath);
          console.log(`  📎 Uploaded: ${fieldName} ← ${basename(filePath)}`);
          filled++;

        } else if (type === 'checkbox') {
          if (value === true || value === 'true' || value === 'yes') {
            const isChecked = await el.isChecked().catch(() => false);
            if (!isChecked) { await el.click(); console.log(`  ☑️  Checked: ${fieldName}`); filled++; }
          } else { skipped++; }

        } else if (type === 'radio') {
          try {
            await page.click(`input[name="${entry.name}"][value="${value}"]`);
            console.log(`  ✅ Radio: ${fieldName} ← "${value}"`);
            filled++;
          } catch {
            try {
              await page.click(`label:has-text("${value}")`);
              console.log(`  ✅ Radio (label): ${fieldName} ← "${value}"`);
              filled++;
            } catch { console.log(`  ❌ Radio failed: ${fieldName}`); errors++; }
          }

        } else if (type === 'phone-country') {
          try {
            await el.click();
            await page.waitForTimeout(500);
            const searchInput = await page.$('.iti__search-input, input[role="combobox"][aria-label="Search"]');
            if (searchInput) { await searchInput.fill(value); await page.waitForTimeout(500); }
            const countryOpt = await page.$(`li[role="option"] .iti__country-name:has-text("${value}")`);
            if (countryOpt) {
              const li = await countryOpt.evaluateHandle(el => el.closest('li'));
              await li.click();
              console.log(`  ✅ Phone country: ${fieldName} ← "${value}"`);
              filled++;
            } else {
              const firstOpt = await page.$(`li[role="option"]:has-text("${value}")`);
              if (firstOpt) { await firstOpt.click(); filled++; }
              else { console.log(`  ❌ Phone country not found: ${value}`); errors++; }
            }
          } catch (err) { console.log(`  ❌ Phone country error: ${err.message}`); errors++; }

        } else if (type === 'typeahead') {
          try {
            const ok = await handleTypeahead(page, el, value, fieldName);
            if (ok) filled++; else errors++;
          } catch (err) { console.log(`  ❌ Typeahead error: ${fieldName} — ${err.message}`); errors++; }

        } else if (type === 'select' || type === 'custom-select' || type === 'dropdown') {
          const result = await handleDropdown(page, el, value, label);
          if (result.success) {
            console.log(`  ✅ Dropdown [${result.method}]: ${fieldName} ← "${value}"`);
            filled++;
          } else { console.log(`  ❌ Dropdown failed: ${fieldName}`); errors++; }

        } else {
          // Text / tel / email / textarea — check if secretly a dropdown
          const isReadonly = await el.evaluate(e => e.readOnly || e.getAttribute('aria-haspopup') || e.getAttribute('role') === 'combobox').catch(() => false);
          const couldBeDropdown = isReadonly || ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => (fieldName + entry.id).toLowerCase().includes(k));

          if (couldBeDropdown) {
            const result = await handleDropdown(page, el, value, label);
            if (result.success) {
              console.log(`  ✅ Auto-dropdown [${result.method}]: ${fieldName} ← "${value}"`);
              filled++;
            } else {
              try {
                await el.click({ clickCount: 3 }); await el.fill(value);
                console.log(`  ✅ Filled (fallback): ${fieldName} ← "${value.length > 50 ? value.substring(0, 50) + '...' : value}"`);
                filled++;
              } catch { console.log(`  ❌ Failed: ${fieldName}`); errors++; }
            }
          } else {
            try {
              await el.click(); await page.waitForTimeout(100); await el.fill(value);
              const display = value.length > 60 ? value.substring(0, 60) + '...' : value;
              console.log(`  ✅ Filled: ${fieldName} ← "${display}"`);
              filled++;
            } catch {
              try {
                await el.click({ clickCount: 3 }); await el.type(value, { delay: 30 });
                console.log(`  ✅ Typed: ${fieldName} ← "${value.length > 50 ? value.substring(0, 50) + '...' : value}"`);
                filled++;
              } catch (err) { console.log(`  ❌ Failed: ${fieldName} — ${err.message}`); errors++; }
            }
          }
        }

        await page.waitForTimeout(300 + Math.random() * 400);
        fieldResults.push({ field: fieldName, type, status: 'ok' });

      } catch (err) {
        console.log(`  ❌ Error on ${fieldName}: ${err.message}`);
        errors++;
        fieldResults.push({ field: fieldName, type, status: 'error', error: err.message });
      }
    }

    // ─── Dynamic fields ─────────────────────────────────────────────
    const dynamicFills = plan.dynamic_fills || [];
    if (dynamicFills.length > 0) {
      console.log(`\n  🔄 Filling ${dynamicFills.length} dynamic field(s)...`);
      await page.waitForTimeout(1500);
      for (const entry of dynamicFills) {
        const el = await findField(page, entry);
        if (el) {
          const result = await handleDropdown(page, el, entry.value, entry.label);
          if (result.success) {
            console.log(`  ✅ Dynamic [${result.method}]: ${entry.label} ← "${entry.value}"`);
            filled++;
          } else { console.log(`  ❌ Dynamic failed: ${entry.label}`); errors++; }
        }
        await page.waitForTimeout(500);
      }
    }

    // ─── VERIFICATION PASS ──────────────────────────────────────────
    console.log(`\n🔍 Verification pass — checking all fields...`);
    await page.waitForTimeout(1000);
    const allEntries = [...fills.filter(e => e.value), ...dynamicFills];
    let verifyFails = [];

    for (const entry of allEntries) {
      if (entry.type === 'file' || entry.type === 'yes-no-button' || entry.type === 'checkbox') continue;
      const el = await findField(page, entry);
      if (!el) continue;

      const fieldName = entry.label || entry.id || 'unknown';
      const isDropdownType = entry.type === 'dropdown' || entry.type === 'select' || entry.type === 'custom-select' ||
        ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => (fieldName + (entry.id || '')).toLowerCase().includes(k));

      let hasValue = false;
      if (isDropdownType) {
        hasValue = await verifyDropdownFilled(page, el, entry.value);
      } else {
        const currentVal = await el.inputValue().catch(() => '');
        hasValue = currentVal && currentVal.trim() !== '' && currentVal !== 'Select...' && currentVal !== 'Select';
      }

      if (!hasValue) {
        console.log(`  ⚠️  EMPTY: ${fieldName} — will retry`);
        verifyFails.push(entry);
      } else {
        console.log(`  ✓ OK: ${fieldName}`);
      }
    }

    // ─── RETRY failed fields ────────────────────────────────────────
    if (verifyFails.length > 0) {
      console.log(`\n🔄 Retrying ${verifyFails.length} unfilled field(s)...`);
      for (let retry = 1; retry <= 3; retry++) {
        if (verifyFails.length === 0) break;
        console.log(`\n  ── Retry pass ${retry}/3 ──`);
        await page.waitForTimeout(1000);

        const stillFailing = [];
        for (const entry of verifyFails) {
          const el = await findField(page, entry);
          if (!el) { stillFailing.push(entry); continue; }
          await el.scrollIntoViewIfNeeded().catch(() => {});

          const isDropdown = entry.type === 'dropdown' || entry.type === 'select' || entry.type === 'custom-select' ||
            ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => ((entry.label || '') + (entry.id || '')).toLowerCase().includes(k));

          let result;
          if (isDropdown) {
            await page.keyboard.press('Escape'); await page.waitForTimeout(300);
            result = await handleDropdown(page, el, entry.value, entry.label);
          } else {
            try {
              await el.click({ clickCount: 3 }); await page.waitForTimeout(100);
              await el.fill(entry.value);
              result = { success: true, method: 'retry-fill' };
            } catch { result = { success: false }; }
          }

          if (result.success) {
            await page.waitForTimeout(500);
            const verified = await verifyDropdownFilled(page, el, entry.value);
            if (verified) { console.log(`  ✅ Retry OK: ${entry.label}`); }
            else { stillFailing.push(entry); }
          } else { stillFailing.push(entry); }
          await page.waitForTimeout(500);
        }
        verifyFails = stillFailing;
      }

      if (verifyFails.length > 0) {
        console.log(`\n  ⚠️  ${verifyFails.length} field(s) could not be filled after retries:`);
        verifyFails.forEach(e => console.log(`    - ${e.label || e.id}`));
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`✅ Fill + verify complete: ${filled} filled, ${skipped} skipped, ${errors} errors`);

    await takeScreenshot(page, 'pre-submit');

    // ─── SUBMIT + ERROR RETRY LOOP ──────────────────────────────────
    let status = 'filled-not-submitted';
    // This fallback path never submits by itself — only --confirm-submit unlocks it.
    const submitAttempts = confirmSubmit ? 3 : 0;
    if (!submitAttempts) {
      console.log('\n  🛑 Form filled but NOT submitted — review it in the browser (pass --confirm-submit to allow submitting here).');
    }
    for (let submitAttempt = 1; submitAttempt <= submitAttempts; submitAttempt++) {
      console.log(`\n🚀 Submit attempt ${submitAttempt}/${submitAttempts}...`);
      const submitted = await clickSubmitButton(page, { allowSubmit: true });
      if (!submitted) { status = 'no-submit-button'; break; }

      await page.waitForTimeout(3000);

      const errorMessages = await page.evaluate(() => {
        const errs = [];
        document.querySelectorAll('.error, .field-error, .error-message, .invalid-feedback, [class*="error"], [class*="Error"], [role="alert"], .field--error, .has-error, .form-error').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 200 && text.length > 2) errs.push(text);
        });
        return [...new Set(errs)];
      });

      if (errorMessages.length === 0) {
        const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (/verification\s*code|enter.*code|confirm.*human|code\s*was\s*sent/i.test(bodyText)) {
          console.log('Post-submit verification appeared — mailbox OTP is not connected (Zoho Mail can be added later).');
          status = 'needs-manual-verification';
        } else { status = 'submitted'; }
        break;
      }

      console.log(`  ❌ ${errorMessages.length} validation error(s):`);
      errorMessages.forEach(e => console.log(`    • ${e}`));
      await takeScreenshot(page, `submit-error-${submitAttempt}`);

      // Detect newly-revealed required fields (Workday conditional selects)
      const newSelects = await page.$$('select');
      for (const sel of newSelects) {
        const selId = await sel.getAttribute('id').catch(() => '');
        const isAlreadyFilled = await sel.evaluate(e => e.value && e.value !== '').catch(() => false);
        if (!isAlreadyFilled && selId) {
          const labelEl = await page.$(`label[for="${selId}"]`);
          const labelText = labelEl ? (await labelEl.textContent().catch(() => '')).replace(/\*+/g, '').trim() : '';
          if (labelText && /source/i.test(labelText)) {
            console.log(`  🔧 Filling conditional select: ${labelText}...`);
            try {
              await sel.selectOption({ label: 'Workday.com' });
              console.log(`  ✅ Conditional select: ${labelText} ← "Workday.com"`);
            } catch {
              try {
                await sel.selectOption({ label: 'Website' });
                console.log(`  ✅ Conditional select: ${labelText} ← "Website"`);
              } catch {
                // Try first non-empty option
                const opts = await sel.evaluate(e => Array.from(e.options).filter(o => o.value).map(o => ({ v: o.value, t: o.text })));
                if (opts.length > 0) {
                  await sel.selectOption({ value: opts[0].v });
                  console.log(`  ✅ Conditional select: ${labelText} ← "${opts[0].t}"`);
                }
              }
            }
          }
        }
      }

      // Re-fill empty fields from plan
      for (const entry of [...fills.filter(e => e.value), ...dynamicFills]) {
        if (entry.type === 'file') continue;
        const el = await findField(page, entry);
        if (!el) continue;
        const isDD = ['dropdown', 'select', 'custom-select'].includes(entry.type) ||
          ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => ((entry.label || '') + (entry.id || '')).toLowerCase().includes(k));
        if (isDD) { if (await verifyDropdownFilled(page, el, entry.value)) continue; }
        else { const v = await el.inputValue().catch(() => ''); if (v && v.trim() !== '' && v !== 'Select...') continue; }

        console.log(`  🔧 Re-filling: ${entry.label || entry.id}...`);
        if (isDD) {
          await page.keyboard.press('Escape'); await page.waitForTimeout(300);
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await handleDropdown(page, el, entry.value, entry.label);
        } else {
          try { await el.click({ clickCount: 3 }); await el.fill(entry.value); } catch {}
        }
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1000);
    }

    const postSubmitSS = await takeScreenshot(page, 'post-submit');
    await logToCSV(url, plan.company || '', plan.role || '', status, postSubmitSS, { ats });

    // Record for learner
    try {
      await recordResult(url, plan, status, fieldResults);
    } catch { /* non-critical */ }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🏁 Result: ${status}`);
    console.log(`   Screenshots: screenshots/`);
    console.log(`   Report: data/applied.csv`);
    console.log(`${'─'.repeat(60)}`);

    console.log(`\n   — Closing browser...`);
    try {
      if (!isBatch) await page.waitForTimeout(5000);
    } catch {}
    try { await browser.close(); } catch {}
    return status;

  } catch (err) {
    const timestamp = new Date().toISOString();
    const errorUrl = activeProfile?._canonicalJobUrl || activeProfile?._jobUrl || url;

    console.error(`\n❌ [${timestamp}] Fill failed on ${errorUrl}: ${err.message}`);
    await recordClientApplication(activeProfile || {}, {
      url: errorUrl,
      status: 'failed',
      failureReason: err.message,
    }).catch(() => {});

    if (!isBatch && page && !page.isClosed()) {
      try {
        console.log('   Pausing 10s on error page for visual inspection...');
        await page.waitForTimeout(10000);
      } catch {}
    }

    if (browser) {
      try { await browser.close(); } catch {}
    }
    return 'incomplete';
  }
}
