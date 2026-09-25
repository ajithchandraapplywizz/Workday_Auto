/**
 * workdaySource.mjs — DOM-driven "How Did You Hear About Us?" selection
 *
 * Workday source widgets are cascading: parent click → submenu → child click.
 * Uses Playwright locators (not evaluate click) and verifies the live DOM.
 */

import { fuzzyScore } from './fields.mjs';
import {
  WORKDAY_DEFAULT_SOURCE,
  WORKDAY_SOURCE_FALLBACK_OPTIONS,
  WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES,
} from './workdayDefaults.mjs';

const SOURCE_LABEL = 'How Did You Hear About Us?';

const KNOWN_JOB_BOARD_CHILDREN = [
  'LinkedIn', 'Indeed', 'Glassdoor', 'Monster', 'CareerBuilder', 'Careerbuilder',
  'ZipRecruiter', 'Dice', 'DICE', 'Google', 'Handshake', 'Ladders', 'Hired',
  'SimplyHired', 'Snagajob', 'Talnet', 'Afrotech', 'Careerbuilder',
];

/** Values that belong on phone/country fields, not the referral source dropdown. */
export function isInvalidSourceAnswer(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  return /\+?\d{1,4}|phone|country|mobile|territory|device\s*type|india\s*\(|united states\s*\(/i.test(v);
}

/** Dropdown option text that belongs to country/phone code lists, not referral source. */
export function isPhoneCodeDropdownOption(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^\+\d{1,4}$/.test(t)
    || /\+\d{1,4}\)/.test(t)
    || /india\s*\(\+\d/i.test(t)
    || /united states.*\(\+\d/i.test(t)
    || /country\s*\/\s*territory/i.test(t);
}

function normalizeOptionText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(text) {
  return normalizeOptionText(text).toLowerCase();
}

function singularize(text) {
  return normalizeKey(text).replace(/s$/, '');
}

/** True when this DOM label is a parent category that requires a child click. */
export function isHierarchicalParentOption(text) {
  const t = normalizeOptionText(text);
  if (!t) return false;
  for (const [parent] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) {
    if (matchPreferredToDomOption(parent, [t], { strict: true })) return true;
  }
  return /^job\s*boards?$/i.test(t)
    || /^job\s*sites?$/i.test(t)
    || /^external\s*career/i.test(t)
    || /^website$/i.test(t)
    || /^referral$/i.test(t)
    || /^social\s*networking$/i.test(t)
    || /^search\s*engine$/i.test(t);
}

/**
 * Read what the referral source widget actually shows in the browser.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function getReferralSourceDisplay(page) {
  return await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const roots = [
      document.querySelector('#source--source'),
      document.querySelector('[data-automation-id="source--source"]'),
      document.querySelector('[data-automation-id="sourcePrompt"]'),
    ].filter(Boolean);

    for (const root of roots) {
      const field = root.closest('[data-automation-id*="formField"]') || root.parentElement;
      if (!field) continue;

      const chips = [];
      field.querySelectorAll(
        '[data-automation-id="selectedItem"], [data-automation-id="promptOption"], [data-automation-id="pill"], [data-automation-id="multiSelectContainer"] span'
      ).forEach((el) => {
        const t = norm(el.textContent);
        if (t && !/^select/i.test(t)) chips.push(t);
      });

      if (chips.length > 0) return chips.join(' / ');

      const btn = field.querySelector('button[aria-haspopup="listbox"], [role="combobox"]');
      const btnText = norm(btn?.textContent);
      if (btnText && !/^select/i.test(btnText)) return btnText;
    }
    return '';
  });
}

/**
 * @param {string} display
 * @param {string} expected
 * @returns {boolean}
 */
export function displayMatchesExpected(display, expected) {
  const d = normalizeOptionText(display);
  const e = normalizeOptionText(expected);
  if (!d || !e) return false;
  if (/select one|required/i.test(d)) return false;
  const dl = d.toLowerCase();
  const el = e.toLowerCase();
  if (dl === el || dl.includes(el) || el.includes(dl)) return true;
  if (singularize(d) === singularize(e)) return true;
  return fuzzyScore(e, d) >= 0.55;
}

/**
 * Strict locator — ONLY the "How did you hear" referral source control.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Locator|null>}
 */
/**
 * Parse referral source hint from job URL query (?source=web_LinkedIn, etc.)
 * @param {string} url
 * @returns {string|null}
 */
export function parseSourceFromJobUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const raw = u.searchParams.get('source') || u.searchParams.get('src') || u.searchParams.get('utm_source') || '';
    if (!raw) return null;
    if (/linkedin/i.test(raw)) return 'LinkedIn';
    if (/indeed/i.test(raw)) return 'Indeed';
    if (/glassdoor/i.test(raw)) return 'Glassdoor';
    if (/monster/i.test(raw)) return 'Monster';
    if (/careerbuilder/i.test(raw)) return 'CareerBuilder';
    const cleaned = raw.replace(/^web_/i, '').replace(/[_-]+/g, ' ').trim();
    if (cleaned && cleaned.length < 40) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Ordered source answers from URL → profile → yaml → workdayDefaults.mjs (no terminal).
 * @param {object} profile
 * @param {string} [url]
 * @returns {string[]}
 */
export function resolveSourceAnswerCandidates(profile = {}, url = '') {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = normalizeOptionText(v);
    if (!s || isInvalidSourceAnswer(s)) return;
    const key = normalizeKey(s);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  add(parseSourceFromJobUrl(url));
  add(profile?.personal?.source);
  add(profile?.qa_answers?.['how did you hear about us']);
  add(profile?.qa_answers?.['how did you hear']);
  add(WORKDAY_DEFAULT_SOURCE);

  for (const [, child] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) add(child);
  for (const opt of WORKDAY_SOURCE_FALLBACK_OPTIONS) {
    if (!isHierarchicalParentOption(opt)) add(opt);
  }
  return out;
}

export async function locateReferralSourceControl(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-wd-source-target]').forEach((el) => el.removeAttribute('data-wd-source-target'));
  });

  const markerId = await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const isPhoneBlob = (blob) => /countryphonecode|country-phone|phonetype|phone-number|phonenumber--phone|country\/territory\s*phone/i.test(blob);

    const isLabelLike = (el) => {
      const blob = `${el.id || ''} ${el.getAttribute('data-automation-id') || ''} ${el.getAttribute('role') || ''}`.toLowerCase();
      return el.tagName === 'LABEL'
        || /promptselectionlabel|rich\s*text|formfield.*label/i.test(blob)
        || (blob.includes('label') && !blob.includes('listbox') && el.getAttribute('role') !== 'combobox');
    };

    const pickTrigger = (root) => {
      if (!root) return null;
      const triggers = root.querySelectorAll(
        'button[aria-haspopup="listbox"], [role="combobox"], input[role="combobox"], select, [data-automation-id="selectWidget"] button, [data-automation-id*="multiSelect"] button, [data-automation-id*="select"] button, [data-automation-id*="prompt"] button, [data-automation-id*="prompt"] [role="combobox"]'
      );
      for (const trigger of triggers) {
        const blob = `${trigger.id || ''} ${trigger.getAttribute('data-automation-id') || ''} ${trigger.getAttribute('name') || ''}`.toLowerCase();
        if (isPhoneBlob(blob)) continue;
        if (isLabelLike(trigger)) continue;
        return trigger;
      }
      if (root.matches?.('button, [role="combobox"], input, select')
        && !isPhoneBlob(`${root.id} ${root.getAttribute('data-automation-id')}`)
        && !isLabelLike(root)) {
        return root;
      }
      return null;
    };

    const mark = (trigger) => {
      const id = `wd-src-${Math.random().toString(36).slice(2, 10)}`;
      trigger.setAttribute('data-wd-source-target', id);
      return id;
    };

    for (const sel of [
      '#source--source',
      '[data-automation-id="source--source"]',
      '[data-automation-id="sourcePrompt"]',
      '[data-automation-id*="referralSource"]',
      '[data-automation-id*="referral"]',
      '[id*="source--source"]',
    ]) {
      const node = document.querySelector(sel);
      const field = node?.closest?.('[data-automation-id*="formField"], fieldset, [role="group"]') || node;
      const trigger = pickTrigger(field) || pickTrigger(node);
      if (trigger) return mark(trigger);
    }

    const candidates = [];
    const labelEls = document.querySelectorAll(
      'label, legend, [data-automation-id*="label"], [data-automation-id*="richText"], span, p, div'
    );

    for (const labelEl of labelEls) {
      const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
      if (!labelText || labelText.length > 120) continue;
      if (!/how\s*did\s*you\s*hear/i.test(labelText)) continue;
      if (/phone|country\s*\/\s*territory|device\s*type/i.test(labelText)) continue;

      const field = labelEl.closest('[data-automation-id*="formField"], fieldset, [role="group"]')
        || labelEl.parentElement?.parentElement;
      const trigger = pickTrigger(field);
      if (!trigger) continue;
      candidates.push({ trigger, labelLen: labelText.length });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.labelLen - b.labelLen);
    return mark(candidates[0].trigger);
  });

  if (!markerId) return null;
  const loc = page.locator(`[data-wd-source-target="${markerId}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  return await ensureSourceTrigger(page, loc);
}

/**
 * If DOM scan marked a label, resolve to the real combobox/button in the same field.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} trigger
 */
async function ensureSourceTrigger(page, trigger) {
  const meta = await trigger.evaluate((el) => ({
    tag: el.tagName,
    role: el.getAttribute('role') || '',
    automationId: el.getAttribute('data-automation-id') || '',
    id: el.id || '',
    hasPopup: el.getAttribute('aria-haspopup') || '',
  })).catch(() => null);

  if (!meta) return trigger;

  const labelLike = meta.tag === 'LABEL'
    || /promptselectionlabel|richtext/i.test(meta.automationId)
    || (/label/i.test(meta.automationId) && meta.role !== 'combobox' && meta.hasPopup !== 'listbox');

  if (!labelLike && (meta.role === 'combobox' || meta.hasPopup === 'listbox' || meta.tag === 'BUTTON')) {
    return trigger;
  }

  const field = trigger.locator('xpath=ancestor::*[contains(@data-automation-id,"formField")][1]');
  const combobox = field.locator(
    'button[aria-haspopup="listbox"], [role="combobox"], [data-automation-id="selectWidget"] button, [data-automation-id*="multiSelect"] button'
  ).first();

  if (await combobox.count().catch(() => 0)) {
    await combobox.scrollIntoViewIfNeeded().catch(() => {});
    return combobox;
  }

  const bySourceId = page.locator(
    '#source--source button[aria-haspopup="listbox"], #source--source [role="combobox"], [data-automation-id="source--source"] button[aria-haspopup="listbox"]'
  ).first();
  if (await bySourceId.isVisible({ timeout: 800 }).catch(() => false)) {
    return bySourceId;
  }

  return trigger;
}

/**
 * @param {string} preferred
 * @param {string[]} domOptions
 * @param {{ strict?: boolean, threshold?: number }} [opts]
 * @returns {string|null}
 */
export function matchPreferredToDomOption(preferred, domOptions, opts = {}) {
  const { strict = false, threshold = strict ? 0.82 : 0.42 } = opts;
  if (!preferred || !domOptions?.length) return null;
  const needle = normalizeOptionText(preferred);
  const lowerNeedle = needle.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const dom of domOptions) {
    if (isPhoneCodeDropdownOption(dom)) continue;
    const text = normalizeOptionText(dom);
    if (!text) continue;
    const lowerDom = text.toLowerCase();

    if (lowerDom === lowerNeedle || singularize(lowerDom) === singularize(lowerNeedle)) {
      return text;
    }

    if (strict && lowerDom !== lowerNeedle && lowerDom.endsWith(lowerNeedle) && lowerDom.length > lowerNeedle.length + 2) {
      continue;
    }

    if (!strict) {
      if (lowerDom.includes(lowerNeedle) || lowerNeedle.includes(lowerDom)) {
        if (0.9 > bestScore) {
          bestScore = 0.9;
          best = text;
        }
        continue;
      }
    } else {
      // Strict: reject "Website" matching "Booz Allen Website" unless it's the same category label
      const wordBoundary = new RegExp(`(^|\\s)${lowerNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
      if (wordBoundary.test(lowerDom) && lowerDom.length <= lowerNeedle.length + 4) {
        if (0.92 > bestScore) {
          bestScore = 0.92;
          best = text;
        }
        continue;
      }
    }

    const score = fuzzyScore(needle, text);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Collect visible listbox options, excluding phone/country code entries.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function collectReferralSourceOptions(page) {
  const raw = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    const selectors = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"], [role="treeitem"]';
    for (const el of document.querySelectorAll(selectors)) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (!el.offsetParent && el.getClientRects().length === 0) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 140) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  });
  return raw.filter((o) => !isPhoneCodeDropdownOption(o));
}

