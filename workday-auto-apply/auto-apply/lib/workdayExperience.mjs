/**
 * workdayExperience.mjs — My Experience step (Work Experience + Education)
 *
 * Finds fields via DOM label scan (not brittle Playwright filters), expands
 * collapsed sections, fills with Playwright .fill() on spinbuttons + dropdowns.
 */

import { fillApplicationQuestionField } from './workdayQuestionFill.mjs';
import { handleDropdown, handleHierarchicalDropdown, handleSearchableDropdown, clickVisiblePromptOption, typeAndClickOption } from './fields.mjs';
import { resolveField, mapLabelToProfileValue, getNestedValue } from './planner.mjs';
import { createQAStore, saveAnswerToYaml } from './qaStore.mjs';
import { lookupDefaultAnswer, leadingYesNo, selectionMatchesAnswer } from './workdayDefaults.mjs';
import { getWorkdayTenant } from './discovery.mjs';
import { getTenantExperienceOverrides, getTenantEducationOverrides, saveAnswerToTenantYaml, lookupTenantAnswer } from './tenantQuestionYaml.mjs';
import { hydrateExperienceFromLlm, pickNearestSelectOption, resolveUnknownWithLlm } from './openRouterLlm.mjs';
import { collectLiveFieldOptions } from './workdayDom.mjs';
import { inferFromResumeFile, getResumePathForApply } from './resumeParser.mjs';
import {
  WORKDAY_DEFAULT_EXPERIENCE,
  WORKDAY_DEFAULT_EDUCATION,
  WORKDAY_FIELD_OF_STUDY_ATTEMPTS,
} from './workdayDefaults.mjs';
import { handleWebsitesSection } from './workdayWebsites.mjs';
import {
  skipOptionalExperienceSections,
  isOptionalSectionControl,
  isForbiddenOptionalAddName,
  OPTIONAL_SECTION_PATTERN,
} from './workdayOptionalSections.mjs';
import { disarmRiskyAddButtons, safeClick, isRiskyMisclickButton } from './safeClick.mjs';
import { resolveWorkDateRange, resolveEducationYearRange } from './experienceDates.mjs';
import { fillWorkdayDateField } from './workdayDateFill.mjs';

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * True when Workday is currently showing required/validation errors on the step.
 * Used to decide whether optional rows may be touched at all.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function pageHasValidationErrors(page) {
  return await page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-automation-id*="errorMessage"], [role="alert"], [class*="error"]');
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 200) continue;
      if (/successfully|success[!.]?$/i.test(text)) continue;
      if (/required|error|must be|please (enter|select)/i.test(text)) return true;
    }
    return false;
  }).catch(() => false);
}

function logBlock(section, field, lines) {
  console.log(`\n  ┌── ${section} › ${field} ──`);
  for (const line of lines) {
    console.log(`  │  ${line}`);
  }
  console.log('  └──');
}

function parseMonthYear(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12 || year < 1900 || year > 2100) return null;
  return { month, year, padded: `${String(month).padStart(2, '0')}/${year}` };
}

function valuesMatch(actual, expected) {
  const a = norm(actual).toLowerCase();
  const e = norm(expected).toLowerCase();
  if (!a || !e) return false;
  const expDate = parseMonthYear(expected);
  if (expDate) {
    const got = parseMonthYear(actual);
    return Boolean(got && got.month === expDate.month && got.year === expDate.year);
  }
  if (/^\d{4}$/.test(e)) return a === e || a.endsWith(e);
  // Yes/No compares on the leading word — "Yes, ... notified" is not a "No".
  if (leadingYesNo(a) || leadingYesNo(e)) return selectionMatchesAnswer(a, e);
  if (a === e || a.includes(e) || e.includes(a)) return true;
  if (/^[1-9]\d*\s+items?\s+selected/i.test(a)) {
    if (!e) return true;
    if (a.toLowerCase().includes(e.toLowerCase())) return true;
    return true;
  }
  if (/^other$/i.test(a) && /^other$/i.test(e)) return true;
  if (/bachelor/i.test(a) && /bachelor/i.test(e)) return true;
  if (/computer\s*science/i.test(a) && /computer\s*science/i.test(e)) return true;
  return false;
}

const DEGREE_VARIANTS = [
  "Bachelor's",
  'Bachelors',
  "Bachelor's Degree",
  'Bachelors Degree',
  'Bachelor of Science',
  'Bachelor of Arts',
  'Bachelor',
  'Undergraduate',
  'BS',
  'B.S.',
  'BA',
];

/**
 * Mark the best-matching field container on the page via data-wd-exp-target.
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function markFieldByLabel(page, labelPattern, sectionType = null) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-wd-exp-target]').forEach((el) => el.removeAttribute('data-wd-exp-target'));
  });

  const markerId = await page.evaluate(({ labelPattern, sectionType, optionalPattern }) => {
    const labelRe = new RegExp(labelPattern, 'i');
    const optionalRe = new RegExp(optionalPattern, 'i');
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    function detectSection(el) {
      let node = el;
      for (let depth = 0; depth < 40 && node; depth++) {
        const auto = (node.getAttribute?.('data-automation-id') || '').toLowerCase();
        if (/certificat|licen[cs]|language|award|publication|affiliation|reference|socialnetwork|volunteer/.test(auto)) {
          return 'optional';
        }
        // Narrow containers only — page-level workExperience wrappers are ignored here.
        if (/workexperiencesection|work-experience-section|workexperiencepanelset/.test(auto)) return 'work';
        if (/educationsection|educationpanelset/.test(auto)) return 'education';
        node = node.parentElement;
      }

      // Nearest preceding heading decides (avoids page-wide false work/education hits).
      let nearest = '';
      const headingEls = document.querySelectorAll('h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"]');
      for (const h of headingEls) {
        const t = norm(h.textContent);
        if (!t || t.length > 60) continue;
        if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          nearest = t;
        }
      }
      if (nearest) {
        if (optionalRe.test(nearest)) return 'optional';
        if (/work\s*experience/i.test(nearest)) return 'work';
        if (/^education\b/i.test(nearest)) return 'education';
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
      const labelText = raw
        .replace(/^\*+|\*+$/g, '')
        .replace(/\s+select(\s+one)?(\s+required)?\s*$/i, '')
        .replace(/\s+required\s*$/i, '')
        .trim();
      if (!labelRe.test(labelText)) continue;

      const sec = detectSection(labelEl);
      if (sec === 'optional') continue;
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
  }, { labelPattern, sectionType, optionalPattern: OPTIONAL_SECTION_PATTERN });

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

/** True when the section has fillable fields or an Add control on the current page (not nav-only). */
async function sectionPresentOnPage(page, sectionType) {
  return await page.evaluate((kind) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const labels = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]'));

    if (kind === 'work') {
      const hasAdd = buttons.some((btn) => /^add(\s+work)?\s*experience$/i.test(norm(btn.textContent))
        || /^add(\s+work)?\s*experience$/i.test(norm(btn.getAttribute('aria-label') || '')));
      const hasJobTitle = labels.some((el) => /^job\s*title/i.test(norm(el.textContent).replace(/\*+$/, '')));
      const hasWorkInput = Boolean(document.querySelector(
        '[data-automation-id*="workExperienceSection"] input:not([type="hidden"]), [data-automation-id*="work-experience-section"] input:not([type="hidden"]), [data-automation-id*="workExperiencePanelSet"] input:not([type="hidden"])'
      ));
      // Narrow Add only — never page-wide workExperience wrappers (those include Certifications).
      const hasSectionAdd = Boolean(document.querySelector(
        '[data-automation-id*="workExperienceSection"] button[data-automation-id="Add"], [data-automation-id*="work-experience-section"] button[data-automation-id="Add"], [data-automation-id*="workExperiencePanelSet"] button[data-automation-id="Add"]'
      ));
      return hasAdd || hasJobTitle || hasWorkInput || hasSectionAdd;
    }

    if (kind === 'education') {
      const hasAdd = buttons.some((btn) => /add\s*education/i.test(norm(btn.textContent)));
      const hasSchool = labels.some((el) => /school\s*or\s*university|^school$/i.test(norm(el.textContent).replace(/\*+$/, '')));
      const hasEduInput = Boolean(document.querySelector(
        '[data-automation-id*="education"] input:not([type="hidden"]), [data-automation-id*="education"] [role="combobox"]'
      ));
      const hasSectionAdd = Boolean(document.querySelector(
        '[data-automation-id*="education"] button[data-automation-id="Add"]'
      ));
      return hasAdd || hasSchool || hasEduInput || hasSectionAdd;
    }

    return false;
  }, sectionType).catch(() => false);
}

