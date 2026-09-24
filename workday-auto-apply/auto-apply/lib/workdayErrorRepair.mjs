/**
 * workdayErrorRepair.mjs — Fill the exact fields Workday complains about.
 *
 * When "Save and Continue" fails, Workday names the offending field
 * ("The field Race is required and must have a value."). Regular discovery can
 * miss those widgets, so this module walks from the error node in the DOM to the
 * field it belongs to, reads the control shape and its live options, and fills it.
 *
 * Compliance answers (EEO, work authorization) are only taken from data already
 * on file — never invented and never guessed by the LLM.
 */

import { typeAndClickOption, clickVisiblePromptOption, fuzzyScore } from './fields.mjs';
import { resolveField } from './planner.mjs';
import { resolveDynamicAnswer } from './questionEngine/index.mjs';
import { createQAStore, isComplianceSensitive, normalizeLabel } from './qaStore.mjs';
import { getWorkdayTenant } from './discovery.mjs';
import { pickNearestSelectOption } from './openRouterLlm.mjs';
import { waitForDomSettled } from './workdayDom.mjs';
import { fillEducationFieldOfStudy } from './workdayExperience.mjs';
import { lookupSupabaseAnswerSync } from './supabaseClient.mjs';
import { resolvePostalForWorkday } from './clientContact.mjs';

