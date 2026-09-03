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
import { readFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { existsSync } from 'fs';
import { discoverApplicationForm, detectATS } from './discovery.mjs';
import { findField, handleDropdown, verifyDropdownFilled, fuzzyScore } from './fields.mjs';
import { handlePostSubmitOTP } from './otp.mjs';
import { takeScreenshot, logToCSV } from './reporter.mjs';
import { recordResult } from './learner.mjs';
import { isSubmitButton } from './scanner.mjs';
import { handleWorkday } from './workday.mjs';
import { loadProfile, mapLabelToProfileValue } from './planner.mjs';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// ─── Terminal Prompt Fallback for Unmapped Required Fields ─────────────────
export async function promptUserInTerminal(label, fieldType, options = []) {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`❓ [Required Field Not Found in Profile/Plan]`);
    console.log(`   Question: "${label}"`);
    console.log(`   Field Type: ${fieldType}`);
    if (options && options.length > 0) {
      console.log(`   Available Options: ${options.slice(0, 10).join(', ')}`);
    }
    const answer = await rl.question('   👉 Please enter your answer to continue: ');
    console.log(`${'─'.repeat(60)}\n`);
    return answer.trim();
  } catch {
    return '';
  } finally {
    rl.close();
  }
}

// ─── Workday Step Detector ──────────────────────────────────────────────────
export async function detectWorkdayStep(page) {
  return await page.evaluate(() => {
    // 1. Check main page headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="step-title"], [data-automation-id="compositeHeader"], legend'));
    for (const h of headings) {
      const text = (h.textContent || '').trim();
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures/i.test(text)) return 'Voluntary Disclosures';
      if (/^review(\s*application)?$/i.test(text) || /review\s*and\s*submit/i.test(text) || /review\s*your\s*application/i.test(text)) return 'Review';
    }

    // 2. Check active wizard step in progress bar
    const activeStep = document.querySelector('[data-automation-id*="wizardStep"][aria-current="step"], [data-automation-id*="currentStep"], li.active, [aria-selected="true"]');
    if (activeStep) {
      const text = (activeStep.textContent || '').trim();
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures/i.test(text)) return 'Voluntary Disclosures';
      if (/review/i.test(text)) return 'Review';
    }

    // 3. Check page content and unique labels
    const bodyText = document.body?.innerText || '';
    if (/My Information/i.test(bodyText) && (/How Did You Hear/i.test(bodyText) || /Address Line/i.test(bodyText))) return 'My Information';
    if (/My Experience/i.test(bodyText) || (/Work Experience/i.test(bodyText) && /Resume/i.test(bodyText))) return 'My Experience';
    if (/Application Questions/i.test(bodyText) || /Conflict of Interest/i.test(bodyText)) return 'Application Questions';
    if (/Voluntary Disclosures/i.test(bodyText) || /terms and conditions/i.test(bodyText)) return 'Voluntary Disclosures';
    if (/Review/i.test(bodyText) && (document.querySelector('button[data-automation-id*="submit"], button:has-text("Submit")') || /Review/i.test(document.title))) return 'Review';

    return 'Unknown';
  });
}