/**
 * True when the section already has a visible, fillable row (no Add click needed).
 * @param {import('playwright').Page} page
 * @param {'work'|'education'} sectionType
 */
async function sectionHasVisibleFields(page, sectionType) {
  const pattern = sectionType === 'work' ? 'job\\s*title' : 'school\\s*or\\s*university|^school$';
  const fieldLoc = await markFieldByLabel(page, pattern, sectionType);
  if (!fieldLoc) return false;
  return await fieldLoc.locator('input, textarea, [role="combobox"], button[aria-haspopup]').first()
    .isVisible({ timeout: 600 }).catch(() => false);
}

/**
 * True when Workday marks the whole section mandatory (heading asterisk,
 * aria-required, or a "… is required" error on the page).
 * @param {import('playwright').Page} page
 * @param {'work'|'education'} sectionType
 */
async function isSectionRequiredInDom(page, sectionType) {
  return await page.evaluate((kind) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const headingRe = kind === 'work' ? /work\s*experience/i : /^education/i;
    const errorRe = kind === 'work'
      ? /work\s*experience.{0,30}(is\s*)?required/i
      : /education.{0,30}(is\s*)?required/i;

    const body = norm(document.body?.innerText || '');
    if (errorRe.test(body)) return true;

    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"]');
    for (const h of headings) {
      const text = norm(h.textContent);
      if (!headingRe.test(text) || text.length > 60) continue;
      if (/\*/.test(text)) return true;
      if (h.querySelector('abbr[title*="required" i], [data-automation-id*="required" i]')) return true;
      const container = h.parentElement;
      if (container?.getAttribute?.('aria-required') === 'true') return true;
      if (/\*/.test(norm(container?.textContent).slice(0, text.length + 6))) return true;
    }
    return false;
  }, sectionType).catch(() => false);
}

/**
 * Click the Add control for Work Experience or Education only.
 * Never clicks Certifications / Languages / Awards / etc.
 * @param {import('playwright').Page} page
 * @param {'work'|'education'} sectionType
 * @returns {Promise<boolean>}
 */
async function clickRequiredSectionAdd(page, sectionType) {
  const marker = await page.evaluate(({ sectionType, optionalPattern }) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const optionalRe = new RegExp(optionalPattern, 'i');
    const headingSelector = 'h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"],[data-automation-id="panelTitle"]';
    const headingRe = sectionType === 'work' ? /work\s*experience/i : /^education\b/i;
    // ONLY named Adds — never bare "Add" (bare Add is how Certifications get clicked).
    const namedAddRe = sectionType === 'work'
      ? /^add(\s+work)?\s*experience$/i
      : /^add\s*education$/i;
    const forbiddenAddRe = /add(\s+(another|a|an|new))?\s*(certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social|volunteer|credential|websites?)/i;

    document.querySelectorAll('[data-wd-section-add]').forEach((el) => el.removeAttribute('data-wd-section-add'));

    const nearestHeading = (el) => {
      let nearest = '';
      for (const h of document.querySelectorAll(headingSelector)) {
        const text = norm(h.textContent);
        if (!text || text.length > 60) continue;
        if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          nearest = text;
        }
      }
      return nearest;
    };

    const isForbidden = (btn) => {
      if (btn.getAttribute('data-wd-optional-add-blocked') === '1') return true;
      const name = [
        btn.getAttribute('aria-label') || '',
        btn.textContent || '',
        btn.getAttribute('title') || '',
      ].map(norm).join(' ');
      if (forbiddenAddRe.test(name)) return true;
      const heading = nearestHeading(btn);
      if (optionalRe.test(heading)) return true;
      let node = btn;
      for (let d = 0; d < 20 && node; d++) {
        const auto = (node.getAttribute?.('data-automation-id') || '');
        if (/certificat|licen[cs]|language|award|publication|affiliation|reference|socialNetwork|volunteer/i.test(auto)) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const mark = (btn, via) => {
      const id = `wd-add-${Math.random().toString(36).slice(2, 8)}`;
      btn.setAttribute('data-wd-section-add', id);
      return { id, via };
    };

    // Only explicit "Add Work Experience" / "Add Education" — never bare Add.
    for (const btn of document.querySelectorAll('button, [role="button"], a[role="button"]')) {
      const text = norm(btn.textContent);
      const aria = norm(btn.getAttribute('aria-label'));
      if (!(namedAddRe.test(text) || namedAddRe.test(aria))) continue;
      if (isForbidden(btn)) continue;
      if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
      // Heading must also match (or be empty for some tenants)
      const heading = nearestHeading(btn);
      if (heading && optionalRe.test(heading)) continue;
      if (heading && !headingRe.test(heading) && !namedAddRe.test(text) && !namedAddRe.test(aria)) continue;
      return mark(btn, 'named');
    }

    // Bare "Add" ONLY when nearest heading is Work Experience / Education (never Certifications).
    const narrowSelectors = sectionType === 'work'
      ? [
        '[data-automation-id*="workExperienceSection"]',
        '[data-automation-id*="work-experience-section"]',
        '[data-automation-id*="workExperiencePanelSet"]',
      ]
      : [
        '[data-automation-id*="educationSection"]',
        '[data-automation-id*="educationPanelSet"]',
      ];
    const roots = [];
    for (const sel of narrowSelectors) roots.push(...document.querySelectorAll(sel));
    if (!roots.length) {
      for (const h of document.querySelectorAll(headingSelector)) {
        const text = norm(h.textContent);
        if (!headingRe.test(text) || text.length > 60) continue;
        const root = h.closest(
          '[data-automation-id*="panelSet"], [data-automation-id*="panel-set"], [data-automation-id*="Panel"], [data-automation-id*="section"], fieldset, [role="group"]'
        ) || h.parentElement;
        if (root) roots.push(root);
      }
    }
    for (const root of roots) {
      for (const btn of root.querySelectorAll('button[data-automation-id="Add"], button, [role="button"]')) {
        if (isForbidden(btn)) continue;
        const text = norm(btn.textContent);
        const aria = norm(btn.getAttribute('aria-label'));
        const auto = btn.getAttribute('data-automation-id') || '';
        const isBareAdd = auto === 'Add' || /^(add|\+)$/i.test(text) || /^(add|\+)$/i.test(aria);
        if (!isBareAdd) continue;
        if (forbiddenAddRe.test(`${text} ${aria}`)) continue;
        const heading = nearestHeading(btn);
        if (!headingRe.test(heading)) continue;
        if (optionalRe.test(heading)) continue;
        if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
        return mark(btn, 'section-add-scoped');
      }
    }

    return null;
  }, { sectionType, optionalPattern: OPTIONAL_SECTION_PATTERN });

  if (!marker?.id) return false;

  const btn = page.locator(`[data-wd-section-add="${marker.id}"]`).first();
  if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) return false;
  if (await isOptionalSectionControl(btn)) {
    console.log(`    ⏭️  Blocked Add click — optional section control (${sectionType})`);
    return false;
  }
  const accessible = norm(await btn.getAttribute('aria-label').catch(() => '') || await btn.innerText().catch(() => ''));
  if (isForbiddenOptionalAddName(accessible)) {
    console.log(`    ⏭️  Blocked Add click — forbidden name "${accessible}"`);
    return false;
  }
  if ((await btn.getAttribute('data-wd-optional-add-blocked').catch(() => '')) === '1') {
    console.log(`    ⏭️  Blocked Add click — disarmed optional Add`);
    return false;
  }
  if (isRiskyMisclickButton(accessible, { allowSectionAdd: true })) {
    console.log(`    ⏭️  Blocked Add click — risky misclick "${accessible}"`);
    return false;
  }

  const clicked = await safeClick(btn, {}, { allowSectionAdd: true });
  if (!clicked) return false;
  await page.waitForTimeout(900);
  console.log(`    ✓ Clicked ${sectionType} Add (${marker.via})`);
  return true;
}