/**
 * Scroll virtualized listbox and collect all visible referral options.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function collectReferralSourceOptionsWithScroll(page) {
  const seen = new Set();
  const out = [];

  const addBatch = (batch) => {
    for (const o of batch) {
      const key = normalizeKey(o);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    }
  };

  addBatch(await collectReferralSourceOptions(page));

  const listbox = page.locator('[role="listbox"]:visible').last();
  if (await listbox.count().catch(() => 0) === 0) {
    return out;
  }

  for (let i = 0; i < 14; i++) {
    await listbox.evaluate((el) => { el.scrollTop += 220; }).catch(() => {});
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(180);
    const before = out.length;
    addBatch(await collectReferralSourceOptions(page));
    if (out.length === before && i > 4) break;
  }

  return out;
}

/**
 * Pick the best leaf from a Job Board submenu when preferred children are missing.
 * @param {string[]} submenuOptions
 * @param {string[]} preferredChildren
 * @returns {string|null}
 */
export function pickBestSubmenuLeaf(submenuOptions, preferredChildren = []) {
  if (!submenuOptions?.length) return null;

  for (const pref of preferredChildren) {
    const match = matchPreferredToDomOption(pref, submenuOptions, { strict: false, threshold: 0.35 });
    if (match && !isHierarchicalParentOption(match)) return match;
  }

  for (const alias of KNOWN_JOB_BOARD_CHILDREN) {
    const match = matchPreferredToDomOption(alias, submenuOptions, { strict: false, threshold: 0.35 });
    if (match && !isHierarchicalParentOption(match)) return match;
  }

  for (const opt of submenuOptions) {
    if (isPhoneCodeDropdownOption(opt) || isHierarchicalParentOption(opt)) continue;
    if (opt.length > 2 && opt.length < 80) return opt;
  }

  return submenuOptions[0] || null;
}