// ─── Workday "Add" Button Expander ──────────────────────────────────────────
async function handleWorkdayAddButtons(page, stepName, profile) {
  if (stepName === 'My Experience') {
    // 1. Work Experience: Check if job title field is open
    const hasJobTitleInput = await page.$('input[data-automation-id*="jobTitle"], input[id*="jobTitle"], label:has-text("Job Title") + input, label:has-text("Job Title") ~ input');
    if (!hasJobTitleInput) {
      const addExpBtn = await page.$('button[data-automation-id*="Add"]:has-text("Experience"), button:has-text("Add Work Experience"), button:has-text("Add Experience"), [data-automation-id="workExperienceSection"] button[data-automation-id="Add"], button:has-text("Add Another"), button[data-automation-id="Add"]');
      if (addExpBtn && await addExpBtn.isVisible().catch(() => false)) {
        console.log('    ➕ Expanding Work Experience section (clicking Add)...');
        await addExpBtn.click({ force: true }).catch(() => addExpBtn.evaluate(el => el.click()));
        await page.waitForTimeout(1000);
      }
    }

    // 2. Education: Check if school / university field is open
    const hasSchoolInput = await page.$('input[data-automation-id*="school"], input[id*="school"], label:has-text("School") + input, label:has-text("School") ~ input, label:has-text("University") + input');
    if (!hasSchoolInput) {
      const addEduBtn = await page.$('button[data-automation-id*="Add"]:has-text("Education"), button:has-text("Add Education"), [data-automation-id="educationSection"] button[data-automation-id="Add"]');
      if (addEduBtn && await addEduBtn.isVisible().catch(() => false)) {
        console.log('    ➕ Expanding Education section (clicking Add)...');
        await addEduBtn.click({ force: true }).catch(() => addEduBtn.evaluate(el => el.click()));
        await page.waitForTimeout(1000);
      }
    }

    // 3. Website: If linkedin/portfolio present in profile and input not open
    if (profile?.personal?.linkedin) {
      const hasWebInput = await page.$('input[data-automation-id*="website"], input[id*="website"], label:has-text("Website") + input');
      if (!hasWebInput) {
        const addWebBtn = await page.$('button[data-automation-id*="Add"]:has-text("Website"), button:has-text("Add Website"), [data-automation-id="websitesSection"] button[data-automation-id="Add"]');
        if (addWebBtn && await addWebBtn.isVisible().catch(() => false)) {
          console.log('    ➕ Expanding Website section (clicking Add)...');
          await addWebBtn.click({ force: true }).catch(() => addWebBtn.evaluate(el => el.click()));
          await page.waitForTimeout(1000);
        }
      }
    }
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
  const existingFileItem = await page.$('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"], [class*="file-upload-item"]');
  if (existingFileItem && await existingFileItem.isVisible().catch(() => false)) {
    const existingName = await existingFileItem.textContent().catch(() => '');
    console.log(`    📎 Resume already uploaded: "${existingName.trim()}"`);
    return true;
  }

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) return false;

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
      await page.waitForTimeout(1000);
      return true;
    }
  }

  console.log('    ⚠️  Resume upload wait finished — continuing...');
  return true;
}