/** Field names mentioned in Workday validation messages. */
export function parseErrorFieldNames(errors = []) {
  const names = new Set();
  for (const raw of errors) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/postal\s*code|zip\s*code/i.test(text)) {
      names.add('Postal Code');
    }
    const patterns = [
      /the field ([\s\S]{2,600}?) is required/gi,
      /\bError-([A-Za-z0-9 /'&-]{2,300}?)(?=The field|Select|$)/g,
      /^([\s\S]{2,600}?) is required/gi,
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(text)) !== null) {
        const name = match[1].replace(/[*.:]+$/, '').trim();
        if (name && !/^error/i.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Mark every field Workday flagged and describe its control shape.
 * @param {import('playwright').Page} page
 * @param {string[]} fieldNames names parsed from the validation messages
 */
async function markErrorFields(page, fieldNames = []) {
  return await page.evaluate((names) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-wd-error-fix]').forEach((el) => el.removeAttribute('data-wd-error-fix'));

    const FIELD_SELECTOR = '[data-automation-id*="formField"], fieldset, [role="group"]';
    const targets = new Map();

    const addTarget = (field, name) => {
      if (!field || targets.has(field)) return;
      targets.set(field, name || '');
    };

    // 1. Fields that carry an inline error or aria-invalid
    for (const el of document.querySelectorAll('[data-automation-id*="error" i], [role="alert"], [aria-invalid="true"]')) {
      const text = norm(el.textContent);
      if (!/required|must have a value|select at least|please select/i.test(text) && el.getAttribute('aria-invalid') !== 'true') continue;
      const field = el.closest(FIELD_SELECTOR);
      if (field) addTarget(field, '');
    }

    // 2. Fields named in the validation banner
    for (const name of names) {
      const wanted = name.toLowerCase();
      const labels = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]'));
      let best = null;
      for (const labelEl of labels) {
        const text = norm(labelEl.textContent)
          .replace(/^\*+|\*+$/g, '')
          .replace(/\s+select(\s+one)?(\s+required)?\s*$/i, '')
          .replace(/\s+required\s*$/i, '')
          .trim()
          .toLowerCase();
        if (!text) continue;
        const exact = text === wanted;
        const starts = (text.startsWith(wanted) && text.length <= wanted.length + 30) || (wanted.startsWith(text) && wanted.length <= text.length + 30);
        const contains = (text.length > 20 && wanted.length > 20 && (text.includes(wanted.slice(0, 30)) || wanted.includes(text.slice(0, 30))));
        if (!exact && !starts && !contains) continue;
        const field = labelEl.closest(FIELD_SELECTOR);
        if (!field) continue;
        if (exact) { best = field; break; }
        if (!best) best = field;
      }
      if (best) addTarget(best, name);
    }

    const describe = (field, name) => {
      const labelEl = field.querySelector('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]');
      const label = norm(labelEl?.textContent).replace(/\*+$/, '').trim() || name;

      const radios = Array.from(field.querySelectorAll('input[type="radio"]'));
      const checkboxes = Array.from(field.querySelectorAll('input[type="checkbox"]'));
      const select = field.querySelector('select');
      const combo = field.querySelector('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"], [data-automation-id="multiSelectContainer"]');
      const spins = field.querySelectorAll('input[role="spinbutton"]');
      const textarea = field.querySelector('textarea');
      const input = field.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([role="spinbutton"])');

      const optionTextFor = (el) => {
        const byFor = el.id ? field.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        return norm(byFor?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label'));
      };

      let fieldType = 'text';
      let options = [];
      let currentValue = '';

      if (radios.length) {
        fieldType = 'radio';
        options = radios.map(optionTextFor).filter(Boolean);
        currentValue = radios.filter((r) => r.checked).map(optionTextFor).join(', ');
      } else if (checkboxes.length > 1) {
        fieldType = 'checkbox-group';
        options = checkboxes.map(optionTextFor).filter(Boolean);
        currentValue = checkboxes.filter((c) => c.checked).map(optionTextFor).join(', ');
      } else if (checkboxes.length === 1) {
        fieldType = 'checkbox';
        currentValue = checkboxes[0].checked ? 'checked' : '';
      } else if (select) {
        fieldType = 'select';
        options = Array.from(select.options).map((o) => norm(o.textContent)).filter((t) => t && !/^select/i.test(t));
        const shown = norm(select.selectedOptions?.[0]?.textContent);
        currentValue = /^select(\s+one)?\.{0,3}$/i.test(shown) ? '' : shown;
      } else if (combo) {
        fieldType = 'dropdown';
        const shown = norm(combo.textContent);
        currentValue = /^select(\s+one)?\.?$/i.test(shown) || /^\d+\s*items?\s*selected$/i.test(shown) ? '' : shown;
      } else if (spins.length) {
        fieldType = 'date';
        currentValue = Array.from(spins).map((s) => s.value).filter(Boolean).join('/');
      } else if (textarea) {
        fieldType = 'textarea';
        currentValue = norm(textarea.value);
      } else if (input) {
        fieldType = 'text';
        currentValue = norm(input.value);
      }

      const id = `wd-err-${Math.random().toString(36).slice(2, 8)}`;
      field.setAttribute('data-wd-error-fix', id);
      return { id, label, name: name || label, fieldType, options, currentValue };
    };

    return Array.from(targets.entries()).map(([field, name]) => describe(field, name));
  }, fieldNames).catch(() => []);
}

/** Nearest option from a live list without a network call. */
function pickLocalOption(options = [], preferred = '') {
  const want = String(preferred || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want || !options.length) return null;
  const exact = options.find((o) => o.toLowerCase() === want);
  if (exact) return exact;
  const contains = options.find((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()));
  if (contains) return contains;
  let best = null;
  let bestScore = 0;
  for (const option of options) {
    const score = fuzzyScore(want, option);
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

async function resolveErrorFieldAnswer(page, profile, tenant, descriptor, stepName) {
  const { label, fieldType, options } = descriptor;

  let answer = null;
  const engineHit = await resolveDynamicAnswer(
    {
      label,
      fieldType,
      type: fieldType,
      options: options || [],
      required: true,
    },
    profile,
    {
      page,
      stepName,
      allowLlm: !isComplianceSensitive(label),
      resumePath: profile._resumePath,
    },
  );
  if (/postal\s*code|zip\s*code/i.test(label)) {
    return resolvePostalForWorkday(profile);
  }

  if (engineHit?.answer) {
    answer = engineHit.answer;
  }

  if (!answer && isComplianceSensitive(label)) {
    console.log(`    🛑 "${label}" is a compliance field with no verified answer — not guessing`);
    return null;
  }

  if (!answer) {
    const fromSupabase = lookupSupabaseAnswerSync(label, profile, { options, fieldType });
    if (fromSupabase?.answer) answer = fromSupabase.answer;
  }

  if (!answer) {
    answer = profile?.qa_answers?.[normalizeLabel(label)];
    if (Array.isArray(answer)) answer = answer[answer.length - 1];
  }

  if (!answer) {
    answer = await resolveField({
      label,
      fieldType,
      type: fieldType,
      options,
      required: true,
    }, profile, createQAStore(), {
      skipPrompt: true,
      page,
      profile,
      tenant,
      step: stepName,
      url: page.url(),
      company: profile?._company || profile?.company,
      useQuestionEngine: false,
    });
  }

  if (options.length) {
    const local = pickLocalOption(options, answer || '');
    if (local) return local;
    if (isComplianceSensitive(label)) return answer || null;
    const nearest = await pickNearestSelectOption({
      question: label,
      options,
      preferred: answer || '',
      profile,
      company: profile?._company,
    }).catch(() => null);
    if (nearest) return nearest;
  }

  return answer || null;
}

async function fillMarkedField(page, descriptor, answer) {
  const field = page.locator(`[data-wd-error-fix="${descriptor.id}"]`).first();
  if (!(await field.count())) return false;
  await field.scrollIntoViewIfNeeded().catch(() => {});
  const wanted = String(answer);

  if (descriptor.fieldType === 'radio' || descriptor.fieldType === 'checkbox-group') {
    const clicked = await field.evaluate((root, target) => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(target);
      const boxes = Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      for (const box of boxes) {
        const labelEl = box.id ? root.querySelector(`label[for="${CSS.escape(box.id)}"]`) : box.closest('label');
        const text = norm(labelEl?.textContent || box.getAttribute('aria-label'));
        if (!text) continue;
        if (text === want || text.includes(want) || want.includes(text)) {
          (labelEl || box).click();
          return true;
        }
      }
      return false;
    }, wanted).catch(() => false);
    return clicked;
  }

  if (descriptor.fieldType === 'checkbox') {
    const box = field.locator('input[type="checkbox"]').first();
    await box.click({ force: true }).catch(() => box.evaluate((el) => el.click()));
    return await box.isChecked().catch(() => false);
  }

  if (descriptor.fieldType === 'select') {
    const select = field.locator('select').first();
    const ok = await select.selectOption({ label: wanted }).then(() => true).catch(() => false);
    if (ok) return true;
  }

  if (descriptor.fieldType === 'dropdown' || descriptor.fieldType === 'select') {
    const typed = await typeAndClickOption(page, field, wanted);
    if (typed.ok) return true;
    const trigger = field.locator('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button').first();
    if (await trigger.isVisible({ timeout: 600 }).catch(() => false)) {
      await trigger.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      const picked = await clickVisiblePromptOption(page, [wanted]);
      if (picked) {
        await page.keyboard.press('Escape').catch(() => {});
        return true;
      }
    }
    return false;
  }

  const spins = field.locator('input[role="spinbutton"]');
  if (await spins.count() >= 3) {
    const dateVal = String(wanted);
    const m = dateVal.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || dateVal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const month = m[1].length === 2 && Number(m[1]) <= 12 ? m[1] : (m[2] || '01');
      const day = m[1].length === 2 && Number(m[1]) <= 12 ? m[2] : (m[3] || '01');
      const year = m[3] || m[1];
      await spins.nth(0).fill(String(Number(month)));
      await spins.nth(1).fill(String(Number(day)));
      await spins.nth(2).fill(String(year));
      await spins.nth(2).press('Tab');
      return true;
    }
  }

  const control = field.locator('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([role="spinbutton"])').first();
  if (!(await control.isVisible({ timeout: 600 }).catch(() => false))) return false;
  await control.click({ force: true }).catch(() => {});
  await control.fill(wanted).catch(() => {});
  await control.press('Tab').catch(() => {});
  const after = await control.inputValue().catch(() => '');
  return Boolean(after);
}

/** Read the marked field back so the fill is DOM-verified. */
async function readMarkedFieldValue(page, descriptor) {
  return await page.locator(`[data-wd-error-fix="${descriptor.id}"]`).first().evaluate((root) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const checked = Array.from(root.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked'));
    if (checked.length) {
      return checked.map((box) => {
        const labelEl = box.id ? root.querySelector(`label[for="${CSS.escape(box.id)}"]`) : box.closest('label');
        return norm(labelEl?.textContent || box.getAttribute('aria-label') || 'checked');
      }).join(', ');
    }
    const select = root.querySelector('select');
    if (select) return norm(select.selectedOptions?.[0]?.textContent);
    const combo = root.querySelector('[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"]');
    if (combo) {
      const shown = norm(combo.textContent);
      if (!/^select(\s+one)?\.?$/i.test(shown)) return shown;
    }
    const textarea = root.querySelector('textarea');
    if (textarea?.value) return norm(textarea.value);
    const input = root.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    if (input?.value) return norm(input.value);
    return '';
  }).catch(() => '');
}

/**
 * Fill the fields named in Workday's validation errors.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string} stepName
 * @param {string[]} errors validation messages from the failed Save and Continue
 * @returns {Promise<number>} fields verified as filled
 */
export async function repairRequiredFieldsFromErrors(page, profile, stepName = '', errors = []) {
  for (const raw of errors) {
    const text = String(raw || '');
    const stateMismatch = text.match(/is not a valid postal code for\s+([A-Za-z\s]+)/i);
    if (stateMismatch && stateMismatch[1]) {
      const errState = stateMismatch[1].replace(/[.]*$/, '').trim();
      if (errState) {
        profile.personal = profile.personal || {};
        profile.personal.state = errState;
        console.log(`    📍 Workday indicates address state is "${errState}" — aligning postal code`);
      }
    }
  }

  const names = parseErrorFieldNames(errors);
  const descriptors = await markErrorFields(page, names);
  if (!descriptors.length) {
    if (names.length) console.log(`    ⚠️  Workday flagged ${names.join(', ')} but the field was not found in the DOM`);
    return 0;
  }

  const tenant = profile?._tenant || getWorkdayTenant(page.url());
  let filled = 0;

  for (const descriptor of descriptors) {
    if (/field\s*of\s*study/i.test(descriptor.label || descriptor.name || '')) {
      const fos = await fillEducationFieldOfStudy(page, profile?.education?.major || 'Computer Science').catch(() => false);
      if (fos) {
        filled++;
        continue;
      }
    }

    if (descriptor.currentValue) continue;

    const answer = await resolveErrorFieldAnswer(page, profile, tenant, descriptor, stepName);
    if (!answer) {
      console.log(`    ⚠️  No answer on file for flagged field "${descriptor.label.slice(0, 60)}"`);
      continue;
    }

    const ok = await fillMarkedField(page, descriptor, answer);
    await waitForDomSettled(page, { timeout: 1200 }).catch(() => {});
    const verified = await readMarkedFieldValue(page, descriptor);

    if (!ok && !verified) {
      console.log(`    ✗ Could not fill flagged field "${descriptor.label.slice(0, 50)}" [${descriptor.fieldType}]`);
      continue;
    }

    filled++;
    console.log(`    ✅ Error repair [${descriptor.fieldType}] "${descriptor.label.slice(0, 50)}" ← "${String(verified || answer).slice(0, 45)}"`);

    profile.qa_answers = profile.qa_answers || {};
    profile.qa_answers[normalizeLabel(descriptor.label)] = answer;
    if (!profile._filledValues) profile._filledValues = {};
    profile._filledValues[descriptor.label] = answer;
  }

  await page.evaluate(() => {
    document.querySelectorAll('[data-wd-error-fix]').forEach((el) => el.removeAttribute('data-wd-error-fix'));
  }).catch(() => {});

  return filled;
}