/**
 * Click a visible list option using Playwright (triggers Workday React handlers).
 * @param {import('playwright').Page} page
 * @param {string} optionText
 * @returns {Promise<string|null>}
 */
async function clickSourceListOption(page, optionText) {
  const target = normalizeOptionText(optionText);
  if (!target) return null;

  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactRe = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
  const looseRe = new RegExp(escaped, 'i');

  const locators = [
    page.locator('[data-automation-id="promptOption"]'),
    page.getByRole('option'),
    page.getByRole('treeitem'),
    page.locator('[role="menuitem"]'),
  ];

  for (const base of locators) {
    const count = await base.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = base.nth(i);
      const visible = await item.isVisible({ timeout: 400 }).catch(() => false);
      if (!visible) continue;

      const text = normalizeOptionText(await item.innerText().catch(() => ''));
      if (!text) continue;

      const matches = exactRe.test(text)
        || singularize(text) === singularize(target)
        || (text.toLowerCase() === target.toLowerCase());

      if (!matches) continue;

      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.hover({ force: true }).catch(() => {});
      await page.waitForTimeout(120);
      await item.click({ force: true });
      await page.waitForTimeout(450);
      return text;
    }
  }

  // Fallback: first visible item whose text loosely matches
  for (const base of locators) {
    const hit = base.filter({ hasText: looseRe }).first();
    if (await hit.isVisible({ timeout: 400 }).catch(() => false)) {
      const text = normalizeOptionText(await hit.innerText().catch(() => ''));
      if (!text || isPhoneCodeDropdownOption(text)) continue;
      await hit.scrollIntoViewIfNeeded().catch(() => {});
      await hit.hover({ force: true }).catch(() => {});
      await hit.click({ force: true });
      await page.waitForTimeout(450);
      return text;
    }
  }

  // Fuzzy fallback across all visible options (Careerbuilder vs CareerBuilder, DICE vs Dice)
  const visibleOptions = await collectReferralSourceOptionsWithScroll(page);
  const fuzzyMatch = matchPreferredToDomOption(target, visibleOptions, { strict: false, threshold: 0.38 });
  if (fuzzyMatch && normalizeKey(fuzzyMatch) !== normalizeKey(target)) {
    const fuzzyRe = new RegExp(fuzzyMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const base of locators) {
      const hit = base.filter({ hasText: fuzzyRe }).first();
      if (await hit.isVisible({ timeout: 400 }).catch(() => false)) {
        await hit.scrollIntoViewIfNeeded().catch(() => {});
        await hit.click({ force: true });
        await page.waitForTimeout(450);
        return normalizeOptionText(await hit.innerText().catch(() => fuzzyMatch));
      }
    }
  }

  return null;
}