// ─── Fill Current Workday Step ──────────────────────────────────────────────
async function fillCurrentWorkdayStep(page, stepName, profile, plan) {
  console.log(`\n  📝 [Workday] Filling Step: "${stepName}"...`);

  // 1. Expand subsections (Add buttons)
  await handleWorkdayAddButtons(page, stepName, profile);

  // 2. Handle Resume upload if on My Experience
  if (stepName === 'My Experience' && (plan.resume || profile.resume)) {
    await handleWorkdayResumeUpload(page, plan.resume || profile.resume);
  }

  // 3. Handle "I currently work here" checkbox early on My Experience
  if (stepName === 'My Experience') {
    const currentWorkCb = await page.$('input[type="checkbox"][data-automation-id*="currentlyWorkHere"], label:has-text("currently work here") input[type="checkbox"], input[type="checkbox"][id*="currentlyWorkHere"]');
    if (currentWorkCb) {
      const isChecked = await currentWorkCb.isChecked().catch(() => false);
      if (!isChecked) {
        await currentWorkCb.click({ force: true }).catch(() => currentWorkCb.evaluate(el => el.click()));
        console.log('    ☑️  Checked: "I currently work here"');
        await page.waitForTimeout(500);
      }
    }
  }

  // 4. Handle Step 4 Terms & Conditions checkbox early on Voluntary Disclosures
  if (stepName === 'Voluntary Disclosures') {
    const termsCb = await page.$('input[type="checkbox"][data-automation-id*="consent"], label:has-text("consent to the terms") input[type="checkbox"], label:has-text("terms and conditions") input[type="checkbox"], input[type="checkbox"][id*="terms"]');
    if (termsCb) {
      const isChecked = await termsCb.isChecked().catch(() => false);
      if (!isChecked) {
        await termsCb.click({ force: true }).catch(() => termsCb.evaluate(el => el.click()));
        console.log('    ☑️  Checked: "Terms and conditions consent"');
        await page.waitForTimeout(500);
      }
    }
  }

  // 5. Handle Phone Section on Step 1 (Phone Device Type + Country Code + Phone Number)
  if (stepName === 'My Information' || stepName === 'Unknown') {
    // 5a. Phone Device Type dropdown button
    const phoneTypeBtn = await page.$('button[id*="phoneType"], button[data-automation-id*="phone-device-type"], button[data-automation-id*="phoneType"], button#phoneNumber--phoneType');
    if (phoneTypeBtn && await phoneTypeBtn.isVisible().catch(() => false)) {
      const btnText = await phoneTypeBtn.textContent().catch(() => '');
      if (!btnText || btnText.includes('Select One') || btnText.includes('Select')) {
        console.log('    📱 Selecting Phone Device Type: "Mobile"...');
        await phoneTypeBtn.click({ force: true }).catch(() => phoneTypeBtn.evaluate(el => el.click()));
        await page.waitForTimeout(400);
        const mobileOpt = await page.$('[data-automation-id="promptOption"]:has-text("Mobile"), [role="option"]:has-text("Mobile"), li:has-text("Mobile"), div:has-text("Mobile")');
        if (mobileOpt && await mobileOpt.isVisible().catch(() => false)) {
          await mobileOpt.click({ force: true }).catch(() => mobileOpt.evaluate(el => el.click()));
          console.log('    ✅ Phone Device Type: "Mobile"');
        } else {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(400);
      }
    }

    // 5b. Country Phone Code
    const countryPhoneCode = profile?.personal?.country_phone_code || profile?.personal?.country || 'India (+91)';
    const countryCodeInput = await page.$('input[id*="countryPhoneCode"], input[data-automation-id*="countryPhoneCode"], input#phoneNumber--countryPhoneCode, [data-automation-id="country-phone-code"] input');
    if (countryCodeInput && await countryCodeInput.isVisible().catch(() => false)) {
      const currentCode = await countryCodeInput.inputValue().catch(() => '');
      if (!currentCode || currentCode.trim() === '') {
        console.log(`    🌍 Setting Country Phone Code: "${countryPhoneCode}"...`);
        await handleDropdown(page, countryCodeInput, countryPhoneCode, 'Country Phone Code');
        await page.waitForTimeout(400);
      }
    }

    // 5c. Phone Number Input
    const phoneVal = profile?.personal?.phone || plan?.fills?.find(f => /phone/i.test(f.id || f.label))?.value;
    if (phoneVal) {
      const phoneInput = await page.$('input[id*="phoneNumber--phoneNumber"], input[data-automation-id="phone-number"], input[name="phoneNumber"], input[type="tel"], input#phoneNumber--phoneNumber, [id="phoneNumber--phoneNumber"]');
      if (phoneInput && await phoneInput.isVisible().catch(() => false)) {
        const currentVal = await phoneInput.inputValue().catch(() => '');
        if (!currentVal || currentVal.trim() === '') {
          console.log(`    📞 Filling Phone Number: "${phoneVal}"...`);
          await phoneInput.scrollIntoViewIfNeeded().catch(() => {});
          await phoneInput.click({ force: true }).catch(() => phoneInput.evaluate(el => el.click()));
          await page.waitForTimeout(100);
          await phoneInput.fill('');
          await phoneInput.type(String(phoneVal), { delay: 40 });
          await page.waitForTimeout(200);
        }
      }
    }
  }

  // 6. Query and scan all visible interactive inputs on the current step
  const visibleFields = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    function getLabel(el) {
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return label.textContent.trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent.trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const refEl = document.getElementById(labelledBy);
        if (refEl) return refEl.textContent.trim();
      }
      if (el.placeholder) return el.placeholder;
      const prev = el.previousElementSibling;
      if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
        return prev.textContent.trim();
      }
      const parent = el.parentElement;
      if (parent) {
        const textNode = Array.from(parent.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
        if (textNode) return textNode.textContent.trim();
      }

      const autoId = el.getAttribute('data-automation-id') || '';
      const idOrName = el.id || el.name || autoId;
      if (idOrName) {
        const clean = idOrName
          .replace(/^(name--|address--|phoneNumber--|legalName--)/, '')
          .replace(/--/g, ' ')
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .trim();
        if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
      }
      return el.name || el.id || '';
    }

    document.querySelectorAll('input, select, textarea, [data-automation-id="select-widget"]').forEach(el => {
      if (el.getAttribute('data-automation-id') === 'beecatcher' || el.name === 'website' && el.type === 'text' && el.style?.display === 'none') return;
      const type = el.type || el.tagName.toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type) && el.getAttribute('data-automation-id') !== 'select-widget') return;

      const autoId = el.getAttribute('data-automation-id') || '';
      const key = el.id || el.name || autoId || `${type}-${results.length}`;
      if (seen.has(key)) return;
      seen.add(key);

      const field = {
        id: el.id || el.name || autoId || `field_${results.length}`,
        name: el.name || '',
        automationId: autoId,
        label: getLabel(el),
        type: type === 'select-one' ? 'select' : type,
        value: el.value || '',
        required: el.required || el.getAttribute('aria-required') === 'true' || !!el.closest('.field')?.querySelector('.required, .asterisk'),
        disabled: el.disabled || el.readOnly,
      };

      if (el.id) field.selector = `#${CSS.escape(el.id)}`;
      else if (autoId) field.selector = `[data-automation-id="${autoId}"]`;
      else if (el.name) field.selector = `${el.tagName.toLowerCase()}[name="${el.name}"]`;

      results.push(field);
    });

    return results;
  });

  // 6. Map and fill each field
  let stepFilled = 0;
  for (const field of visibleFields) {
    if (field.disabled) continue;
    if (field.type === 'file') continue;

    const label = field.label || field.id;
    let mappedVal = mapLabelToProfileValue(label, profile);

    // Fallback to plan fills
    if (!mappedVal && plan.fills) {
      const match = plan.fills.find(f => f.id === field.id || (f.label && label && f.label.toLowerCase() === label.toLowerCase()));
      if (match && match.value) mappedVal = match.value;
    }

    // Check runtime answers cached during this session
    if (!mappedVal && profile._runtimeAnswers && profile._runtimeAnswers[label]) {
      mappedVal = profile._runtimeAnswers[label];
    }

    // If still not mapped, check if required or on Questions/Disclosures steps — ask in terminal
    if (!mappedVal) {
      const isRequired = field.required || label.includes('*') || /required/i.test(label) || stepName === 'Application Questions';
      if (isRequired) {
        let options = [];
        try {
          const el = await findField(page, field);
          if (el) {
            options = await el.evaluate(node => {
              if (node.tagName.toLowerCase() === 'select') {
                return Array.from(node.options).map(o => o.text.trim()).filter(t => t && !t.startsWith('Select'));
              }
              const container = node.closest('[data-automation-id*="formField"], [class*="field"], div');
              if (container) {
                const labels = Array.from(container.querySelectorAll('label'));
                return labels.map(r => r.textContent.trim()).filter(Boolean);
              }
              return [];
            }).catch(() => []);
          }
        } catch {}

        const userAnswer = await promptUserInTerminal(label, field.type, options);
        if (userAnswer) {
          mappedVal = userAnswer;
          if (!profile._runtimeAnswers) profile._runtimeAnswers = {};
          profile._runtimeAnswers[label] = userAnswer;
        }
      }
    }

    if (!mappedVal) continue;

    try {
      const el = await findField(page, field);
      if (!el) continue;

      const isVisible = await el.isVisible().catch(() => false);
      if (!isVisible) continue;

      // Skip non-empty text fields to preserve prefilled values
      const currentVal = await el.inputValue().catch(() => '');
      if (currentVal && currentVal.trim() !== '' && currentVal !== 'Select...' && currentVal !== 'Select' && field.type !== 'checkbox') {
        continue;
      }

      await el.scrollIntoViewIfNeeded().catch(() => {});

      if (field.type === 'checkbox') {
        const shouldCheck = mappedVal === true || mappedVal === 'true' || mappedVal === 'yes' || mappedVal === 'y' || mappedVal === '_static.true' || mappedVal === '1' || mappedVal === 'on';
        if (shouldCheck) {
          const isChecked = await el.isChecked().catch(() => false);
          if (!isChecked) {
            await el.click({ force: true }).catch(() => el.evaluate(e => e.click()));
            console.log(`    ☑️  Checked: ${label}`);
            stepFilled++;
          }
        }
      } else if (field.type === 'radio') {
        try {
          await page.click(`input[name="${field.name}"][value="${mappedVal}"]`, { force: true });
          console.log(`    ✅ Radio: ${label} ← "${mappedVal}"`);
          stepFilled++;
        } catch {
          await page.click(`label:has-text("${mappedVal}")`, { force: true }).catch(() => {});
        }
      } else if (field.type === 'select' || field.type === 'custom-select' || field.automationId === 'select-widget') {
        const result = await handleDropdown(page, el, mappedVal, label);
        if (result.success) {
          console.log(`    ✅ Dropdown [${result.method}]: ${label} ← "${mappedVal}"`);
          stepFilled++;
        }
      } else {
        const isReadonly = await el.evaluate(e => e.readOnly || e.getAttribute('aria-haspopup') || e.getAttribute('role') === 'combobox').catch(() => false);
        const couldBeDropdown = isReadonly || ['country', 'gender', 'veteran', 'disability', 'race', 'how did you hear'].some(k => label.toLowerCase().includes(k));

        if (couldBeDropdown) {
          const result = await handleDropdown(page, el, mappedVal, label);
          if (result.success) {
            console.log(`    ✅ Dropdown: ${label} ← "${mappedVal}"`);
            stepFilled++;
          } else {
            await el.click({ clickCount: 3 }); await el.fill(mappedVal);
            console.log(`    ✅ Filled: ${label} ← "${mappedVal}"`);
            stepFilled++;
          }
        } else {
          await el.click();
          await page.waitForTimeout(100);
          await el.fill(mappedVal);
          const display = mappedVal.length > 50 ? mappedVal.substring(0, 50) + '...' : mappedVal;
          console.log(`    ✅ Filled: ${label} ← "${display}"`);
          stepFilled++;
        }
      }

      await page.waitForTimeout(200);
    } catch (err) {
      console.log(`    ⚠️  Could not fill ${label}: ${err.message?.substring(0, 60)}`);
    }
  }

  console.log(`  ✓ Completed fill pass for ${stepName}: ${stepFilled} action(s) performed.`);
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

  // 1. Wait 2s for XHR / loading spinner to mount
  await page.waitForTimeout(2000);

  // 2. Wait for loading spinner to detach
  try {
    await page.waitForSelector('[data-automation-id="loading-spinner"], div[class*="loading-spinner"], div.loading-backdrop', { state: 'detached', timeout: 15000 });
  } catch {}

  // 3. Wait for network idle
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}

  // 4. Wait 2.5s buffer for SPA hydration
  await page.waitForTimeout(2500);

  // Check for validation errors on current step
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
    return { hasSaveButton: true, hasErrors: true, errors: errorMessages };
  }

  return { hasSaveButton: true, hasErrors: false };
}