/** Expand Work Experience / Education if collapsed (visible fillable input missing). */
async function ensureSectionsExpanded(page) {
  const checks = [
    {
      name: 'Work Experience',
      fieldRe: /job\s*title/i,
      sectionType: 'work',
    },
    {
      name: 'Education',
      fieldRe: /school\s*or\s*university|^school$/i,
      sectionType: 'education',
    },
  ];

  for (const check of checks) {
    if (!(await sectionPresentOnPage(page, check.sectionType))) {
      console.log(`  ℹ️  ${check.name} section not on this application — skipping expand`);
      continue;
    }

    const fieldLoc = await markFieldByLabel(page, check.fieldRe.source || check.fieldRe, check.sectionType);
    const visible = fieldLoc && await fieldLoc.locator('input, textarea, [role="combobox"], button[aria-haspopup]').first()
      .isVisible({ timeout: 600 }).catch(() => false);

    if (visible) {
      console.log(`  ✓ ${check.name} section already expanded`);
      continue;
    }

    console.log(`  ➕ Expanding ${check.name} section...`);
    const clicked = await clickRequiredSectionAdd(page, check.sectionType);
    if (!clicked) {
      console.log(`    ℹ️  Could not expand ${check.name} — no section-specific Add button found`);
    }
  }
}

