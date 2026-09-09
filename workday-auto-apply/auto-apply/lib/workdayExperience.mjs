/**
 * workdayExperience.mjs — My Experience step (Work Experience + Education)
 *
 * Finds fields via DOM label scan (not brittle Playwright filters), expands
 * collapsed sections, fills with Playwright .fill() on spinbuttons + dropdowns.
 */

import { fillApplicationQuestionField } from './workdayQuestionFill.mjs';
import { handleDropdown, clickVisiblePromptOption } from './fields.mjs';
import { resolveField, mapLabelToProfileValue, getNestedValue, askHuman } from './planner.mjs';
import { createQAStore, saveAnswerToYaml } from './qaStore.mjs';
import { lookupDefaultAnswer } from './workdayDefaults.mjs';
import {
  WORKDAY_DEFAULT_EXPERIENCE,
  WORKDAY_DEFAULT_EDUCATION,
} from './workdayDefaults.mjs';
import { handleWebsitesSection } from './workdayWebsites.mjs';

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function logBlock(section, field, lines) {
  console.log(`\n  ┌── ${section} › ${field} ──`);
  for (const line of lines) {
    console.log(`  │  ${line}`);
  }
  console.log('  └──');
}

function valuesMatch(actual, expected) {
  const a = norm(actual).toLowerCase();
  const e = norm(expected).toLowerCase();
  if (!a || !e) return false;
  if (a === e || a.includes(e) || e.includes(a)) return true;
  return false;
}

const DEGREE_VARIANTS = ["Bachelor's", 'Bachelors', "Bachelor's Degree", 'Bachelor of Science', 'BS', 'B.S.'];

/**
 * Mark the best-matching field container on the page via data-wd-exp-target.
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function markFieldByLabel(page, labelPattern, sectionType = null) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-wd-exp-target]').forEach((el) => el.removeAttribute('data-wd-exp-target'));
  });

  const markerId = await page.evaluate(({ labelPattern, sectionType }) => {
    const labelRe = new RegExp(labelPattern, 'i');
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    function detectSection(el) {
      let node = el;
      for (let depth = 0; depth < 40 && node; depth++) {
        const auto = (node.getAttribute?.('data-automation-id') || '').toLowerCase();
        if (auto.includes('workexperience') || auto.includes('work-experience')) return 'work';
        if (auto.includes('education')) return 'education';
        const headings = node.querySelectorAll('h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"]');
        for (const h of headings) {
          const t = norm(h.textContent);
          if (/work\s*experience/i.test(t)) return 'work';
          if (/^education/i.test(t)) return 'education';
        }
        node = node.parentElement;
      }
      return 'unknown';
    }

    const candidates = [];
    const labelEls = document.querySelectorAll(
      'label, legend, [data-automation-id*="label"], [data-automation-id*="richText"], [id*="label"]'
    );

    for (const labelEl of labelEls) {
      const raw = norm(labelEl.textContent);
      if (!raw || raw.length > 120) continue;
      const labelText = raw.replace(/\*+$/, '').trim();
      if (!labelRe.test(labelText)) continue;

      const sec = detectSection(labelEl);
      if (sectionType && sec !== sectionType && sec !== 'unknown') continue;
      if (sectionType === 'work' && sec === 'education') continue;
      if (sectionType === 'education' && sec === 'work') continue;

      const field = labelEl.closest(
        '[data-automation-id*="formField"], [data-automation-id*="form-field"], [data-automation-id*="Field"], fieldset, [role="group"]'
      ) || labelEl.parentElement?.parentElement;
      if (!field) continue;

      const hasControl = field.querySelector(
        'input:not([type="hidden"]), textarea, select, [role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"]'
      );
      if (!hasControl) continue;

      const rect = field.getBoundingClientRect();
      if (rect.width < 5 && rect.height < 5) continue;

      candidates.push({ field, labelLen: labelText.length, area: Math.max(1, rect.width * rect.height), sec });
    }

    if (!candidates.length) return null;

    // Prefer exact section match, then shortest label (most specific), then smallest area
    candidates.sort((a, b) => {
      const aSec = sectionType && a.sec === sectionType ? 0 : 1;
      const bSec = sectionType && b.sec === sectionType ? 0 : 1;
      if (aSec !== bSec) return aSec - bSec;
      if (a.labelLen !== b.labelLen) return a.labelLen - b.labelLen;
      return a.area - b.area;
    });

    const id = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    candidates[0].field.setAttribute('data-wd-exp-target', id);
    return id;
  }, { labelPattern, sectionType });

  if (!markerId) return null;
  const loc = page.locator(`[data-wd-exp-target="${markerId}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  return loc;
}

/** List visible labels on page (debug when fields not found). */
async function dumpVisibleLabels(page) {
  const labels = await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]')) {
      const t = norm(el.textContent).replace(/\*+$/, '').trim();
      if (!t || t.length < 2 || t.length > 80 || seen.has(t)) continue;
      seen.add(t);
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) out.push(t);
    }
    return out.slice(0, 40);
  });
  if (labels.length) {
    console.log('  🔍 Visible labels on page:', labels.join(' | '));
  }
}