// ─── Workday 5-Step Wizard Loop ─────────────────────────────────────────────
export async function runWorkdayWizardLoop(page, profile, plan, { otpEmail, otpPassword } = {}) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🧙 STARTING WORKDAY 5-STEP WIZARD LOOP`);
  console.log(`${'═'.repeat(60)}`);

  const maxSteps = 10;
  let currentIteration = 0;
  let lastStep = '';
  let sameStepCount = 0;

  while (currentIteration < maxSteps) {
    currentIteration++;

    // 1. Detect current step
    const stepName = await detectWorkdayStep(page);
    console.log(`\n📍 [Wizard Step ${currentIteration}] Detected Page: "${stepName}"`);

    if (stepName === lastStep) {
      sameStepCount++;
      if (sameStepCount >= 3) {
        console.log(`  ⚠️  Stuck on "${stepName}" for 3 iterations — attempting submit / exit.`);
        break;
      }
    } else {
      sameStepCount = 0;
      lastStep = stepName;
    }

    // 2. Check if we reached Review step or if Submit button is present
    const submitBtn = await page.$('button:has-text("Submit"), button[data-automation-id*="submit-button"], button[data-automation-id="bottom-navigation-next-button"]:has-text("Submit")');
    const isSubmitVisible = submitBtn && await submitBtn.isVisible().catch(() => false);

    if (stepName === 'Review' || isSubmitVisible) {
      console.log(`\n🎉 Reached final step: "${stepName}"! Preparing for final submission...`);
      await takeScreenshot(page, 'workday-review-step');

      // Final submit
      console.log('🚀 Clicking final "Submit" button...');
      if (submitBtn) {
        await submitBtn.click({ force: true }).catch(() => submitBtn.evaluate(el => el.click()));
      } else {
        await clickSubmitButton(page);
      }

      // Add 5s timeout after final Submit before considering success
      console.log('⏳ Waiting 5s+ after final Submit...');
      await page.waitForTimeout(5000);
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

      // Check for success / confirmation
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

      // Check for post-submit OTP if prompted
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/verification\s*code|enter.*code|confirm.*human|code\s*was\s*sent/i.test(bodyText)) {
        if (otpEmail && otpPassword) {
          const submitTime = Date.now() - 10000;
          return await handlePostSubmitOTP(page, otpEmail, otpPassword, submitTime);
        }
        return 'needs-otp';
      }

      return 'submitted';
    }

    // 3. Fill current step
    await fillCurrentWorkdayStep(page, stepName, profile, plan);
    await takeScreenshot(page, `workday-step-${currentIteration}-${stepName.replace(/\s+/g, '-').toLowerCase()}`);

    // 4. Advance step (click "Save and Continue")
    const advanceResult = await advanceWorkdayStep(page);

    if (!advanceResult.hasSaveButton) {
      console.log('  ℹ️  No "Save and Continue" button found — checking for Submit in next pass...');
    }

    if (advanceResult.hasErrors) {
      console.log('  🔄 Re-attempting step filling due to validation errors...');
      await fillCurrentWorkdayStep(page, stepName, profile, plan);
      await advanceWorkdayStep(page);
    }
  }

  return 'submitted';
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
export async function fillForm(url, plan, { otpEmail, otpPassword, workdayEmail, workdayPassword, mode = 'signin', browser: existingBrowser, context: existingContext, page: existingPage } = {}) {
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
      const status = await runWorkdayWizardLoop(page, profile, plan, { otpEmail, otpPassword });

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

      console.log(`\n   Browser stays open for 15s — Ctrl+C to keep it open longer.`);
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
          if (otpEmail && otpPassword) {
            const submitTime = Date.now() - 10000;
            status = await handlePostSubmitOTP(page, otpEmail, otpPassword, submitTime);
          } else { status = 'needs-otp'; }
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
              await sel.selectOption({ label: 'LinkedIn' });
              console.log(`  ✅ Conditional select: ${labelText} ← "LinkedIn"`);
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

    console.log(`\n   Browser stays open for 15s — Ctrl+C to keep it open longer.`);
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