async function findFieldLocator(page, spec, sectionType) {
  const pattern = spec.labelPattern || spec.label;
  let loc = await markFieldByLabel(page, pattern, sectionType);
  if (loc && await loc.count()) return loc;
  if (sectionType) {
    loc = await markFieldByLabel(page, pattern, null);
    if (loc && await loc.count()) return loc;
  }

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
    const spinSel = 'input[role="spinbutton"], [data-automation-id*="dateSectionMonth"] input, [data-automation-id*="dateSectionYear"] input, [data-automation-id*="dateInputWrapper"] input, [data-automation-id*="dateSection"] input';
    const placeholder = /^(m+|y+|d+|mm|yyyy|yy|dd|empty)$/i;
    const spinValue = (el) => {
      const v = (el?.value || el?.getAttribute('aria-valuenow') || el?.getAttribute('aria-valuetext') || '').trim();
      return !v || placeholder.test(v) ? '' : v;
    };
    const spins = Array.from(field.querySelectorAll(spinSel));
    if (spins.length >= 2) {
      const classify = (el) => {
        const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-automation-id') || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
        if (/year|yyyy|yy|dateSectionYear/.test(hint)) return 'year';
        if (/month|mm|dateSectionMonth/.test(hint)) return 'month';
        return '';
      };
      const monthEl = spins.find((el) => classify(el) === 'month') || spins[0];
      const yearEl = spins.find((el) => classify(el) === 'year') || spins[1];
      const month = spinValue(monthEl);
      const year = spinValue(yearEl);
      if (month && year) return `${month}/${year}`;
    } else if (spins.length === 1 && spinValue(spins[0])) {
      return spinValue(spins[0]);
    }
    const textarea = field.querySelector('textarea');
    if (textarea?.value) return normalize(textarea.value);
    const input = field.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    if (input && input.getAttribute('role') !== 'spinbutton' && input.value) {
      return normalize(input.value);
    }
    const pills = field.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id*="pill"], [data-automation-id*="chip"], [data-automation-id*="token"]');
    const pillTexts = Array.from(pills)
      .map((el) => normalize(el.textContent))
      .filter((t) => t && !/^select(\s+one)?$/i.test(t) && !/items?\s*selected/i.test(t));
    if (pillTexts.length) return pillTexts[0];
    const btn = field.querySelector('[data-automation-id="selectWidget"] button, button[aria-haspopup="listbox"], [role="combobox"]');
    if (btn) {
      const t = normalize(btn.textContent);
      if (/^\d+\s+items?\s+selected/i.test(t)) {
        const selected = field.querySelector('[aria-selected="true"], [data-automation-id="selectedItem"]');
        const picked = normalize(selected?.textContent);
        if (picked) return picked;
        const m = t.match(/selected[,:\s]+(.+)/i);
        if (m?.[1]) return normalize(m[1]);
        return t;
      }
      if (t && !/^select(\s+one)?$/i.test(t) && !/^0 items selected$/i.test(t) && !/^no items selected$/i.test(t)) return t;
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

/** CSS for Workday month/year calendar spin map (and dateSection inputs). */
const DATE_SPIN_SEL = [
  'input[role="spinbutton"]',
  '[data-automation-id*="dateSectionMonth"] input',
  '[data-automation-id*="dateSectionYear"] input',
  '[data-automation-id*="dateInputWrapper"] input',
  '[data-automation-id*="dateSection"] input',
].join(', ');

/**
 * Read a spin's displayed value (value or aria-valuenow).
 * @param {import('playwright').Locator} spin
 */
async function readSpinDigits(spin) {
  return await spin.evaluate((el) => {
    const v = (el.value || el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext') || '').trim();
    return v;
  }).catch(() => '');
}

/**
 * Write one spin segment the way Workday's calendar map expects: focus → type → Tab/Enter.
 * Falls back to native value setter + InputEvent when typing does not stick.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} spin
 * @param {string|number} digits
 * @returns {Promise<boolean>}
 */
async function setOneSpin(page, spin, digits) {
  const val = String(digits);
  const matches = async () => {
    const got = await readSpinDigits(spin);
    return String(got) === val || String(Number(got)) === String(Number(val));
  };

  await spin.scrollIntoViewIfNeeded().catch(() => {});
  await spin.click({ force: true }).catch(() => {});
  await page.waitForTimeout(40);

  // 1) Keyboard type into the calendar spin map (most reliable on live Workday).
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(val, { delay: 45 });
  await page.keyboard.press('Tab').catch(() => {});
  if (await matches()) return true;

  await spin.click({ force: true }).catch(() => {});
  await spin.press('Control+A').catch(() => {});
  await spin.pressSequentially(val, { delay: 40 });
  await spin.press('Enter').catch(() => {});
  if (await matches()) return true;

  // 2) Playwright fill (works when the spin is a normal input).
  await spin.fill('').catch(() => {});
  await spin.fill(val).catch(() => {});
  await spin.press('Tab').catch(() => {});
  if (await matches()) return true;

  // 3) Native setter + InputEvent (React-controlled masked spins).
  await spin.evaluate((el, v) => {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc?.set?.call(el, v);
    el.setAttribute('aria-valuenow', String(Number(v) || v));
    el.setAttribute('aria-valuetext', v);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: v,
      inputType: 'insertReplacementText',
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, val).catch(() => {});
  return matches();
}

/**
 * Locate month/year spin inputs for a From/To field (search field, then parents/siblings).
 * @param {import('playwright').Locator} fieldLoc
 * @returns {Promise<{spins: import('playwright').Locator, count: number, monthIdx: number, yearIdx: number}>}
 */
async function locateDateSpins(fieldLoc) {
  // Prefer spins inside the marked field; widen to nearby form wrappers if empty.
  let spins = fieldLoc.locator(DATE_SPIN_SEL);
  let count = await spins.count();

  if (count < 1) {
    const widened = fieldLoc.locator(
      'xpath=ancestor::*[contains(@data-automation-id,"formField") or contains(@data-automation-id,"Field") or self::fieldset][1]'
    ).first();
    if (await widened.count()) {
      spins = widened.locator(DATE_SPIN_SEL);
      count = await spins.count();
      if (count >= 1) fieldLoc = widened;
    }
  }

  if (count < 1) {
    // Sibling date wrappers (some tenants put spins next to the label field).
    const sibling = fieldLoc.locator(
      'xpath=following-sibling::*[1]//input[@role="spinbutton"] | following-sibling::*[contains(@data-automation-id,"date")][1]//input'
    );
    const sibCount = await sibling.count().catch(() => 0);
    if (sibCount >= 1) {
      spins = fieldLoc.locator(
        'xpath=following-sibling::*[1]//input | following-sibling::*[contains(@data-automation-id,"date")][1]//input'
      );
      count = await spins.count();
    }
  }

  if (count < 1) return { spins, count: 0, monthIdx: 0, yearIdx: 0 };

  const indexed = await spins.evaluateAll((els) => els.map((el, i) => {
    const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-automation-id') || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
    return { i, hint };
  }));
  const monthIdx = indexed.find((s) => /month|\bmm\b|dateSectionMonth/i.test(s.hint) && !/year|yyyy/i.test(s.hint))?.i
    ?? indexed.find((s) => /month|\bmm\b/i.test(s.hint))?.i
    ?? 0;
  let yearIdx = indexed.find((s) => /year|yyyy|dateSectionYear/i.test(s.hint))?.i;
  if (yearIdx == null || yearIdx === monthIdx) {
    yearIdx = count >= 2 ? (monthIdx === 0 ? 1 : 0) : monthIdx;
  }
  return { spins, count, monthIdx, yearIdx };
}

/**
 * DOM bulk-write month+year into spins under the field (portal-safe parent walk).
 * @param {import('playwright').Locator} fieldLoc
 * @param {string} monthVal
 * @param {string} year
 */
async function writeMonthYearInDom(fieldLoc, monthVal, year) {
  return await fieldLoc.evaluate((root, { monthVal, year }) => {
    const sel = 'input[role="spinbutton"], [data-automation-id*="dateSectionMonth"] input, [data-automation-id*="dateSectionYear"] input, [data-automation-id*="dateInputWrapper"] input, [data-automation-id*="dateSection"] input';

    function collect(from) {
      const list = Array.from(from.querySelectorAll(sel));
      if (list.length) return list;
      let node = from.parentElement;
      for (let d = 0; d < 5 && node; d++) {
        const found = Array.from(node.querySelectorAll(sel));
        if (found.length >= 1) return found;
        node = node.parentElement;
      }
      let sib = from.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++) {
        const found = Array.from(sib.querySelectorAll(sel));
        if (found.length >= 1) return found;
        sib = sib.nextElementSibling;
      }
      return [];
    }

    function classify(el) {
      const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-automation-id') || ''} ${el.id || ''}`.toLowerCase();
      if (/year|yyyy|dateSectionYear/.test(hint)) return 'year';
      if (/month|mm|dateSectionMonth/.test(hint)) return 'month';
      return '';
    }

    function setVal(el, v) {
      if (!el) return false;
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc?.set?.call(el, v);
      el.value = v;
      el.setAttribute('aria-valuenow', String(Number(v) || v));
      el.setAttribute('aria-valuetext', v);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, data: v, inputType: 'insertReplacementText',
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      const got = (el.value || el.getAttribute('aria-valuenow') || '').trim();
      return String(got) === String(v) || String(Number(got)) === String(Number(v));
    }

    const list = collect(root);
    if (!list.length) return { ok: false, reason: 'no spins in DOM' };

    let monthEl = list.find((el) => classify(el) === 'month');
    let yearEl = list.find((el) => classify(el) === 'year');
    if (!monthEl && list.length >= 2) monthEl = list[0];
    if (!yearEl && list.length >= 2) yearEl = list[1];
    if (!yearEl && list.length === 1) yearEl = list[0];

    const monthOk = monthEl ? setVal(monthEl, monthVal) : true;
    const yearOk = yearEl ? setVal(yearEl, year) : false;
    // Re-set month if year edit cleared it.
    const monthOk2 = monthEl ? (setVal(monthEl, monthVal) || monthOk) : monthOk;
    const readM = monthEl ? (monthEl.value || monthEl.getAttribute('aria-valuenow') || '') : '';
    const readY = yearEl ? (yearEl.value || yearEl.getAttribute('aria-valuenow') || '') : '';
    const ok = (list.length === 1)
      ? (yearOk || String(readY) === String(year) || String(readM).includes(year))
      : (String(Number(readM)) === String(Number(monthVal)) && String(readY) === String(year));
    return { ok, monthOk: monthOk2, yearOk, read: `${readM}/${readY}`, count: list.length };
  }, { monthVal, year }).catch(() => ({ ok: false, reason: 'evaluate failed' }));
}

/**
 * Fill Workday MM/YYYY calendar spin map: type month → Tab, type year → Tab/Enter.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} fieldLoc
 * @param {string} mmYYYY
 */
async function fillSpinMonthYearOnce(page, fieldLoc, mmYYYY) {
  const parsed = parseMonthYear(mmYYYY);
  if (!parsed) return { ok: false, attempts: [`invalid MM/YYYY: ${mmYYYY}`] };
  const monthVal = String(parsed.month).padStart(2, '0');
  const monthBare = String(parsed.month);
  const year = String(parsed.year);
  const attempts = [];

  const before = await readFieldValue(fieldLoc);
  if (valuesMatch(before, parsed.padded)) {
    return { ok: true, attempts: [`already ${parsed.padded}`] };
  }

  await fieldLoc.scrollIntoViewIfNeeded().catch(() => {});

  let { spins, count, monthIdx, yearIdx } = await locateDateSpins(fieldLoc);

  // Single textbox that accepts the full MM/YYYY string.
  if (count < 2) {
    const textish = fieldLoc.locator(
      'input[role="spinbutton"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
    ).first();
    if (await textish.isVisible({ timeout: 400 }).catch(() => false)) {
      await textish.click({ force: true }).catch(() => {});
      await textish.fill('').catch(() => {});
      await page.keyboard.type(parsed.padded, { delay: 35 });
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(120);
      const afterText = await readFieldValue(fieldLoc);
      if (valuesMatch(afterText, parsed.padded)) {
        attempts.push(`typed "${parsed.padded}" + Enter → "${afterText}" ✓`);
        return { ok: true, attempts };
      }
      attempts.push(`typed full "${parsed.padded}" → "${afterText || '(empty)'}" ✗`);
    }
  }

  // Retry locate after focusing the field (lazy-rendered spins).
  if (count < 2) {
    await fieldLoc.click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    ({ spins, count, monthIdx, yearIdx } = await locateDateSpins(fieldLoc));
  }

  if (count >= 2) {
    const monthSpin = spins.nth(monthIdx);
    const yearSpin = spins.nth(yearIdx);

    let monthOk = await setOneSpin(page, monthSpin, monthVal);
    if (!monthOk) monthOk = await setOneSpin(page, monthSpin, monthBare);
    let yearOk = await setOneSpin(page, yearSpin, year);

    // Year edit sometimes clears month — rewrite month, then Tab off.
    const monthNow = await readSpinDigits(monthSpin);
    if (String(Number(monthNow)) !== String(Number(monthVal))) {
      monthOk = await setOneSpin(page, monthSpin, monthVal);
      yearOk = (await readSpinDigits(yearSpin)) === year || yearOk;
    }
    await yearSpin.press('Tab').catch(() => {});
    await page.waitForTimeout(100);

    let after = await readFieldValue(fieldLoc);
    if (valuesMatch(after, parsed.padded)) {
      attempts.push(`spin type month=${monthVal} year=${year} → "${after}" ✓`);
      return { ok: true, attempts };
    }
    attempts.push(`spin type month ${monthOk ? '✓' : '✗'} year ${yearOk ? '✓' : '✗'} → "${after || '(empty)'}" ✗`);
  } else if (count === 1) {
    // Rare: one spin that still accepts MMYYYY or year only — try composite then fail over.
    await setOneSpin(page, spins.first(), monthVal);
    await setOneSpin(page, spins.first(), year);
  }

  // DOM evaluate fallback (React-controlled / portal-adjacent spins).
  const dom = await writeMonthYearInDom(fieldLoc, monthVal, year);
  await page.waitForTimeout(80);
  const afterDom = await readFieldValue(fieldLoc);
  if (dom?.ok || valuesMatch(afterDom, parsed.padded)) {
    attempts.push(`DOM spin write → "${afterDom || dom?.read || ''}" ✓`);
    return { ok: true, attempts };
  }
  if (dom?.reason) attempts.push(`DOM write: ${dom.reason}`);
  else attempts.push(`DOM write → "${afterDom || dom?.read || '(empty)'}" ✗`);

  if (count < 2) attempts.push('no MM/YYYY spin pair');
  return { ok: false, attempts };
}

/**
 * Fill education (or year-only) spin. If the control is MM/YYYY, fills 01/YYYY.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} fieldLoc
 * @param {string|number} year
 */
async function fillSpinYearOnce(page, fieldLoc, year) {
  const y = String(year);
  const attempts = [];
  await fieldLoc.scrollIntoViewIfNeeded().catch(() => {});

  let { spins, count, monthIdx, yearIdx } = await locateDateSpins(fieldLoc);
  if (count < 1) {
    await fieldLoc.click({ force: true }).catch(() => {});
    await page.waitForTimeout(120);
    ({ spins, count, monthIdx, yearIdx } = await locateDateSpins(fieldLoc));
  }

  // Education From/To often renders as MM/YYYY — fill January of that year.
  if (count >= 2) {
    const asMonthYear = `01/${y}`;
    const result = await fillSpinMonthYearOnce(page, fieldLoc, asMonthYear);
    attempts.push(...(result.attempts || []), `education year as ${asMonthYear}`);
    if (result.ok) return { ok: true, attempts };
    // Still try year segment alone if monthyear path failed verification.
  }

  if (count < 1) return { ok: false, attempts: [...attempts, 'no year spin'] };

  const spin = spins.nth(count > 1 ? yearIdx : 0);
  const okSet = await setOneSpin(page, spin, y);
  await spin.press('Tab').catch(() => {});
  const actual = await readSpinDigits(spin) || await readFieldValue(fieldLoc);
  const ok = okSet || String(actual).includes(y);
  attempts.push(ok ? `year ${y} typed → "${actual}" ✓` : `year ${y} typed → "${actual}" ✗`);

  if (!ok) {
    const dom = await writeMonthYearInDom(fieldLoc, '01', y);
    const after = await readFieldValue(fieldLoc);
    if (dom?.ok || String(after).includes(y)) {
      attempts.push(`DOM year write → "${after || dom?.read}" ✓`);
      return { ok: true, attempts };
    }
  }
  return { ok, attempts };
}

async function fillTypeAndEnter(page, fieldLoc, text) {
  const attempts = [];
  const typed = await typeAndClickOption(page, fieldLoc, text);
  let after = await readFieldValue(fieldLoc);
  let ok = typed.ok || valuesMatch(after, text) || /other|computer\s*science/i.test(after);

  if (!ok && /^other$/i.test(String(text))) {
    const input = fieldLoc.locator('input:not([type="hidden"]):not([type="checkbox"]):not([role="spinbutton"])').first();
    if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
      await input.click({ force: true }).catch(() => {});
      await input.fill('Other');
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(400);
      after = await readFieldValue(fieldLoc);
      ok = valuesMatch(after, 'Other') || /other/i.test(after);
      attempts.push(ok ? 'input Other + Enter ✓' : 'input Other + Enter ✗');
    }
  }

  if (!ok) {
    attempts.push(`typed "${text}" → "${after || '(empty)'}" ✗`);
  } else {
    attempts.push(`typed "${text}" clicked "${typed.selected || after || text}" ✓`);
  }
  return { ok, selected: typed.selected || after || text, attempts };
}

/**
 * Nearest live option without a network call — exact, then substring, then
 * label-specific fallbacks. Returns null rather than guessing.
 * @param {string} label
 * @param {string[]} options live option texts read from the DOM
 * @param {string|string[]} preferred
 * @returns {string|null}
 */
function pickLocalNearestOption(label, options = [], preferred = '') {
  const list = options
    .map((o) => norm(typeof o === 'string' ? o : o?.text))
    .filter(Boolean);
  if (!list.length) return null;

  const raw = Array.isArray(preferred) ? preferred[preferred.length - 1] : preferred;
  const want = norm(raw).toLowerCase();
  if (want) {
    const exact = list.find((o) => o.toLowerCase() === want);
    if (exact) return exact;
    const partial = list.find((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()));
    if (partial) return partial;
  }

  const fallbacks = [];
  if (/school|university|institution/i.test(label)) fallbacks.push(/^other\b/i, /not listed/i, /not in (the )?list/i);
  if (/degree/i.test(label)) fallbacks.push(/bachelor/i, /^b\.?s\.?\b/i, /undergraduate/i);
  if (/field\s*of\s*study|major/i.test(label)) fallbacks.push(/computer\s*science/i, /information technology/i, /engineering/i);
  for (const re of fallbacks) {
    const hit = list.find((o) => re.test(o));
    if (hit) return hit;
  }
  return null;
}

async function fillDropdownAggressive(page, fieldLoc, value, label, { searchable = false } = {}) {
  const attempts = [];
  const options = /degree/i.test(label) || !searchable
    ? [value, ...DEGREE_VARIANTS]
    : [value];
  let uniqueOptions = [...new Set(options.map(String).filter(Boolean))];

  const live = await collectLiveFieldOptions(page, label, 'dropdown').catch(() => []);
  if (live.length) {
    const present = uniqueOptions.filter((opt) => live.some((o) => valuesMatch(o, opt)));
    const narrowed = present.length ? present : [pickLocalNearestOption(label, live, value)].filter(Boolean);
    if (narrowed.length) {
      attempts.push(`live options narrowed to: ${narrowed.join(', ')}`);
      uniqueOptions = narrowed;
    }
  }

  for (const opt of uniqueOptions) {
    const typed = await typeAndClickOption(page, fieldLoc, opt);
    const after = await readFieldValue(fieldLoc);
    if (typed.ok || valuesMatch(after, opt)) {
      attempts.push(`typed+clicked "${typed.selected || opt}" ✓`);
      return { ok: true, selected: typed.selected || after || opt, attempts };
    }
    attempts.push(`type+click "${opt}" ✗`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  const trigger = fieldLoc.locator(
    '[data-automation-id="selectWidget"] button, button[aria-haspopup="listbox"], [role="combobox"], input[role="combobox"]'
  ).first();

  if (!(await trigger.isVisible({ timeout: 800 }).catch(() => false))) {
    const appOk = await fillApplicationQuestionField(page, label, 'select', value);
    attempts.push(appOk ? 'fillApplicationQuestionField(select) ✓' : 'no dropdown trigger ✗');
    return { ok: appOk, selected: value, attempts };
  }

  for (const opt of uniqueOptions) {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    const clicked = await clickVisiblePromptOption(page, [opt, String(opt)]);
    if (clicked || valuesMatch(await readFieldValue(fieldLoc), opt)) {
      attempts.push(`selected "${clicked || opt}" ✓`);
      return { ok: true, selected: clicked || opt, attempts };
    }
    const result = await handleDropdown(page, trigger, opt, label);
    if (result.success) {
      attempts.push(`handleDropdown("${opt}") ✓`);
      return { ok: true, selected: opt, attempts };
    }
    attempts.push(`try "${opt}" ✗`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  return { ok: false, attempts };
}

function isFieldOfStudyFilled(current, leaf = '') {
  const shown = norm(current);
  if (!shown || /^select(\s+one)?/i.test(shown)) return false;
  if (leaf && valuesMatch(shown, leaf)) return true;
  return shown.length >= 3;
}

/**
 * Fill required Education › Field of Study without a 30s hang.
 * Types Computer Science (or the profile leaf) and clicks the matching option.
 * @param {import('playwright').Page} page
 * @param {string|string[]} [answer]
 * @returns {Promise<boolean>}
 */
export async function fillEducationFieldOfStudy(page, answer = 'Computer Science') {
  const leaf = Array.isArray(answer) ? String(answer[answer.length - 1] || 'Computer Science') : String(answer || 'Computer Science');
  const tries = [leaf, ...WORKDAY_FIELD_OF_STUDY_ATTEMPTS.map((c) => c[c.length - 1])];
  const unique = [...new Set(tries.filter(Boolean))];

  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-wd-fos]').forEach((el) => el.removeAttribute('data-wd-fos'));
    const labels = document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]');
    for (const el of labels) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/field\s*of\s*study/i.test(t) || t.length > 80) continue;
      const field = el.closest('[data-automation-id*="formField"], [data-automation-id*="Field"], fieldset, [role="group"]')
        || el.parentElement;
      if (!field) continue;
      field.setAttribute('data-wd-fos', '1');
      return true;
    }
    return false;
  }).catch(() => false);

  const field = marked
    ? page.locator('[data-wd-fos="1"]').first()
    : page.getByLabel(/field\s*of\s*study/i).first();

  const shown = marked ? await readFieldValue(field).catch(() => '') : '';
  if (isFieldOfStudyFilled(shown, leaf)) {
    console.log(`    ✓ Field of Study already "${shown}"`);
    return true;
  }

  const combo = field.locator(
    '[role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, input[role="combobox"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([role="spinbutton"])'
  ).first();

  await field.scrollIntoViewIfNeeded().catch(() => {});
  await combo.click({ force: true, timeout: 4000 }).catch(async () => {
    await field.click({ force: true, timeout: 4000 }).catch(() => {});
  });
  await page.waitForTimeout(250);

  for (const term of unique) {
    const search = page.locator('input[role="searchbox"]:visible, input[type="search"]:visible, input[placeholder*="Search" i]:visible, input[role="combobox"]:visible').last();
    if (await search.isVisible({ timeout: 600 }).catch(() => false)) {
      await search.fill('').catch(() => {});
      await search.pressSequentially(term, { delay: 35 });
    } else {
      await page.keyboard.type(term, { delay: 35 });
    }
    await page.waitForTimeout(350);
    const picked = await clickVisiblePromptOption(page, [term, 'Computer Science', 'Computer Engineering']);
    if (!picked) await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape').catch(() => {});
    const after = marked ? await readFieldValue(field).catch(() => '') : '';
    if (picked || isFieldOfStudyFilled(after, term)) {
      console.log(`    ✅ Field of Study ← "${after || term}"`);
      return true;
    }
  }
  console.log('    ✗ Field of Study still empty after type+option');
  return false;
}