/**
 * Open the source dropdown on the correct trigger.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} trigger
 */
async function openSourceDropdown(page, trigger) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true }).catch(() => trigger.evaluate((el) => el.click()));
  await page.waitForTimeout(600);
}

/**
 * After parent click, find submenu options (new items not in the top-level set).
 * @param {import('playwright').Page} page
 * @param {Set<string>} topLevelKeys
 * @returns {Promise<string[]>}
 */
async function collectSubmenuOptions(page, topLevelKeys) {
  const all = await collectReferralSourceOptionsWithScroll(page);
  const diff = all.filter((o) => !topLevelKeys.has(normalizeKey(o)));

  if (diff.length > 0) return diff;

  const known = [...KNOWN_JOB_BOARD_CHILDREN, ...WORKDAY_SOURCE_FALLBACK_OPTIONS];
  return all.filter((o) => known.some((k) => normalizeKey(o).includes(normalizeKey(k)) || normalizeKey(k).includes(normalizeKey(o))));
}

/**
 * Parent label aliases (DOM may use Job Board vs Job Boards vs Job Sites).
 * @param {string} parentPref
 * @returns {string[]}
 */
function expandParentAliases(parentPref) {
  const base = normalizeOptionText(parentPref);
  const key = normalizeKey(base);
  const groups = [
    ['job boards', 'job board', 'job sites', 'job site'],
    ['website', 'company website'],
    ['external career site sources', 'external career sites'],
  ];
  for (const group of groups) {
    if (group.some((g) => key === g || key.includes(g) || g.includes(key))) {
      return [...new Set([base, ...group])];
    }
  }
  return [base];
}

