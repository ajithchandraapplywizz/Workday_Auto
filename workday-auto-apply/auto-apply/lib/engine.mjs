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
import { discoverApplicationForm, detectATS } from './discovery.mjs';
import { findField, handleDropdown, handleHierarchicalDropdown, handleSearchableDropdown, clickVisiblePromptOption, verifyDropdownFilled, fuzzyScore } from './fields.mjs';
import { takeScreenshot, logToCSV } from './reporter.mjs';
import { recordResult } from './learner.mjs';
import { isSubmitButton } from './scanner.mjs';
import { handleWorkday } from './workday.mjs';
import { loadProfile, mapLabelToProfileValue, resolveField } from './planner.mjs';
import { saveAnswerToYaml, normalizeLabel, createQAStore, isComplianceSensitive } from './qaStore.mjs';
import { detectWorkdayStep } from './stateDetector.mjs';
import {
  handleWorkdayFormFieldQuestions,
  handleVoluntaryDisclosuresStep,
  handleSelfIdentifyStep,
} from './workdayQuestionFill.mjs';
import {
  fillSourceFieldAuto,
  getReferralSourceDisplay,
  isReferralSourceFullySelected,
  SOURCE_LABEL,
} from './workdaySource.mjs';
import { handleStep2MyExperience } from './workdayExperience.mjs';
import { fillCityFromDom, getCityInputValue, cityValueMatches, CITY_LABEL, resolveCityValue } from './workdayCity.mjs';
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
} from './workdayDom.mjs';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

function recordFilled(profile, label, value) {
  if (!profile) return;
  if (!profile._filledValues) profile._filledValues = {};
  if (label) profile._filledValues[label] = value;
}

function isUnimportantWorkdayField(label) {
  const n = String(label || '').toLowerCase();
  return /middle name|local given|local family|local middle|phone extension|preferred name|suffix|prefix|address line 2|facebook|twitter|x\.com|social profile|social link/i.test(n);
}

function isRequiredQuestionLabel(label, field = {}) {
  const text = String(label || '');
  const lower = text.toLowerCase();
  if (field.required || field.ariaRequired || field.required === true) return true;
  if (/\*/.test(text)) return true;
  if (/\brequired\b/i.test(lower) || /\bmandatory\b/i.test(lower) || /\bmust\s+be\s+filled\b/i.test(lower)) return true;
  return false;
}