async function fillFieldOfStudy(page, fieldLoc, answer) {
  const attempts = [];
  const leaf = Array.isArray(answer) ? answer[answer.length - 1] : (answer || 'Computer Science');
  const pageOk = await fillEducationFieldOfStudy(page, answer);
  if (pageOk) return { ok: true, selected: leaf, attempts: [`page Field of Study "${leaf}" ✓`] };
  const current = fieldLoc ? await readFieldValue(fieldLoc) : '';
  if (isFieldOfStudyFilled(current, leaf)) {
    return { ok: true, selected: current, attempts: [`already "${current}"`] };
  }
  const typed = await typeAndClickOption(page, fieldLoc, leaf);
  const afterTyped = await readFieldValue(fieldLoc);
  if (typed.ok || isFieldOfStudyFilled(afterTyped, leaf)) {
    attempts.push(`typed "${leaf}" clicked "${typed.selected || afterTyped || leaf}" ✓`);
    return { ok: true, selected: typed.selected || afterTyped || leaf, attempts };
  }
  attempts.push(`type+click "${leaf}" ✗`);

  const chains = [];
  if (Array.isArray(answer) && answer.length) chains.push(answer.map(String));
  else if (answer) chains.push([String(answer)]);
  for (const extra of WORKDAY_FIELD_OF_STUDY_ATTEMPTS) {
    if (!chains.some((c) => c.join('>') === extra.join('>'))) chains.push(extra);
  }

  const trigger = fieldLoc.locator(
    '[data-automation-id="selectWidget"] button, button[aria-haspopup="listbox"], [role="combobox"], input[role="combobox"]'
  ).first();

  for (const chain of chains) {
    const leaf = chain[chain.length - 1];
    const parent = chain.length > 1 ? chain[0] : '';

    if (await trigger.isVisible({ timeout: 600 }).catch(() => false)) {
      if (parent) {
        const hier = await handleHierarchicalDropdown(page, trigger, parent, leaf);
        attempts.push(hier.success ? `hierarchy ${parent} → ${leaf} ✓` : `hierarchy ${parent} → ${leaf} ✗`);
        if (hier.success && isFieldOfStudyFilled(await readFieldValue(fieldLoc), leaf)) {
          return { ok: true, selected: leaf, attempts };
        }
      }

      const searched = await handleSearchableDropdown(page, trigger, leaf, leaf, { confirmWithEnter: false });
      if (searched.success) {
        const clicked = await clickVisiblePromptOption(page, [leaf]);
        if (clicked || isFieldOfStudyFilled(await readFieldValue(fieldLoc), leaf)) {
          attempts.push(`search "${leaf}" ✓`);
          return { ok: true, selected: clicked || leaf, attempts };
        }
      }

      const typed = await fillDropdownAggressive(page, fieldLoc, leaf, 'Field of Study', { searchable: true });
      attempts.push(...(typed.attempts || []));
      if (typed.ok || isFieldOfStudyFilled(await readFieldValue(fieldLoc), leaf)) {
        return { ok: true, selected: typed.selected || leaf, attempts };
      }
    }

    const appOk = await fillApplicationQuestionField(page, 'Field of Study', 'select', leaf);
    attempts.push(appOk ? `formField "${leaf}" ✓` : `formField "${leaf}" ✗`);
    if (appOk) return { ok: true, selected: leaf, attempts };
  }

  const after = await readFieldValue(fieldLoc);
  return { ok: isFieldOfStudyFilled(after, leaf), selected: after || leaf, attempts };
}