/** Expand Work Experience / Education if collapsed (visible fillable input missing). */
async function ensureSectionsExpanded(page) {
  const checks = [
    {
      name: 'Work Experience',
      fieldRe: /job\s*title/i,
      sectionType: 'work',
      buttons: [/add\s*work\s*experience/i, /add\s*experience/i],
      sectionBtn: '[data-automation-id*="workExperience"] button[data-automation-id="Add"], [data-automation-id*="workExperienceSection"] button[data-automation-id="Add"]',
    },
    {
      name: 'Education',
      fieldRe: /school\s*or\s*university|^school$/i,
      sectionType: 'education',
      buttons: [/add\s*education/i],
      sectionBtn: '[data-automation-id*="education"] button[data-automation-id="Add"], [data-automation-id*="educationSection"] button[data-automation-id="Add"]',
    },
  ];

  for (const check of checks) {
    const fieldLoc = await markFieldByLabel(page, check.fieldRe.source || check.fieldRe, check.sectionType);
    const visible = fieldLoc && await fieldLoc.locator('input, textarea, [role="combobox"], button[aria-haspopup]').first()
      .isVisible({ timeout: 600 }).catch(() => false);

    if (visible) {
      console.log(`  ✓ ${check.name} section already expanded`);
      continue;
    }

    console.log(`  ➕ Expanding ${check.name} section...`);
    let clicked = false;

    for (const btnRe of check.buttons) {
      const btn = page.getByRole('button', { name: btnRe }).first();
      if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(900);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      const sectionAdd = page.locator(check.sectionBtn).filter({ hasText: /add/i }).first();
      if (await sectionAdd.isVisible({ timeout: 400 }).catch(() => false)) {
        await sectionAdd.click({ force: true }).catch(() => {});
        await page.waitForTimeout(900);
        clicked = true;
      }
    }

    if (!clicked) {
      console.log(`    ℹ️  Could not expand ${check.name} — no section-specific Add button found`);
    }
  }
}

async function findFieldLocator(page, spec, sectionType) {
  const pattern = spec.labelPattern || spec.label;
  let loc = await markFieldByLabel(page, pattern, sectionType);
  if (loc && await loc.count()) return loc;

  // Playwright getByLabel fallback
  const byLabel = page.getByLabel(new RegExp(pattern, 'i')).first();
  if (await byLabel.isVisible({ timeout: 500 }).catch(() => false)) {
    const wrapper = byLabel.locator('xpath=ancestor::*[contains(@data-automation-id,"formField") or contains(@data-automation-id,"Field") or self::fieldset][1]').first();
    if (await wrapper.count()) return wrapper;
    return byLabel.locator('xpath=ancestor::div[1]').first();
  }

  return null;
}