/**
 * Match a parent preference against DOM options (strict then loose).
 * @param {string} parentPref
 * @param {string[]} topLevelOptions
 * @returns {string|null}
 */
function matchParentInDom(parentPref, topLevelOptions) {
  for (const alias of expandParentAliases(parentPref)) {
    const strict = matchPreferredToDomOption(alias, topLevelOptions, { strict: true });
    if (strict) return strict;
    const loose = matchPreferredToDomOption(alias, topLevelOptions, { strict: false, threshold: 0.72 });
    if (loose) return loose;
  }
  return null;
}
export function getChildCandidatesForParent(parentDomText) {
  const out = [];
  const seen = new Set();
  for (const [parentPref, childPref] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) {
    if (!matchPreferredToDomOption(parentPref, [parentDomText], { strict: true })) continue;
    const key = normalizeKey(childPref);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(childPref);
    }
  }
  for (const leaf of WORKDAY_SOURCE_FALLBACK_OPTIONS) {
    if (isHierarchicalParentOption(leaf)) continue;
    const key = normalizeKey(leaf);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(leaf);
    }
  }
  return out;
}

/**
 * Build attempts: workdayDefaults.mjs hierarchical pairs FIRST, then flat leaves, profile last.
 * @param {string[]} topLevelOptions
 * @param {object} profile
 */