/** Tenant overrides may use "from_date" or "experience.from_date" — normalize both. */
function stripKeyPrefix(overrides, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value == null || value === '') continue;
    out[key.startsWith(prefix) ? key.slice(prefix.length) : key] = value;
  }
  return out;
}

/**
 * From/To values for the four date fields, read from the real sources
 * (tenant override → profile/Apply Wizz → defaults) and validated as a range.
 * @returns {string|null}
 */
function resolveDateFieldAnswer(profileKey, profile, tenantExp, tenantEdu) {
  if (profileKey === 'experience.from_date' || profileKey === 'experience.to_date') {
    const source = {
      ...WORKDAY_DEFAULT_EXPERIENCE,
      ...(profile?.experience || {}),
      ...stripKeyPrefix(tenantExp, 'experience.'),
    };
    const range = resolveWorkDateRange(source);
    for (const note of range.notes) console.log(`    📅 Work dates — ${note}`);
    return profileKey === 'experience.from_date' ? range.from : range.to;
  }

  const source = {
    ...WORKDAY_DEFAULT_EDUCATION,
    ...(profile?.education || {}),
    ...stripKeyPrefix(tenantEdu, 'education.'),
  };
  const range = resolveEducationYearRange(source);
  for (const note of range.notes) console.log(`    📅 Education years — ${note}`);
  return profileKey === 'education.from_year' ? range.from : range.to;
}

const DATE_PROFILE_KEYS = new Set([
  'experience.from_date',
  'experience.to_date',
  'education.from_year',
  'education.to_year',
]);

async function resolveAnswer(label, profileKey, labelText, profile, qaStore, url, fieldType) {
  const tenant = getWorkdayTenant(url);
  const tenantExp = getTenantExperienceOverrides(tenant);
  const tenantEdu = getTenantEducationOverrides(tenant);

  // Dates are never hardcoded here — a wrong date is worse than an empty one.
  if (DATE_PROFILE_KEYS.has(profileKey)) {
    return resolveDateFieldAnswer(profileKey, profile, tenantExp, tenantEdu);
  }

  if (profileKey === 'education.university') return 'Other';
  if (profileKey === 'education.degree') return profile?.education?.degree || "Bachelor's";
  if (profileKey === 'education.field_of_study_hierarchy' || /field\s*of\s*study/i.test(labelText)) {
    const major = profile?.education?.major
      || (Array.isArray(profile?.education?.field_of_study_hierarchy)
        ? profile.education.field_of_study_hierarchy[profile.education.field_of_study_hierarchy.length - 1]
        : '');
    return major || 'Computer Science';
  }
  if (profileKey?.startsWith('experience.') && tenantExp) {
    const shortKey = profileKey.replace(/^experience\./, '');
    const fromTenant = tenantExp[shortKey] ?? tenantExp[profileKey];
    if (fromTenant != null && fromTenant !== '') return String(fromTenant);
  }
  if (profileKey?.startsWith('education.') && tenantEdu) {
    const shortKey = profileKey.replace(/^education\./, '');
    const fromTenant = tenantEdu[shortKey] ?? tenantEdu[profileKey];
    if (fromTenant != null && fromTenant !== '') return String(fromTenant);
  }
  const storedTenantAnswer = lookupTenantAnswer(tenant, labelText);
  if (storedTenantAnswer) return String(storedTenantAnswer);
  if (profileKey) {
    const fromProfile = getNestedValue(profile, profileKey);
    if (fromProfile != null && fromProfile !== '') {
      if (Array.isArray(fromProfile)) return fromProfile[fromProfile.length - 1] || fromProfile[0];
      return String(fromProfile);
    }
  }
  if (/field\s*of\s*study/i.test(labelText)) {
    return profile?.education?.major || 'Computer Science';
  }
  if (profileKey === 'education.gpa' || /overall\s*result|gpa/i.test(labelText)) {
    const resumePath = profile?._resumePath || await getResumePathForApply(profile).catch(() => null);
    if (resumePath) {
      const fromResume = await inferFromResumeFile(labelText, resumePath, { type: fieldType });
      if (fromResume) return String(fromResume);
    }
  }
  const mapped = mapLabelToProfileValue(labelText, profile, { url, tenant });
  if (mapped != null && mapped !== '') {
    return Array.isArray(mapped) ? mapped[mapped.length - 1] : String(mapped);
  }
  const fromDefault = lookupDefaultAnswer(labelText);
  if (fromDefault) return Array.isArray(fromDefault) ? fromDefault.join(' / ') : String(fromDefault);
  const resolved = await resolveField(
    { label: labelText, type: fieldType, required: true },
    profile,
    qaStore,
    { skipPrompt: true, url, company: profile?._company || profile?.company, page, profile },
  );
  return resolved ? String(resolved) : null;
}