async function readFieldValue(fieldLoc) {
  return await fieldLoc.evaluate((field) => {
    const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const spins = field.querySelectorAll('input[role="spinbutton"]');
    if (spins.length >= 2) {
      const vals = Array.from(spins).map((s) => s.value || '');
      if (vals.every(Boolean)) {
        if (spins.length >= 3) return `${vals[0]}/${vals[1]}/${vals[2]}`;
        return `${vals[0]}/${vals[1]}`;
      }
      if (vals[1]) return vals[1];
    } else if (spins.length === 1 && spins[0].value) {
      return spins[0].value;
    }
    const textarea = field.querySelector('textarea');
    if (textarea?.value) return normalize(textarea.value);
    const input = field.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    if (input && input.getAttribute('role') !== 'spinbutton' && input.value) {
      return normalize(input.value);
    }
    const btn = field.querySelector('[data-automation-id="selectWidget"] button, button[aria-haspopup="listbox"], [role="combobox"]');
    if (btn) {
      const t = normalize(btn.textContent);
      if (t && !/^select(\s+one)?$/i.test(t) && !/^0 items selected$/i.test(t)) return t;
    }
    return '';
  }).catch(() => '');
}

async function fillTextAggressive(page, fieldLoc, value, label) {
  const str = String(value);
  const attempts = [];

  const textarea = fieldLoc.locator('textarea').first();
  if (await textarea.count() && await textarea.isVisible({ timeout: 500 }).catch(() => false)) {
    await textarea.click({ force: true }).catch(() => {});
    await textarea.fill(str);
    await textarea.press('Tab').catch(() => {});
    const actual = await textarea.inputValue().catch(() => '');
    if (valuesMatch(actual, str)) {
      attempts.push(`textarea.fill → "${actual}" ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`textarea.fill → "${actual}" ✗`);
  }

  const input = fieldLoc.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([role="spinbutton"])').first();
  if (await input.count() && await input.isVisible({ timeout: 500 }).catch(() => false)) {
    await input.click({ force: true }).catch(() => {});
    await input.fill(str);
    await input.press('Tab').catch(() => {});
    const actual = await input.inputValue().catch(() => '');
    if (valuesMatch(actual, str)) {
      attempts.push(`input.fill → "${actual}" ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`input.fill → "${actual}" ✗`);
  }

  const appOk = await fillApplicationQuestionField(page, label, 'text', str);
  attempts.push(appOk ? 'fillApplicationQuestionField ✓' : 'fillApplicationQuestionField ✗');
  return { ok: appOk, attempts };
}

async function fillSpinMonthYearAggressive(page, fieldLoc, mmYYYY, label) {
  const match = String(mmYYYY).match(/^(\d{1,2})\/(\d{4})$/);
  if (!match) return { ok: false, attempts: ['invalid MM/YYYY'] };
  const [, month, year] = match;
  const attempts = [];
  const spins = fieldLoc.locator('input[role="spinbutton"]');
  const count = await spins.count();

  if (count >= 2) {
    await spins.nth(0).click({ force: true }).catch(() => {});
    await spins.nth(0).fill(String(Number(month)));
    await spins.nth(0).press('Tab').catch(() => {});
    await spins.nth(1).click({ force: true }).catch(() => {});
    await spins.nth(1).fill(year);
    await spins.nth(1).press('Tab').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    const vals = await spins.evaluateAll((els) => els.map((e) => e.value));
    if (vals[0] && vals[1]) {
      attempts.push(`spin → ${vals[0]}/${vals[1]} ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`spin → [${vals.join(', ')}] ✗`);
  }

  const appOk = await fillApplicationQuestionField(page, label, 'date', mmYYYY);
  attempts.push(appOk ? 'fillApplicationQuestionField(date) ✓' : 'fillApplicationQuestionField(date) ✗');
  return { ok: appOk, attempts };
}

async function fillSpinYearAggressive(page, fieldLoc, year, label) {
  const y = String(year);
  const attempts = [];
  const spins = fieldLoc.locator('input[role="spinbutton"]');
  const count = await spins.count();

  if (count >= 2) {
    await spins.nth(0).click({ force: true }).catch(() => {});
    await spins.nth(0).fill('1');
    await spins.nth(0).press('Tab').catch(() => {});
    await spins.nth(1).click({ force: true }).catch(() => {});
    await spins.nth(1).fill(y);
    await spins.nth(1).press('Tab').catch(() => {});
    const vals = await spins.evaluateAll((els) => els.map((e) => e.value));
    if (vals[1] === y || vals.includes(y)) {
      attempts.push(`year spin → ${vals.join('/')} ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`year spin → [${vals.join(', ')}] ✗`);
  }

  if (count >= 1) {
    const spin = count === 1 ? spins.first() : spins.last();
    await spin.click({ force: true }).catch(() => {});
    await spin.fill(y);
    await spin.press('Tab').catch(() => {});
    const actual = await spin.inputValue().catch(() => '');
    if (actual === y) {
      attempts.push(`single spin → "${actual}" ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`single spin → "${actual}" ✗`);
  }

  const appOk = await fillApplicationQuestionField(page, label, 'text', y);
  attempts.push(appOk ? 'fillApplicationQuestionField ✓' : 'fillApplicationQuestionField ✗');
  return { ok: appOk, attempts };
}

async function fillDropdownAggressive(page, fieldLoc, value, label, { searchable = false } = {}) {
  const attempts = [];
  const options = searchable ? [value] : [...DEGREE_VARIANTS, value];
  const uniqueOptions = [...new Set(options.map(String))];

  const trigger = fieldLoc.locator(
    '[data-automation-id="selectWidget"] button, button[aria-haspopup="listbox"], [role="combobox"], input[role="combobox"]'
  ).first();

  if (!(await trigger.isVisible({ timeout: 800 }).catch(() => false))) {
    const appOk = await fillApplicationQuestionField(page, label, 'select', value);
    attempts.push(appOk ? 'fillApplicationQuestionField(select) ✓' : 'no dropdown trigger ✗');
    return { ok: appOk, attempts };
  }

  for (const opt of uniqueOptions) {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);

    if (searchable) {
      const searchInput = page.locator('input[role="searchbox"], input[type="search"], input[role="combobox"]:visible').last();
      const isComboInput = await trigger.evaluate((el) => el.tagName === 'INPUT').catch(() => false);
      const typeTarget = (await searchInput.isVisible({ timeout: 400 }).catch(() => false))
        ? searchInput
        : (isComboInput ? trigger : null);
      if (typeTarget) {
        await typeTarget.fill('');
        await typeTarget.pressSequentially(String(opt), { delay: 30 });
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.type(String(opt), { delay: 30 });
        await page.waitForTimeout(500);
      }
    }

    const clicked = await clickVisiblePromptOption(page, [opt, String(opt)]);
    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(300);
    }

    const display = await trigger.innerText().catch(() => '') || await trigger.inputValue().catch(() => '');
    if (valuesMatch(display, opt) || clicked) {
      attempts.push(`selected "${opt}" ✓`);
      return { ok: true, attempts };
    }

    const result = await handleDropdown(page, trigger, opt, label);
    if (result.success) {
      attempts.push(`handleDropdown("${opt}") ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`try "${opt}" ✗`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  return { ok: false, attempts };
}

async function resolveAnswer(label, profileKey, labelText, profile, qaStore, url, fieldType) {
  if (profileKey) {
    const fromProfile = getNestedValue(profile, profileKey);
    if (fromProfile != null && fromProfile !== '') return String(fromProfile);
  }
  const mapped = mapLabelToProfileValue(labelText, profile, { url });
  if (mapped != null && mapped !== '') {
    return Array.isArray(mapped) ? mapped[mapped.length - 1] : String(mapped);
  }
  const fromDefault = lookupDefaultAnswer(labelText);
  if (fromDefault) return Array.isArray(fromDefault) ? fromDefault.join(' / ') : String(fromDefault);
  const resolved = await resolveField(
    { label: labelText, type: fieldType, required: true },
    profile,
    qaStore,
    { skipPrompt: false, url, company: profile?._company || profile?.company },
  );
  return resolved ? String(resolved) : null;
}

async function fillFieldAtAnyCost(page, sectionName, sectionType, spec, profile, qaStore, url) {
  const { label, key, type, searchable } = spec;

  let fieldLoc = await findFieldLocator(page, spec, sectionType);
  if (!fieldLoc) {
    logBlock(sectionName, label, ['NOT FOUND — dumping page labels...']);
    await dumpVisibleLabels(page);
    return false;
  }

  let answer = await resolveAnswer(label, key, label, profile, qaStore, url, type);
  if (!answer) {
    const prompted = await askHuman(label, { type, required: true }, {
      company: profile?._company || profile?.company,
    });
    answer = prompted?.trim() || null;
    if (answer) await saveAnswerToYaml(label, answer).catch(() => {});
  }
  if (!answer) {
    logBlock(sectionName, label, ['NO ANSWER available']);
    return false;
  }

  const before = await readFieldValue(fieldLoc);
  if (valuesMatch(before, answer)) {
    logBlock(sectionName, label, [`already correct: "${before}"`]);
    return true;
  }

  let result = { ok: false, attempts: [] };
  for (let attempt = 1; attempt <= 3 && !result.ok; attempt++) {
    if (attempt > 1) {
      fieldLoc = await findFieldLocator(page, spec, sectionType) || fieldLoc;
      await page.waitForTimeout(400);
    }

    switch (type) {
      case 'monthyear':
        result = await fillSpinMonthYearAggressive(page, fieldLoc, answer, label);
        break;
      case 'year':
        result = await fillSpinYearAggressive(page, fieldLoc, answer, label);
        break;
      case 'dropdown':
        result = await fillDropdownAggressive(page, fieldLoc, answer, label, { searchable: false });
        break;
      case 'searchable':
        result = await fillDropdownAggressive(page, fieldLoc, answer, label, { searchable: true });
        break;
      case 'textarea':
      case 'text':
      default:
        result = await fillTextAggressive(page, fieldLoc, answer, label);
        break;
    }
    if (!result.ok) result.attempts.push(`attempt ${attempt}/3 failed`);
  }

  const after = await readFieldValue(fieldLoc);
  const verified = result.ok || valuesMatch(after, answer);

  logBlock(sectionName, label, [
    `answer: "${answer}"`,
    `before: "${before || '(empty)'}"`,
    `after:  "${after || '(empty)'}"`,
    ...result.attempts,
    verified ? 'RESULT: FILLED ✓' : 'RESULT: FAILED ✗',
  ]);

  if (verified) {
    profile.qa_answers = profile.qa_answers || {};
    profile.qa_answers[label.toLowerCase()] = answer;
    await saveAnswerToYaml(label, answer).catch(() => {});
    if (key) {
      const parts = key.split('.');
      let obj = profile;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = obj[parts[i]] || {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = answer;
    }
  }
  return verified;
}

async function ensureCurrentlyWorkHereUnchecked(page) {
  const cb = page.locator(
    'input[type="checkbox"][data-automation-id*="currentlyWorkHere"], label:has-text("currently work here") input[type="checkbox"]'
  ).first();
  if (!(await cb.isVisible({ timeout: 1000 }).catch(() => false))) return;
  if (await cb.isChecked().catch(() => false)) {
    await cb.click({ force: true }).catch(() => {});
    console.log('  ☐  Unchecked: "I currently work here"');
  }
}

const WORK_FIELDS = [
  { label: 'Job Title', labelPattern: '^Job\\s*Title', key: 'experience.current_title', type: 'text' },
  { label: 'Company', labelPattern: '^Company', key: 'experience.current_company', type: 'text' },
  { label: 'Location', labelPattern: '^Location', key: 'experience.location', type: 'text' },
  { label: 'From', labelPattern: '^From', key: 'experience.from_date', type: 'monthyear' },
  { label: 'To', labelPattern: '^To', key: 'experience.to_date', type: 'monthyear' },
  { label: 'Role Description', labelPattern: 'Role\\s*Description', key: 'experience.description', type: 'textarea' },
];

const EDUCATION_FIELDS = [
  { label: 'School or University', labelPattern: 'School\\s*or\\s*University', key: 'education.university', type: 'searchable' },
  { label: 'Degree', labelPattern: '^Degree', key: 'education.degree', type: 'dropdown' },
  { label: 'Field of Study', labelPattern: 'Field\\s*of\\s*Study', key: 'education.major', type: 'searchable' },
  { label: 'From', labelPattern: '^From', key: 'education.from_year', type: 'year' },
  { label: 'To (Actual or Expected)', labelPattern: 'To.*Actual|Expected|^To\\s*\\*?$', key: 'education.to_year', type: 'year' },
  { label: 'Highest level of education', labelPattern: 'highest\\s*level\\s*of\\s*education', key: 'education.highest_level', type: 'text' },
];

export async function handleStep2MyExperience(page, profile = {}) {
  console.log('\n  ══════════════════════════════════════════');
  console.log('  📋 STEP 2: MY EXPERIENCE — FILL AT ANY COST');
  console.log('  ══════════════════════════════════════════');

  profile.experience = { ...WORKDAY_DEFAULT_EXPERIENCE, ...(profile.experience || {}) };
  profile.education = { ...WORKDAY_DEFAULT_EDUCATION, ...(profile.education || {}) };

  const qaStore = createQAStore();
  const url = page.url();
  let filled = 0;
  let failed = 0;

  await page.waitForTimeout(500);
  await ensureSectionsExpanded(page);
  await ensureCurrentlyWorkHereUnchecked(page);

  console.log('\n  ▶ WORK EXPERIENCE');
  for (const spec of WORK_FIELDS) {
    const ok = await fillFieldAtAnyCost(page, 'Work Experience', 'work', spec, profile, qaStore, url);
    if (ok) filled++;
    else failed++;
  }

  console.log('\n  ▶ EDUCATION');
  for (const spec of EDUCATION_FIELDS) {
    const ok = await fillFieldAtAnyCost(page, 'Education', 'education', spec, profile, qaStore, url);
    if (ok) filled++;
    else failed++;
  }

  await handleWebsitesSection(page, profile);

  if (failed > 0) {
    console.log('\n  ▶ RETRY WITHOUT SECTION FILTER...');
    for (const spec of [...WORK_FIELDS, ...EDUCATION_FIELDS]) {
      const fieldLoc = await markFieldByLabel(page, spec.labelPattern || spec.label, null);
      if (!fieldLoc) continue;
      const before = await readFieldValue(fieldLoc);
      const answer = getNestedValue(profile, spec.key) || lookupDefaultAnswer(spec.label);
      if (!answer || valuesMatch(before, answer)) continue;
      const sec = spec.key.startsWith('experience') ? 'Work Experience (retry)' : 'Education (retry)';
      const secType = spec.key.startsWith('experience') ? 'work' : 'education';
      const ok = await fillFieldAtAnyCost(page, sec, secType, spec, profile, qaStore, url);
      if (ok) { filled++; failed--; }
    }
  }

  console.log('\n  ══════════════════════════════════════════');
  console.log(`  ✓ My Experience done: ${filled} filled, ${failed} failed`);
  console.log('  ══════════════════════════════════════════\n');
  return filled;
}

export function mergeWorkdayDefaultExperienceEducation(profile) {
  if (!profile) return profile;
  profile.experience = { ...WORKDAY_DEFAULT_EXPERIENCE, ...(profile.experience || {}) };
  profile.education = { ...WORKDAY_DEFAULT_EDUCATION, ...(profile.education || {}) };
  return profile;
}

export { WORKDAY_DEFAULT_EXPERIENCE, WORKDAY_DEFAULT_EDUCATION };