export function buildOrderedSourceAttempts(topLevelOptions, profile = {}) {
  const attempts = [];
  const seen = new Set();
  const add = (a) => {
    const key = a.type === 'flat' ? `f:${a.value}` : `h:${a.parent}::${a.child}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(a);
  };

  // 1. Hierarchical pairs from workdayDefaults.mjs — exact file order (try FIRST)
  for (const [parentPref, childPref] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) {
    const parentMatch = matchParentInDom(parentPref, topLevelOptions);
    if (parentMatch) add({ type: 'hierarchical', parent: parentMatch, child: childPref });
  }

  // 2. Flat leaf options from WORKDAY_SOURCE_FALLBACK_OPTIONS (skip parent categories)
  for (const opt of WORKDAY_SOURCE_FALLBACK_OPTIONS) {
    const match = matchPreferredToDomOption(opt, topLevelOptions, { strict: false });
    if (!match) continue;
    if (isHierarchicalParentOption(match)) continue;
    add({ type: 'flat', value: match });
  }

  // 3. Profile/yaml leaf source LAST (only if not a parent category)
  const profileSource = profile?.personal?.source
    || profile?.qa_answers?.['how did you hear about us']
    || profile?.qa_answers?.['how did you hear'];
  if (profileSource && !isInvalidSourceAnswer(profileSource) && !isHierarchicalParentOption(profileSource)) {
    const src = normalizeOptionText(profileSource);
    for (const [parentPref] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) {
      const parentMatch = matchParentInDom(parentPref, topLevelOptions);
      if (parentMatch) add({ type: 'hierarchical', parent: parentMatch, child: src });
    }
    const flat = matchPreferredToDomOption(src, topLevelOptions, { strict: false });
    if (flat && !isHierarchicalParentOption(flat)) add({ type: 'flat', value: flat });
  }

  return attempts;
}

/**
 * Click parent, wait for submenu, click child from .mjs prefs, verify DOM.
 */
async function tryHierarchicalSource(page, trigger, parent, childCandidates, topLevelKeys) {
  const children = [...new Set((Array.isArray(childCandidates) ? childCandidates : [childCandidates]).filter(Boolean))];

  await openSourceDropdown(page, trigger);
  const parentClicked = await clickSourceListOption(page, parent);
  if (!parentClicked) {
    console.log(`    ↳ Parent "${parent}" not clicked in DOM`);
    return null;
  }
  console.log(`    ↳ Parent clicked: "${parentClicked}" — waiting for submenu...`);

  await page.waitForTimeout(900);

  let childOptions = await collectSubmenuOptions(page, topLevelKeys);
  if (childOptions.length === 0) {
    await page.keyboard.press('ArrowRight').catch(() => {});
    await page.waitForTimeout(500);
    childOptions = await collectSubmenuOptions(page, topLevelKeys);
  }

  console.log(`    ↳ Submenu options: [${childOptions.slice(0, 8).join(', ')}${childOptions.length > 8 ? ', ...' : ''}]`);

  const tryChildren = children.length > 0 ? children : getChildCandidatesForParent(parentClicked);

  for (const childPref of tryChildren) {
    const childMatch = matchPreferredToDomOption(childPref, childOptions, { strict: false })
      || matchPreferredToDomOption(childPref, await collectReferralSourceOptions(page), { strict: false });
    if (!childMatch) {
      console.log(`    ↳ Child "${childPref}" not found in submenu`);
      continue;
    }

    const childClicked = await clickSourceListOption(page, childMatch);
    if (!childClicked) {
      console.log(`    ↳ Child "${childMatch}" visible but click failed`);
      continue;
    }
    console.log(`    ↳ Child clicked: "${childClicked}"`);

    await page.waitForTimeout(600);
    const display = await getReferralSourceDisplay(page);
    if (displayMatchesExpected(display, childClicked) || displayMatchesExpected(display, childMatch)) {
      console.log(`    ✓ DOM verified: "${display}"`);
      return childClicked;
    }
    console.log(`    ↳ Child "${childClicked}" not verified (DOM: "${display || '(empty)'}")`);
  }

  const fallbackChild = pickBestSubmenuLeaf(childOptions, tryChildren);
  if (fallbackChild) {
    console.log(`    ↳ Fallback child from submenu: "${fallbackChild}"`);
    const childClicked = await clickSourceListOption(page, fallbackChild);
    if (childClicked) {
      await page.waitForTimeout(600);
      const display = await getReferralSourceDisplay(page);
      if (displayMatchesExpected(display, childClicked) || isReferralSourceFullySelected(display)) {
        console.log(`    ✓ DOM verified (fallback): "${display}"`);
        return childClicked;
      }
    }
  }

  return null;
}

/**
 * Try flat leaf option with DOM verification.
 */
async function tryFlatSource(page, trigger, value) {
  await openSourceDropdown(page, trigger);
  const clicked = await clickSourceListOption(page, value);
  if (!clicked) return null;

  await page.waitForTimeout(500);
  const display = await getReferralSourceDisplay(page);
  if (displayMatchesExpected(display, clicked)) {
    console.log(`    ✓ DOM verified: "${display}"`);
    return clicked;
  }
  console.log(`    ↳ Flat "${clicked}" not verified in DOM (shows: "${display || '(empty)'}")`);
  return null;
}

/**
 * Fill referral source — hierarchical child required when parent is a category.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ success: boolean, selected?: string, domOptions?: string[] }>}
 */
export async function fillHowDidYouHearFromDom(page, profile = {}) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  let trigger = await locateReferralSourceControl(page);
  trigger = trigger ? await ensureSourceTrigger(page, trigger) : null;
  if (!trigger || !(await trigger.isVisible({ timeout: 2000 }).catch(() => false))) {
    console.log('    ⚠️  Referral source control not found on page.');
    return { success: false, domOptions: [] };
  }

  const controlId = await trigger.evaluate((el) => el.id || el.getAttribute('data-automation-id') || '').catch(() => '');
  console.log(`    🎯 Source control located: ${controlId || '(referral source)'}`);

  await openSourceDropdown(page, trigger);
  let topLevelOptions = await collectReferralSourceOptionsWithScroll(page);
  if (topLevelOptions.length === 0) {
    await openSourceDropdown(page, trigger);
    topLevelOptions = await collectReferralSourceOptionsWithScroll(page);
  }

  console.log(`    📋 Source options (DOM): [${topLevelOptions.slice(0, 10).join(', ')}${topLevelOptions.length > 10 ? ', ...' : ''}]`);

  if (topLevelOptions.length === 0) {
    return { success: false, domOptions: [] };
  }

  const topLevelKeys = new Set(topLevelOptions.map(normalizeKey));
  const attempts = buildOrderedSourceAttempts(topLevelOptions, profile);
  console.log(`    🔄 Trying ${attempts.length} source attempt(s) from workdayDefaults.mjs (hierarchical first)...`);

  for (const attempt of attempts) {
    if (attempt.type === 'hierarchical') {
      console.log(`    ↳ Attempt: "${attempt.parent}" → "${attempt.child}"`);
      const childTryList = [
        attempt.child,
        ...getChildCandidatesForParent(attempt.parent).filter((c) => c !== attempt.child),
      ];

      const selected = await tryHierarchicalSource(page, trigger, attempt.parent, childTryList, topLevelKeys);
      if (selected) {
        return { success: true, selected, domOptions: topLevelOptions };
      }
      continue;
    }

    console.log(`    ↳ Attempt flat: "${attempt.value}"`);
    const selected = await tryFlatSource(page, trigger, attempt.value);
    if (selected) {
      return { success: true, selected, domOptions: topLevelOptions };
    }
  }

  const display = await getReferralSourceDisplay(page);
  console.log(`    ⚠️  All workdayDefaults.mjs source attempts failed. DOM: "${display || '(empty)'}" — will ask in terminal.`);
  return { success: false, domOptions: topLevelOptions };
}

/**
 * Apply a terminal/yaml answer — runs full hierarchical flow when answer is a parent category.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string} userAnswer
 * @returns {Promise<{ success: boolean, selected?: string }>}
 */
export async function applySourceTerminalAnswer(page, profile, userAnswer) {
  const answer = normalizeOptionText(userAnswer);
  if (!answer || isInvalidSourceAnswer(answer)) {
    return { success: false };
  }

  if (isHierarchicalParentOption(answer)) {
    console.log(`    ℹ️  "${answer}" is a parent category — drilling down to child (LinkedIn/Indeed/Glassdoor from defaults)...`);
    let trigger = await locateReferralSourceControl(page);
    trigger = trigger ? await ensureSourceTrigger(page, trigger) : null;
    if (!trigger) return { success: false };

    await openSourceDropdown(page, trigger);
    const topLevelOptions = await collectReferralSourceOptionsWithScroll(page);
    const parentMatch = matchPreferredToDomOption(answer, topLevelOptions, { strict: true })
      || matchParentInDom(answer, topLevelOptions);
    if (!parentMatch) return { success: false };

    const topLevelKeys = new Set(topLevelOptions.map(normalizeKey));
    const children = getChildCandidatesForParent(parentMatch);
    const selected = await tryHierarchicalSource(page, trigger, parentMatch, children, topLevelKeys);
    return selected ? { success: true, selected } : { success: false };
  }

  let trigger = await locateReferralSourceControl(page);
  trigger = trigger ? await ensureSourceTrigger(page, trigger) : null;
  if (!trigger) return { success: false };

  const topLevelOptions = await collectReferralSourceOptionsWithScroll(page);
  const topLevelKeys = new Set(topLevelOptions.map(normalizeKey));

  for (const [parentPref, childPref] of WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES) {
    if (!displayMatchesExpected(answer, childPref) && normalizeKey(answer) !== normalizeKey(childPref)) continue;
    const parentMatch = matchPreferredToDomOption(parentPref, topLevelOptions, { strict: true });
    if (!parentMatch) continue;
    const selected = await tryHierarchicalSource(page, trigger, parentMatch, [answer, childPref], topLevelKeys);
    if (selected) return { success: true, selected };
  }

  const flatMatch = matchPreferredToDomOption(answer, topLevelOptions, { strict: false });
  if (flatMatch) {
    const selected = await tryFlatSource(page, trigger, flatMatch);
    if (selected) return { success: true, selected };
  }

  return { success: false };
}

/**
 * True when the source field looks complete (child selected, not parent-only).
 * @param {string} display
 * @returns {boolean}
 */
export function isReferralSourceFullySelected(display) {
  const d = normalizeOptionText(display);
  if (!d || /select one|required|search/i.test(d)) return false;
  if (isHierarchicalParentOption(d)) return false;
  return d.length > 1;
}

/**
 * Full auto-fill for referral source — yaml/mjs/URL only, never terminal (parallel-safe).
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ success: boolean, selected?: string, domOptions?: string[] }>}
 */
export async function fillSourceFieldAuto(page, profile = {}) {
  const url = page.url();
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(350);

  let trigger = await locateReferralSourceControl(page);
  if (!trigger) {
    await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
    await page.waitForTimeout(400);
    trigger = await locateReferralSourceControl(page);
  }
  if (trigger) trigger = await ensureSourceTrigger(page, trigger);

  if (!trigger) {
    console.log('    ⚠️  Source control not found — scanned labels for "How did you hear"');
    const labels = await page.evaluate(() => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('label, [data-automation-id*="label"], [data-automation-id*="richText"]'))
        .map((el) => norm(el.textContent).replace(/\*+$/, ''))
        .filter((t) => t && t.length < 80)
        .slice(0, 25);
    });
    console.log(`    🔍 Page labels: ${labels.join(' | ')}`);
    return { success: false, domOptions: [] };
  }

  const controlId = await trigger.evaluate((el) => el.id || el.getAttribute('data-automation-id') || '').catch(() => '');
  console.log(`    🎯 Source control located: ${controlId || '(referral source)'}`);

  const current = await getReferralSourceDisplay(page);
  if (isReferralSourceFullySelected(current)) {
    console.log(`    ✓ Source already set: "${current}"`);
    return { success: true, selected: current };
  }

  // Referral source is intentionally not a client fact. Pick a valid live
  // dropdown path first so stale profile/YAML values cannot be submitted.
  console.log('    🎲 Source fallback: picking a live dropdown option...');
  const randomResult = await tryPickAnyHierarchicalSource(page, trigger);
  display = await getReferralSourceDisplay(page);
  if (randomResult?.success && isReferralSourceFullySelected(display)) {
    const selected = randomResult.selected || display;
    console.log(`    ✅ Source pick-any: "${selected}"`);
    return { success: true, selected, domOptions: [] };
  }

  // 1) Hierarchical + flat attempts from workdayDefaults.mjs
  let result = await fillHowDidYouHearFromDom(page, profile);
  let display = await getReferralSourceDisplay(page);
  if (result.success && isReferralSourceFullySelected(display)) {
    return { success: true, selected: result.selected || display, domOptions: result.domOptions };
  }

  // 2) Try each auto candidate (profile → URL → LinkedIn → Indeed → Glassdoor…)
  const candidates = resolveSourceAnswerCandidates(profile, url);
  console.log(`    🔄 Auto source from yaml/mjs/URL: [${candidates.slice(0, 8).join(', ')}${candidates.length > 8 ? ', ...' : ''}]`);

  for (const answer of candidates) {
    console.log(`    ↳ Applying: "${answer}"`);
    const applied = await applySourceTerminalAnswer(page, profile, answer);
    display = await getReferralSourceDisplay(page);
    if (applied.success && applied.selected && isReferralSourceFullySelected(display)) {
      console.log(`    ✅ Source auto-filled: "${applied.selected}" (DOM: "${display}")`);
      return { success: true, selected: applied.selected, domOptions: result.domOptions };
    }
  }

  // 3) Retry defaults pass (dropdown may need second open)
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    result = await fillHowDidYouHearFromDom(page, profile);
    display = await getReferralSourceDisplay(page);
    if (result.success && isReferralSourceFullySelected(display)) {
      return { success: true, selected: result.selected || display, domOptions: result.domOptions };
    }
  }

  // 4) Pick ANY valid parent → ANY child (user preference: any dropdown selection is fine)
  console.log('    🎲 Source fallback: picking any parent + child from live DOM...');
  const anyResult = await tryPickAnyHierarchicalSource(page, trigger);
  display = await getReferralSourceDisplay(page);
  if (anyResult?.success && isReferralSourceFullySelected(display)) {
    const selected = anyResult.selected || display;
    console.log(`    ✅ Source pick-any: "${selected}"`);
    return { success: true, selected, domOptions: result.domOptions || [] };
  }

  display = await getReferralSourceDisplay(page);
  console.log(`    ⚠️  Source auto-fill incomplete (DOM: "${display || '(empty)'}") — continuing apply`);
  return { success: false, domOptions: result.domOptions || [], selected: display || undefined };
}

/**
 * Last resort: open source dropdown, click first valid parent, then first valid child.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} trigger
 */
async function tryPickAnyHierarchicalSource(page, trigger) {
  if (!trigger) {
    trigger = await locateReferralSourceControl(page);
    if (trigger) trigger = await ensureSourceTrigger(page, trigger);
  }
  if (!trigger) return { success: false };

  const isSkippableOption = (text) => {
    const t = normalizeOptionText(text);
    if (!t || /^select(\s+one)?\.?$/i.test(t)) return true;
    if (isPhoneCodeDropdownOption(t)) return true;
    if (/required|search/i.test(t)) return true;
    return false;
  };

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
  await openSourceDropdown(page, trigger);

  const topLevel = await collectReferralSourceOptionsWithScroll(page);
  const topLevelKeys = new Set(topLevel.map(normalizeKey));
  const parents = topLevel
    .filter((o) => !isSkippableOption(o))
    .sort(() => Math.random() - 0.5);
  if (parents.length === 0) return { success: false };

  for (const parent of parents) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    trigger = await locateReferralSourceControl(page);
    if (trigger) trigger = await ensureSourceTrigger(page, trigger);
    if (!trigger) continue;

    await openSourceDropdown(page, trigger);
    const parentClicked = await clickSourceListOption(page, parent);
    if (!parentClicked) continue;
    console.log(`    🎲 Picked parent: "${parentClicked}"`);
    await page.waitForTimeout(850);

    let childOptions = await collectSubmenuOptions(page, topLevelKeys);
    childOptions = childOptions.sort(() => Math.random() - 0.5);
    if (childOptions.length === 0) {
      await page.keyboard.press('ArrowRight').catch(() => {});
      await page.waitForTimeout(450);
      childOptions = await collectSubmenuOptions(page, topLevelKeys);
    }

    const flatDisplay = await getReferralSourceDisplay(page);
    if (childOptions.length === 0 && isReferralSourceFullySelected(flatDisplay)) {
      return { success: true, selected: flatDisplay };
    }

    const children = childOptions.filter((o) => !isSkippableOption(o));
    for (const child of children) {
      const childClicked = await clickSourceListOption(page, child);
      if (!childClicked) continue;
      console.log(`    🎲 Picked child: "${childClicked}"`);
      await page.waitForTimeout(550);
      const display = await getReferralSourceDisplay(page);
      if (isReferralSourceFullySelected(display)) {
        return { success: true, selected: display };
      }
    }
  }

  return { success: false };
}

export { SOURCE_LABEL };