async function isFieldRequiredInDom(page, fieldLoc, labelText = '') {
  return await fieldLoc.evaluate((root) => {
    const field = root.closest?.('[data-automation-id*="formField"]')
      || root.closest?.('[data-automation-id*="Field"]')
      || root.closest?.('fieldset')
      || root.parentElement;
    const container = field || root;

    // Asterisk on this field's labels (From * / To *) — required must fill.
    const labelEls = container.querySelectorAll?.('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"]') || [];
    for (const el of labelEls) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 120) continue;
      if (/\*/.test(t) || /\brequired\b/i.test(t)) return true;
    }

    if (container?.querySelector?.('[aria-required="true"], .required, .asterisk, abbr[title*="required" i]')) return true;
    if (container?.getAttribute?.('aria-required') === 'true') return true;
    const inputs = container?.querySelectorAll?.(
      'input, textarea, select, [role="combobox"], [role="spinbutton"], button[aria-haspopup="listbox"]'
    ) || [];
    for (const el of inputs) {
      if (el.required || el.getAttribute('aria-required') === 'true') return true;
    }
    // Compact formField still showing * next to the control.
    const text = (container?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/\*/.test(text) && text.length < 280) return true;
    return false;
  }).catch(() => false);
}

async function fillFieldAtAnyCost(page, sectionName, sectionType, spec, profile, qaStore, url) {
  const { label, key, type, searchable, alwaysFill } = spec;

  const isDateField = type === 'monthyear' || type === 'year';
  let fieldLoc = await findFieldLocator(page, spec, sectionType);
  if (!fieldLoc && !isDateField) {
    logBlock(sectionName, label, ['NOT FOUND — skip (not on page)']);
    return true;
  }

  // Required-only mode — except Job Title / Company that must always be set when
  // the work row is open. Dates use their own * / spin-map filler below.
  if (!isDateField && profile?._fillOptionalFields !== true && !alwaysFill) {
    const required = await isFieldRequiredInDom(page, fieldLoc, label);
    if (!required) {
      logBlock(sectionName, label, ['optional (no *) — skipped']);
      return true;
    }
  }

  let answer = await resolveAnswer(label, key, label, profile, qaStore, url, type);
  if (!answer) {
    logBlock(sectionName, label, ['NO ANSWER available']);
    return false;
  }

  const before = fieldLoc ? await readFieldValue(fieldLoc) : '';
  if (!isDateField && valuesMatch(before, Array.isArray(answer) ? answer[answer.length - 1] : answer)) {
    logBlock(sectionName, label, [`already correct: "${before}" — next field`]);
    return true;
  }

  let result = { ok: false, attempts: [] };
  switch (type) {
    case 'monthyear':
    case 'year':
      result = await fillWorkdayDateField(page, {
        labelPattern: spec.labelPattern || spec.label,
        sectionType,
        value: answer,
        mode: type,
        requiredOnly: profile?._fillOptionalFields !== true && !alwaysFill,
      });
      if (result.skippedOptional) {
        logBlock(sectionName, label, result.attempts);
        return true;
      }
      break;
    case 'fieldofstudy':
      result = await fillFieldOfStudy(page, fieldLoc, answer);
      break;
    case 'typeahead':
      result = await fillTypeAndEnter(page, fieldLoc, answer);
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

  let after = result.after || (fieldLoc ? await readFieldValue(fieldLoc) : '');
  let stored = result.selected || after || answer;
  let verified = result.ok || valuesMatch(after, answer);

  // Date spins must never fall through to dropdown option clicks (causes Add misclicks).
  if (!verified && type !== 'monthyear' && type !== 'year') {
    const live = await collectLiveFieldOptions(page, label, 'dropdown').catch(() => []);

    const tryPick = async (pick, source) => {
      if (!pick || valuesMatch(after, pick)) return false;
      const retry = await typeAndClickOption(page, fieldLoc, pick);
      after = await readFieldValue(fieldLoc);
      if (!retry.ok && !valuesMatch(after, pick)) return false;
      result = { ok: true, selected: retry.selected || pick, attempts: [...result.attempts, `${source} "${pick}" ✓`] };
      stored = retry.selected || pick;
      verified = true;
      return true;
    };

    // Offline DOM match first — keeps the run going when the LLM API is unreachable.
    await tryPick(pickLocalNearestOption(label, live, answer), 'DOM nearest');

    if (!verified) {
      const nearest = live.length
        ? await pickNearestSelectOption({
          question: label,
          options: live,
          preferred: answer,
          profile,
          company: profile?._company || profile?.company,
        })
        : await resolveUnknownWithLlm(label, { type, required: true }, {
          page,
          profile,
          company: profile?._company || profile?.company,
        });
      if (nearest) await tryPick(nearest, 'LLM/nearest');
    }
  } else if (!verified && (type === 'monthyear' || type === 'year')) {
    result = await fillWorkdayDateField(page, {
      labelPattern: spec.labelPattern || spec.label,
      sectionType,
      value: answer,
      mode: type,
      requiredOnly: false,
    });
    after = result.after || (fieldLoc ? await readFieldValue(fieldLoc) : '');
    stored = after || answer;
    verified = result.ok || valuesMatch(after, answer);
    result.attempts = [...(result.attempts || []), verified ? 'date retry ✓' : 'date retry ✗ (no dropdown fallback)'];
  }

  logBlock(sectionName, label, [
    `answer: "${answer}"`,
    `before: "${before || '(empty)'}"`,
    `after:  "${after || '(empty)'}"`,
    ...result.attempts,
    verified ? 'RESULT: FILLED ✓' : 'RESULT: FAILED ✗',
  ]);

  if (verified) {
    // "From" / "To" appear in both Work Experience and Education, so caching them
    // under the bare label makes one section overwrite the other. Dates always come
    // from profile.experience / profile.education instead.
    const isDateField = type === 'monthyear' || type === 'year';
    if (isDateField) {
      logBlock(sectionName, label, [`not cached under "${label}" — dates stay section-specific`]);
      return true;
    }

    profile.qa_answers = profile.qa_answers || {};
    profile.qa_answers[label.toLowerCase()] = stored;
    await saveAnswerToYaml(label, stored).catch(() => {});
    await saveAnswerToTenantYaml(getWorkdayTenant(url), {
      label,
      answer: stored,
      fieldType: type === 'fieldofstudy' || type === 'typeahead' || type === 'dropdown' || type === 'searchable'
        ? 'dropdown'
        : type,
      options: stored ? [String(stored)] : [],
      step: sectionName,
    }).catch(() => {});
    if (key) {
      const parts = key.split('.');
      let obj = profile;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = obj[parts[i]] || {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = stored;
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
  { label: 'Job Title', labelPattern: '^Job\\s*Title', key: 'experience.current_title', type: 'text', alwaysFill: true },
  { label: 'Company', labelPattern: '^Company', key: 'experience.current_company', type: 'text', alwaysFill: true },
  { label: 'Location', labelPattern: '^Location', key: 'experience.location', type: 'text' },
  { label: 'From', labelPattern: '^From\\b|^Start\\s*Date', key: 'experience.from_date', type: 'monthyear', alwaysFill: true },
  { label: 'To', labelPattern: '^To\\b(?!\\s*year)|^End\\s*Date', key: 'experience.to_date', type: 'monthyear', alwaysFill: true },
  { label: 'Role Description', labelPattern: 'Role\\s*Description', key: 'experience.description', type: 'textarea' },
];

/** Always fill these on My Experience (Workday education block). */
const EDUCATION_CORE_FIELDS = [
  { label: 'School or University', labelPattern: 'School\\s*or\\s*University|^School$', key: 'education.university', type: 'typeahead' },
  { label: 'Degree', labelPattern: '^\\*?\\s*Degree', key: 'education.degree', type: 'searchable', alwaysFill: true },
  { label: 'Field of Study', labelPattern: 'Field\\s*of\\s*Study', key: 'education.field_of_study_hierarchy', type: 'fieldofstudy', alwaysFill: true },
];

/** Dates fill when the education row is open; GPA / highest-level stay required-only. */
const EDUCATION_OPTIONAL_FIELDS = [
  { label: 'From', labelPattern: '^From\\b', key: 'education.from_year', type: 'year', alwaysFill: true },
  { label: 'To (Actual or Expected)', labelPattern: 'To.*Actual|Expected|^To\\s*\\*?$', key: 'education.to_year', type: 'year', alwaysFill: true },
  { label: 'Overall Result (GPA)', labelPattern: 'Overall\\s*Result', key: 'education.gpa', type: 'text' },
  { label: 'Highest level of education', labelPattern: 'highest\\s*level\\s*of\\s*education', key: 'education.highest_level', type: 'text' },
];

export async function handleStep2MyExperience(page, profile = {}) {
  console.log('\n  ══════════════════════════════════════════');
  console.log('  📋 STEP 2: MY EXPERIENCE — REQUIRED FIELDS ONLY');
  console.log('  ══════════════════════════════════════════');

  // Defaults fill the gaps; configured values (Apply Wizz / profile.yml) win.
  profile.experience = {
    ...WORKDAY_DEFAULT_EXPERIENCE,
    ...(profile.experience || {}),
  };
  profile.education = {
    ...WORKDAY_DEFAULT_EDUCATION,
    ...(profile.education || {}),
    university: 'Other',
    degree: profile?.education?.degree || "Bachelor's",
    major: 'Computer Science',
    field_of_study_hierarchy: ['Computer Science'],
  };

  profile.education.university = 'Other';
  profile.education.major = 'Computer Science';
  profile.education.field_of_study_hierarchy = ['Computer Science'];
  if (!/bachelor/i.test(String(profile.education.degree || ''))) {
    profile.education.degree = "Bachelor's";
  }

  const qaStore = createQAStore();
  const url = page.url();
  let filled = 0;
  let failed = 0;
  let skipped = 0;

  await page.waitForTimeout(500);

  // Disarm Certifications / Languages / orphan Add before any My Experience fill.
  const blocked = await disarmRiskyAddButtons(page);
  if (blocked > 0) {
    console.log(`    🚫 Disarmed ${blocked} risky Add button(s) before My Experience fill`);
  }

  // Optional rows are only ever clicked when Workday is already blocking the step.
  const stepBlocked = await pageHasValidationErrors(page);
  await skipOptionalExperienceSections(page, profile, { force: stepBlocked });

  const fillOptional = profile?._fillOptionalFields === true;

  // Required-only: a collapsed section is never expanded unless Workday demands it.
  const workOnPage = await sectionPresentOnPage(page, 'work');
  const workExpanded = workOnPage && await sectionHasVisibleFields(page, 'work');
  const workRequired = workOnPage && !workExpanded && (fillOptional || await isSectionRequiredInDom(page, 'work'));
  const hasWorkSection = workExpanded || workRequired;

  const educationOnPage = await sectionPresentOnPage(page, 'education');
  const educationExpanded = educationOnPage && await sectionHasVisibleFields(page, 'education');
  const educationRequired = educationOnPage && !educationExpanded
    && (fillOptional || await isSectionRequiredInDom(page, 'education'));
  const hasEducationSection = educationExpanded || educationRequired;

  if (workOnPage && !hasWorkSection) {
    console.log('  ⏭️  Work Experience section optional and collapsed — no Add clicked, skipped');
  }
  if (educationOnPage && !hasEducationSection) {
    console.log('  ⏭️  Education section optional and collapsed — no Add clicked, skipped');
  }

  if (hasWorkSection || hasEducationSection) {
    await hydrateExperienceFromLlm(profile);
  }

  // Log what the wizard will actually type, so a wrong date is visible in the run log.
  const workRange = resolveWorkDateRange(profile.experience || {});
  const eduRange = resolveEducationYearRange(profile.education || {});
  console.log(`  📅 Work: ${workRange.from || '(none)'} → ${workRange.to || '(none)'} | Education: ${eduRange.from || '(none)'} → ${eduRange.to || '(none)'}`);
  for (const note of [...workRange.notes, ...eduRange.notes]) {
    console.log(`     ⚠️  ${note}`);
  }

  if (workRequired || educationRequired) {
    await ensureSectionsExpanded(page);
    // Re-disarm: expanding work/education must never leave a Certifications Add live.
    await disarmRiskyAddButtons(page);
    await skipOptionalExperienceSections(page, profile, { force: stepBlocked });
  }
  if (hasWorkSection) {
    await ensureCurrentlyWorkHereUnchecked(page);
    await disarmRiskyAddButtons(page);
  } else if (!workOnPage) {
    console.log('  ℹ️  Work Experience section not on this application — skipping (resume/skills only)');
  }

  if (hasWorkSection) {
    console.log('\n  ▶ WORK EXPERIENCE');
    for (const spec of WORK_FIELDS) {
      const ok = await fillFieldAtAnyCost(page, 'Work Experience', 'work', spec, profile, qaStore, url);
      if (ok) filled++;
      else failed++;
    }
  } else {
    skipped += WORK_FIELDS.length;
  }

  if (hasEducationSection) {
    console.log('\n  ▶ EDUCATION (School=Other, Degree=Bachelor\'s, Field=Computer Science)');
    for (const spec of EDUCATION_CORE_FIELDS) {
      const ok = await fillFieldAtAnyCost(page, 'Education', 'education', spec, profile, qaStore, url);
      if (ok) filled++;
      else failed++;
    }
    for (const spec of EDUCATION_OPTIONAL_FIELDS) {
      const isDate = spec.type === 'year' || spec.type === 'monthyear';
      if (!isDate) {
        const loc = await findFieldLocator(page, spec, 'education');
        if (!loc) {
          skipped++;
          continue;
        }
        const required = await isFieldRequiredInDom(page, loc, spec.label);
        if (!required && profile?._fillOptionalFields !== true) {
          logBlock('Education', spec.label, ['optional — skipped']);
          skipped++;
          continue;
        }
      }
      const ok = await fillFieldAtAnyCost(page, 'Education', 'education', spec, profile, qaStore, url);
      if (ok) filled++;
      else failed++;
    }
  } else {
    if (!educationOnPage) console.log('  ℹ️  Education section not on this application — skipping');
    skipped += EDUCATION_CORE_FIELDS.length;
  }

  await handleWebsitesSection(page, profile, { force: stepBlocked });

  console.log('\n  ══════════════════════════════════════════');
  const skipNote = skipped > 0 ? `, ${skipped} skipped (section not on page)` : '';
  console.log(`  ✓ My Experience done: ${filled} filled, ${failed} failed${skipNote}`);
  console.log('  ══════════════════════════════════════════\n');
  return filled;
}

export function mergeWorkdayDefaultExperienceEducation(profile) {
  if (!profile) return profile;
  profile.experience = {
    ...WORKDAY_DEFAULT_EXPERIENCE,
    ...(profile.experience || {}),
  };
  profile.education = {
    ...WORKDAY_DEFAULT_EDUCATION,
    ...(profile.education || {}),
    university: 'Other',
    degree: profile?.education?.degree || "Bachelor's",
    major: 'Computer Science',
    field_of_study_hierarchy: ['Computer Science'],
  };
  return profile;
}

export { WORKDAY_DEFAULT_EXPERIENCE, WORKDAY_DEFAULT_EDUCATION };