function shouldPromptForUnknownField(label = '', field = {}) {
  const text = String(label || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  if (/facebook|twitter|x\.com|social media|social profile|social link/i.test(lower)) return false;
  if (/optional|voluntary|not required|if you would like|if applicable|additional attachment|cover letter|upload a file|drop files here|select files|employee\s*id.*if applicable/i.test(lower)) {
    return false;
  }
  return true;
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
export async function promptUserInTerminal(label, fieldType, options = [], { company, compliance, domCode, role, placeholder } = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const inferredType = fieldType || 'input';
    const domSig = domCode || 'unknown';
    console.log('\n──────────────────────────────────────────');
    console.log(compliance ? '🔒 Unknown required compliance question' : '⚠ Unknown required question');
    if (company) console.log(`Company:  ${company}`);
    console.log(`Question: "${label || '(untitled field)'}"`);
    console.log(`DOM code / id: ${domSig}`);
    console.log(`UI design: ${inferredType}`);
    if (role) console.log(`Role: ${role}`);
    if (placeholder) console.log(`Placeholder: ${placeholder}`);
    if (options && options.length > 0) {
      console.log(`Options: [${options.slice(0, 12).join(', ')}]`);
    }
    console.log('Type your answer below and press Enter to paste it into the live Workday page.');
    console.log('(Your answer will be saved permanently for future applications.)');
    console.log('──────────────────────────────────────────');
    const answer = await rl.question('> Your answer:\n');
    const trimmed = answer.trim();
    if (trimmed) {
      await saveAnswerToYaml(label, trimmed).catch(() => {});
    }
    return trimmed;
  } catch {
    return '';
  } finally {
    rl.close();
  }
}

// ─── Workday "Add" Button Expander ──────────────────────────────────────────
async function handleWorkdayAddButtons(page, stepName, profile) {
  if (stepName === 'My Experience') {
    const hasJobTitleInput = await page.locator('input[data-automation-id*="jobTitle"], input[id*="jobTitle"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!hasJobTitleInput) {
      const addExpBtn = await page.$('[data-automation-id="workExperienceSection"] button[data-automation-id="Add"], button:has-text("Add Work Experience"), button:has-text("Add Experience")');
      if (addExpBtn && await addExpBtn.isVisible().catch(() => false)) {
        console.log('    ➕ Expanding Work Experience section (clicking Add)...');
        await interactAndRescan(page, async () => {
          await addExpBtn.click({ force: true }).catch(() => addExpBtn.evaluate(el => el.click()));
        });
      }
    }

    const hasSchoolInput = await page.locator(
      'input[data-automation-id*="school"], input[id*="school"], [data-automation-id*="education"] [role="combobox"], [data-automation-id*="education"] button[aria-haspopup="listbox"]'
    ).first().isVisible({ timeout: 500 }).catch(() => false);
    if (!hasSchoolInput) {
      const addEduBtn = await page.$('button[data-automation-id*="Add"]:has-text("Education"), button:has-text("Add Education"), [data-automation-id="educationSection"] button[data-automation-id="Add"]');
      if (addEduBtn && await addEduBtn.isVisible().catch(() => false)) {
        console.log('    ➕ Expanding Education section (clicking Add)...');
        await interactAndRescan(page, async () => {
          await addEduBtn.click({ force: true }).catch(() => addEduBtn.evaluate(el => el.click()));
        });
      }
    }

    // Websites: handled in handleWebsitesSection() — never click Add / Add another here
  }
}

// ─── Workday Resume Upload with Async Verification ──────────────────────────
async function handleWorkdayResumeUpload(page, resumePath) {
  if (!resumePath) return false;
  const absPath = resolve(process.cwd(), resumePath);
  if (!existsSync(absPath)) {
    console.log(`    ⚠️  Resume file not found at: ${absPath}`);
    return false;
  }

  // Check if file is already uploaded
  const existingFileItem = await page.$('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [class*="file-upload-item"], [data-automation-id="delete-file"]');
  if (existingFileItem && await existingFileItem.isVisible().catch(() => false)) {
    const existingName = await existingFileItem.textContent().catch(() => '');
    console.log(`    📎 Resume already uploaded: "${existingName.trim()}"`);
    return true;
  }

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    const resumeUploadSectionMatches = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return /resume\s*\/\s*cv|resume|upload a file|drop files here|select files/i.test(text);
    });
    if (!resumeUploadSectionMatches) return false;

    const resumeLabel = page.locator('label, legend').filter({ hasText: /resume|cv|upload a file|drop files here|select files/i }).first();
    const controlled = resumeLabel.locator('..').locator('input[type="file"]').first();
    if (await controlled.count().catch(() => 0) === 0) return false;
    const fileElement = controlled;
    console.log(`    📎 Uploading resume via labeled file control: ${basename(absPath)}...`);
    await fileElement.setInputFiles(absPath);

    console.log('    ⏳ Waiting for Workday file upload to complete...');
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const uploadedItem = await page.$('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [data-automation-id="delete-file"]');
      const successText = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        return /successfully\s*uploaded/i.test(body) || /100%/i.test(body);
      }).catch(() => false);
      if (uploadedItem || successText) {
        console.log('    ✅ Resume uploaded successfully (verified)!');
        await waitForDomSettled(page);
        await discoverWorkdayFields(page);
        return true;
      }
    }
    console.log('    ⚠️  Resume upload wait finished — continuing...');
    return true;
  }

  console.log(`    📎 Uploading resume: ${basename(absPath)}...`);
  await fileInput.setInputFiles(absPath);

  // Wait for upload progress to finish and confirmation item to appear
  console.log('    ⏳ Waiting for Workday file upload to complete...');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const uploadedItem = await page.$('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [data-automation-id="delete-file"]');
    const successText = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return /successfully\s*uploaded/i.test(body) || /100%/i.test(body);
    }).catch(() => false);

    if (uploadedItem || successText) {
      console.log('    ✅ Resume uploaded successfully (verified)!');
      await waitForDomSettled(page);
      await discoverWorkdayFields(page);
      return true;
    }
  }

  console.log('    ⚠️  Resume upload wait finished — continuing...');
  return true;
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
        await saveAnswerToYaml(SOURCE_LABEL, selected).catch(() => {});
        recordFilled(profile, SOURCE_LABEL, selected);
      } else {
        console.log(`    ⚠️  Field 1: source not verified in DOM ("${verifiedDisplay || '(empty)'}") — continuing without terminal prompt`);
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
      .or(page.locator('fieldset').filter({ hasText: /previously worked.*workday/i }))
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
      console.log('    ✅ Field 2 Complete: previous worker = "No"');
      recordFilled(profile, 'Previous Worker', 'No');
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
      }
    }
  } catch {}

  console.log('  🎯 [Field 3/4] Resolving Country / Territory Phone Code...');
  try {
    const countryCodeValue = profile?.personal?.country_phone_code
      || profile?.personal?.country
      || 'India (+91)';
    const { searchTerm, optionText } = parseCountryPhoneCode(countryCodeValue);
    const query = (searchTerm || 'india').split(/\s+/)[0];

    const clearBtn = page.locator('[data-automation-id="country-phone-code"] [data-automation-id="delete-item"], #phoneNumber--countryPhoneCode [data-automation-id="delete-item"], [data-automation-id="country-phone-code"] [data-automation-id="clear-button"]').first();
    if (await clearBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      await interactAndRescan(page, async () => {
        await clearBtn.click({ force: true });
      });
    }

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

      const alreadySelected = /india/i.test(currentCode) && /\+91/i.test(currentCode);
      if (!alreadySelected) {
        await interactAndRescan(page, async () => {
          await countryPhoneCodeControl.scrollIntoViewIfNeeded().catch(() => {});
          await countryPhoneCodeControl.click({ force: true }).catch(() => countryPhoneCodeControl.evaluate(el => el.click()));
        });

        // Manual equivalent: search "india" then press Enter
        const result = await handleSearchableDropdown(page, countryPhoneCodeControl, query, optionText, { confirmWithEnter: true, alreadyOpen: true });
        if (!result.success) {
          const clicked = await clickVisiblePromptOption(page, ['India (+91)', 'India +91', 'India', optionText, query]);
          if (clicked) {
            await page.keyboard.press('Enter').catch(() => {});
            console.log(`    ✓ Country option via DOM text: "${clicked}"`);
          } else {
            await page.keyboard.type(query, { delay: 40 });
            await page.keyboard.press('Enter');
          }
        }

        await waitForDomSettled(page);
        const verified = ((await countryPhoneCodeControl.innerText().catch(() => '')) ||
          (await countryPhoneCodeControl.textContent().catch(() => '')) || '').trim();
        console.log(`    ✅ Field 3 Complete: searched "${query}" + Enter → "${verified || optionText}"`);
        recordFilled(profile, 'Country / Territory Phone Code', optionText);
        await discoverWorkdayFields(page);
      } else {
        console.log(`    ✓ Country Phone Code already set: "${currentCode}"`);
        recordFilled(profile, 'Country / Territory Phone Code', currentCode);
      }
    }
  } catch (err) {
    console.log(`    ⚠️  Field 3 warning: ${err.message?.substring(0, 100)}`);
  }

  console.log('  🎯 [Field 4/4] Resolving Phone Number...');
  try {
    const phoneValue = profile?.personal?.phone || profile?.phone;
    if (!phoneValue) {
      throw new Error('profile.personal.phone is required');
    }

    const phoneNumberInput = page.locator('input[data-automation-id="phone-number"], input#phoneNumber--phoneNumber, input[id*="phoneNumber--phoneNumber"], input[name="phoneNumber"], input[type="tel"]')
      .or(page.getByRole('textbox', { name: /^phone number/i }))
      .or(page.getByLabel('Phone Number', { exact: true }))
      .first();

    if (await phoneNumberInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await interactAndRescan(page, async () => {
        await phoneNumberInput.scrollIntoViewIfNeeded().catch(() => {});
        await phoneNumberInput.fill(String(phoneValue).trim());
      });
      const verified = await phoneNumberInput.inputValue().catch(() => '');
      if (String(verified).replace(/\D/g, '') !== String(phoneValue).replace(/\D/g, '')) {
        console.log(`    ⚠️  Phone verify mismatch: expected ${phoneValue}, got ${verified}`);
      } else {
        console.log(`    ✅ Field 4 Complete: Phone Number "${phoneValue}"`);
      }
      recordFilled(profile, 'Phone Number', String(phoneValue).trim());
    }
  } catch (err) {
    console.log(`    ⚠️  Field 4 warning: ${err.message?.substring(0, 100)}`);
  }

  try {
    const postalInput = page.locator('input[data-automation-id*="postalCode"], input#address--postalCode, input[id*="postalCode"]')
      .or(page.getByLabel('Postal Code', { exact: false }))
      .first();
    if (await postalInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const pin = indiaSixDigitPostal(profile);
      await interactAndRescan(page, async () => { await postalInput.fill(pin); });
      recordFilled(profile, 'Postal Code', pin);
      console.log(`    📮 Postal Code set to 6-digit PIN "${pin}"`);
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

    if (!citySuccess) {
      const userCity = await promptUserInTerminal(CITY_LABEL, 'input', [], {
        company: profile?._company || profile?.company || 'Workday',
        compliance: false,
        domCode: 'address--city',
        role: 'textbox',
      });
      if (userCity) {
        profile.personal = profile.personal || {};
        profile.personal.city = userCity.trim();
        profile.qa_answers = profile.qa_answers || {};
        profile.qa_answers.city = userCity.trim();
        await saveAnswerToYaml(CITY_LABEL, userCity.trim()).catch(() => {});
        const retry = await fillCityFromDom(page, profile);
        const domAfter = await getCityInputValue(page);
        if (retry.success && cityValueMatches(domAfter, userCity)) {
          console.log(`    ✅ City applied from terminal: "${domAfter}"`);
          recordFilled(profile, CITY_LABEL, domAfter);
          citySuccess = true;
        }
      }
    }

    if (!citySuccess) {
      console.log(`    ⚠️  City is required but could not be verified in DOM (wanted "${resolveCityValue(profile)}")`);
    }
  } catch (err) {
    console.log(`    ⚠️  City field warning: ${err.message?.substring(0, 100)}`);
  }

  try {
    const textFields = [
      { label: 'Given Name', keys: ['personal.first_name', 'first_name'] },
      { label: 'Family Name', keys: ['personal.last_name', 'last_name'] },
      { label: 'Address Line 1', keys: ['personal.address_line1', 'address_line1'] },
    ];
    for (const tf of textFields) {
      const inputEl = page.getByLabel(tf.label, { exact: false }).first();
      if (await inputEl.isVisible({ timeout: 400 }).catch(() => false)) {
        const val = await inputEl.inputValue().catch(() => '');
        if (!val || val.trim() === '') {
          let fillVal = '';
          for (const k of tf.keys) {
            const v = k.includes('.') ? k.split('.').reduce((o, i) => o?.[i], profile) : profile?.[k];
            if (v) { fillVal = String(v); break; }
          }
          if (fillVal) {
            await interactAndRescan(page, async () => { await inputEl.fill(fillVal).catch(() => {}); });
            recordFilled(profile, tf.label, fillVal);
          }
        }
      }
    }
  } catch {}

  await fillWorkdayFieldsFromScan(page, profile, plan, 'My Information');

  try {
    const postalInput = page.locator('input[data-automation-id*="postalCode"], input#address--postalCode, input[id*="postalCode"]')
      .or(page.getByLabel('Postal Code', { exact: false }))
      .first();
    if (await postalInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const pin = indiaSixDigitPostal(profile);
      await interactAndRescan(page, async () => { await postalInput.fill(pin); });
      recordFilled(profile, 'Postal Code', pin);
      console.log(`    📮 Postal Code set to 6-digit PIN "${pin}"`);
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
    try {
      if (field.name) {
        await page.click(`input[name="${field.name}"][value="${mappedVal}"]`, { force: true });
      } else {
        await page.getByRole('radio', { name: new RegExp(`^${String(mappedVal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first().click({ force: true });
      }
    } catch {
      await page.click(`label:has-text("${mappedVal}")`, { force: true }).catch(() => {});
    }
    console.log(`    ✅ Radio: ${label} ← "${mappedVal}"`);
    recordFilled(profile, label, mappedVal);
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
 */
async function fillWorkdayFieldsFromScan(page, profile, plan, stepName) {
  const qaStore = createQAStore();
  let fields = await discoverWorkdayFields(page);
  console.log(`  🔍 DOM scan: ${fields.length} visible field(s) on "${stepName}"`);
  let stepFilled = 0;
  const company = profile?._company || profile?.company;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.disabled) continue;
    if (field.type === 'file') continue;

    const label = field.label || field.id;
    if (isUnimportantWorkdayField(label)) continue;
    const norm = normalizeLabel(label);
    if (profile._filledValues && Object.keys(profile._filledValues).some(k => {
      const kn = normalizeLabel(k);
      return kn === norm || norm.includes(kn) || kn.includes(norm);
    })) continue;
    if (/how did you hear|previous(ly)? work|country.*phone code|phone number/i.test(String(label)) && stepName === 'My Information') continue;
    if (/vibe philosophy|recruitment privacy statement.*vibe/i.test(String(label))) continue;

    const isRequired = isRequiredQuestionLabel(label, field);
    let mappedVal = await resolveField(field, profile, qaStore, {
      skipPrompt: false,
      plan,
      company,
      resumePath: plan?.resume || profile?._resumePath,
      url: plan?.url || page.url(),
    });
    if (/postal/i.test(String(label)) && mappedVal) {
      const countryHint = `${profile?.personal?.country_phone_code || ''} ${profile?.personal?.country || ''}`;
      if (/india|\+91/i.test(countryHint)) mappedVal = indiaSixDigitPostal(profile);
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

// ─── Fill Current Workday Step ──────────────────────────────────────────────
async function fillCurrentWorkdayStep(page, stepName, profile, plan) {
  console.log(`\n  📝 [Workday] Filling Step: "${stepName}"...`);

  if (stepName === 'My Information') {
    return await handleStep1MyInformation(page, profile, plan);
  }

  if (stepName === 'My Experience') {
    await handleWorkdayAddButtons(page, stepName, profile);
    const resumePath = plan?.resume || profile?.resume || profile?._resumePath;
    if (resumePath) {
      await handleWorkdayResumeUpload(page, resumePath);
    }
    await handleStep2MyExperience(page, profile);
    const formFieldFilled = await handleWorkdayFormFieldQuestions(page, profile, stepName);
    if (formFieldFilled > 0) {
      console.log(`    📋 formField DOM: ${formFieldFilled} answer(s) applied from profile.yml / qa_answers`);
    }
    await fillWorkdayFieldsFromScan(page, profile, plan, stepName);
    return;
  }

  await handleWorkdayAddButtons(page, stepName, profile);

  const resumePath = plan?.resume || profile?.resume || profile?._resumePath;
  const resumeSectionText = await page.evaluate(() => {
    const label = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return /resume\s*\/\s*cv|resume|upload a file|drop files here|select files/i.test(label);
  }).catch(() => false);

  if (resumeSectionText && resumePath && stepName !== 'My Experience') {
    await handleWorkdayResumeUpload(page, resumePath);
  }

  if (stepName === 'Voluntary Disclosures') {
    await handleVoluntaryDisclosuresStep(page, profile);
  }

  if (stepName === 'Self Identify') {
    const selfIdFilled = await handleSelfIdentifyStep(page, profile);
    if (selfIdFilled > 0) {
      console.log(`    📋 Self Identify: ${selfIdFilled} field(s) filled (name / date / disability)`);
    }
  }

  // Pure-DOM formField fill on every step — reads question text from page, answers from profile.yml
  const formFieldFilled = await handleWorkdayFormFieldQuestions(page, profile, stepName);
  if (formFieldFilled > 0) {
    console.log(`    📋 formField DOM: ${formFieldFilled} answer(s) applied from profile.yml / qa_answers`);
  }

  await fillWorkdayFieldsFromScan(page, profile, plan, stepName);
}


// ─── Workday Step Advance (Save and Continue) ───────────────────────────────
async function advanceWorkdayStep(page) {
  const saveBtnSelectors = [
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button[data-automation-id*="next" i]',
    'button[data-automation-id*="continue" i]',
    'button[data-automation-id="bottom-navigation-next-button"]',
    'button[data-automation-id="page-footer-next-button"]',
  ];

  let saveBtn = null;
  for (const sel of saveBtnSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible().catch(() => false)) {
      saveBtn = btn;
      break;
    }
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
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await waitForDomSettled(page);

  const errorMessages = await page.evaluate(() => {
    const errs = [];
    document.querySelectorAll('.error, .field-error, .error-message, .invalid-feedback, [class*="error"], [class*="Error"], [role="alert"], [data-automation-id*="error"]').forEach(el => {
      const text = (el.textContent || '').trim();
      if (text && text.length < 200 && text.length > 2) errs.push(text);
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
  const result = await advanceWorkdayStep(page);
  if (!result.hasSaveButton) return { ...result, transitioned: false, step: before };
  if (result.hasErrors) return { ...result, transitioned: false, step: before };

  for (let i = 0; i < 5; i++) {
    await waitForDomSettled(page);
    const next = await detectWorkdayStep(page);
    if (next !== before || next === 'Review') {
      console.log(`  ✓ Step transitioned: "${before}" → "${next}"`);
      return { ...result, transitioned: true, step: next };
    }
    await page.waitForTimeout(2000);
  }

  console.log(`  ⚠️  Step did not change after Save and Continue (still "${before}")`);
  return { ...result, transitioned: false, step: before };
}

async function confirmSubmitInTerminal(autoConfirm) {
  if (autoConfirm) return true;
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n──────────────────────────────────────────');
    console.log('Review step complete. Ready to submit.');
    const answer = await rl.question('Should I submit the application? [y/N]\n> ');
    console.log('──────────────────────────────────────────\n');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function verifyAndSubmitReview(page, profile, { confirmSubmit = false } = {}) {
  console.log('\n📋 Review step — parsing DOM before submit.');
  await takeScreenshot(page, 'workday-review-step');
  await attachFormMutationObserver(page);
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

  const ok = await confirmSubmitInTerminal(confirmSubmit);
  if (!ok) {
    console.log('  ✋ Submit cancelled — browser left open for manual review.');
    return 'review-pending-confirmation';
  }

  console.log('🚀 Clicking final "Submit" button...');
  await clickSubmitButton(page);
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
    return 'submitted';
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/verification\s*code|enter.*code|confirm.*human|code\s*was\s*sent/i.test(bodyText)) {
    console.log('Post-submit verification detected, but OTP handling is disabled. Please verify manually if required.');
    return 'needs-manual-verification';
  }

  return 'submitted';
}

// ─── Workday 5-Step Wizard Loop ─────────────────────────────────────────────
export async function runWorkdayWizardLoop(page, profile, plan, { otpEmail, otpPassword, confirmSubmit = false } = {}) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`STARTING WORKDAY WIZARD LOOP (DOM-first)`);
  console.log(`${'═'.repeat(60)}`);

  if (!profile?.personal?.phone) {
    console.error('❌ profile.personal.phone is required in config/profile.yml');
    return 'incomplete';
  }

  const maxSteps = 12;
  let currentIteration = 0;
  let lastStep = '';
  let sameStepCount = 0;

  while (currentIteration < maxSteps) {
    currentIteration++;

    const refreshed = await refreshWorkdayPageOnce(page);
    const stepName = await detectWorkdayStep(page);
    if (refreshed) {
      console.log(`\n📍 [Wizard Step ${currentIteration}] Page refreshed; re-detected Page: "${stepName}"`);
    } else {
      console.log(`\n📍 [Wizard Step ${currentIteration}] Detected Page: "${stepName}"`);
    }

    if (stepName === lastStep) {
      sameStepCount++;
      if (sameStepCount >= 6) {
        console.log(`  ⚠️  Stuck on "${stepName}" for 6 iterations — stopping.`);
        return 'incomplete';
      }
    } else {
      sameStepCount = 0;
      lastStep = stepName;
    }

    if (stepName === 'Review') {
      return await verifyAndSubmitReview(page, profile, { confirmSubmit });
    }

    await detachFormMutationObserver(page);
    await attachFormMutationObserver(page);
    await discoverWorkdayFields(page);

    await fillCurrentWorkdayStep(page, stepName, profile, plan);
    await takeScreenshot(page, `workday-step-${currentIteration}-${stepName.replace(/\s+/g, '-').toLowerCase()}`);

    console.log('  ➡️  Save and Continue (important fields filled; skipping unimportant).');
    const advanceResult = await advanceWorkdayStepWithVerification(page, stepName);

    if (!advanceResult.hasSaveButton) {
      const maybeReview = await detectWorkdayStep(page);
      if (maybeReview === 'Review') {
        return await verifyAndSubmitReview(page, profile, { confirmSubmit });
      }
      console.log('  ℹ️  No "Save and Continue" button found — checking next pass...');
    }

    if (advanceResult.hasErrors || !advanceResult.transitioned) {
      const errs = (advanceResult.errors || []).join(' ');
      if (/postal code must be 6 digits/i.test(errs)) {
        const postalInput = page.locator('input[data-automation-id*="postalCode"], input#address--postalCode').or(page.getByLabel('Postal Code', { exact: false })).first();
        if (await postalInput.isVisible().catch(() => false)) {
          const pin = indiaSixDigitPostal(profile);
          await postalInput.fill(pin);
          console.log(`    📮 Retry postal as 6-digit PIN: ${pin}`);
        }
      }
      await fillCurrentWorkdayStep(page, stepName, profile, plan);
      await advanceWorkdayStepWithVerification(page, stepName);
    }
  }

  const finalStep = await detectWorkdayStep(page);
  if (finalStep === 'Review') {
    return await verifyAndSubmitReview(page, profile, { confirmSubmit });
  }
  return 'incomplete';
}


// Adaptive scan/fill loop — OTP handling disabled
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
      const mappedVal = mapLabelToProfileValue(label, profile);
      if (!mappedVal) {
        const shouldPrompt = shouldPromptForUnknownField(label, f);
        if (shouldPrompt) {
          const answer = await promptUserInTerminal(label, f.type, [], {
            company,
            domCode: f.id || f.name || f.selector || 'unknown',
            role: f.role || (f.type === 'select' ? 'combobox' : undefined),
            placeholder: f.placeholder,
          });
          if (answer) {
            try {
              const el = await findField(page, f);
              if (el) { await el.fill(answer); anyAction = true; }
            } catch (err) { console.log(`Could not fill required field "${label}": ${err.message?.slice(0,80)}`); }
          }
        }
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
            await el.setInputFiles(mappedVal).catch(() => {});
            anyAction = true;
            console.log(`Uploaded file for: ${label}`);
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
        'button:has-text("Create")',
        'button:has-text("Save and Continue")',
        'button:has-text("Save & Continue")',
        'button:has-text("Submit")',
        'button:has-text("Submit application")',
        'input[type="submit"]',
        'button[type="submit"]'
      ];
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
      console.log('Review page detected, attempting final submit...');
      await clickSubmitButton(page).catch(() => {});
      await page.waitForTimeout(4000);
      const confirmText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/application\s*submitted|thank\s*you\s*for\s*applying|submission\s*complete/i.test(confirmText)) {
        console.log('Submission confirmed.');
        return 'submitted';
      } else {
        console.log('No clear submission confirmation detected after final submit attempt.');
      }
    }

    // 6) Detect verification prompts and exit for manual verification
    if (/verification\s*code|confirm.*email|check your email|enter.*code/i.test(bodyText)) {
      console.log('Verification prompt detected, but OTP auto-handling is disabled in this build. Please verify manually if required.');
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
async function clickSubmitButton(page) {
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
export async function fillForm(url, plan, { otpEmail, otpPassword, workdayEmail, workdayPassword, mode = 'signin', browser: existingBrowser, context: existingContext, page: existingPage, confirmSubmit = false } = {}) {
  console.log(`📝 Fill mode: ${url}`);
  if (otpEmail) console.log(`📧 OTP auto-fetch: ${otpEmail}`);

  const ats = detectATS(url);
  const ownBrowser = !existingBrowser;
  const browser = existingBrowser || await chromium.launch({ headless: false });
  const context = existingContext || (existingBrowser ? await browser.newContext() : await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }));
  const page = existingPage || await context.newPage();

  const fieldResults = []; // for learner

  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('data:')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* partial load OK */ }
      await page.waitForTimeout(2000);
    }

    // Handle Workday multi-step wizard
    if (ats === 'workday') {
      const isAlreadyOnWizard = await page.$([
        'button:has-text("Save and Continue")',
        'button:has-text("Save & Continue")',
        'button[data-automation-id="bottom-navigation-next-button"]',
        'input[data-automation-id="legalNameSection_firstName"]',
        '[data-automation-id*="wizardStep"]',
      ].join(', ')).catch(() => null);

      if (!isAlreadyOnWizard || !await isAlreadyOnWizard.isVisible().catch(() => false)) {
        const wdOk = await handleWorkday(page, {
          email: workdayEmail || otpEmail,
          password: workdayPassword,
          otpEmail,
          otpPassword,
          mode,
        });
        if (!wdOk) {
          console.log('  ❌ Workday authentication could not be confirmed — aborting wizard loop.');
          if (ownBrowser) await browser.close();
          return 'auth-failed';
        }
      }
      console.log('  ✅ Workday authentication confirmed — starting 5-step wizard loop...');
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1000);

      // Load profile and execute complete 5-step wizard loop
      const profile = await loadProfile().catch(() => ({}));
      const status = await runWorkdayWizardLoop(page, profile, plan, { otpEmail, otpPassword, confirmSubmit });

      const postSubmitSS = await takeScreenshot(page, 'post-submit');
      await logToCSV(url, plan.company || '', plan.role || '', status, postSubmitSS, { ats });

      try {
        await recordResult(url, plan, status, fieldResults);
      } catch { /* non-critical */ }

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🏁 Result: ${status}`);
      console.log(`   Screenshots: screenshots/`);
      console.log(`   Report: data/applied.csv`);
      console.log(`${'─'.repeat(60)}`);

      console.log(`\n   — Ctrl+C to keep it open longer.`);
      await page.waitForTimeout(15000);
      await browser.close();
      return status;
    } else if (!existingPage) {
      await discoverApplicationForm(page, url, { mode });
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
          const filePath = resolve(process.cwd(), value);
          if (!existsSync(filePath)) {
            console.log(`  ❌ File not found: ${value}`);
            errors++;
            continue;
          }
          await el.setInputFiles(filePath);
          console.log(`  📎 Uploaded: ${fieldName} ← ${basename(value)}`);
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
    for (let submitAttempt = 1; submitAttempt <= 3; submitAttempt++) {
      console.log(`\n🚀 Submit attempt ${submitAttempt}/3...`);
      const submitted = await clickSubmitButton(page);
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
          console.log('Post-submit verification detected, but OTP handling is disabled. Please verify manually if required.');
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

    console.log(`\n   — Ctrl+C to keep it open longer.`);
    await page.waitForTimeout(15000);
    await browser.close();
    return status;

  } catch (err) {
    const timestamp = new Date().toISOString();
    let errorUrl = url;
    try {
      if (page && !page.isClosed()) errorUrl = page.url();
    } catch {}

    console.error(`\n❌ [${timestamp}] Fill failed on ${errorUrl}: ${err.message}`);

    if (page && !page.isClosed()) {
      try {
        console.log('   Pausing 10s on error page for visual inspection...');
        await page.waitForTimeout(10000);
      } catch {}
    }

    if (browser) {
      try { await browser.close(); } catch {}
    }
    throw err;
  }
}
