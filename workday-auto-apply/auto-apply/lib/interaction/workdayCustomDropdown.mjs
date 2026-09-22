/**
 * Workday custom dropdown / combobox (selectOne, selectWidget, SVG chevron).
 *
 * Live VD pages put the question text in richText and the clickable control in a
 * sibling selectOne/selectWidget. Options render in a page-level popup
 * (`promptOption`), not inside the field. Click the widget next to the label —
 * never the first button in a matching ancestor.
 */

import { waitForDomSettled } from '../workdayDom.mjs';
import { extractYesNoAnswer } from '../workdayDefaults.mjs';

const MAX_ATTEMPTS = 3;

const OPTION_SELECTOR = [
  '[data-automation-id="promptOption"]',
  '[data-automation-id="promptLeafNode"]',
  '[role="option"]',
  '[data-automation-id="menuItem"]',
  '[role="listbox"] [role="option"]',
].join(', ');

const SEARCH_SELECTOR = [
  'input[role="searchbox"]',
  'input[type="search"]',
  '[data-automation-id*="searchBox"] input',
  '[data-automation-id*="promptSearch"] input',
  '[data-automation-id="promptSearchField"]',
  '[data-automation-id*="searchField"] input',
  'input[placeholder*="Search" i]',
  'input[aria-label*="Search" i]',
].join(', ');

export function normalizeDemoText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[*•]/g, ' ')
    .replace(/[.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop a leading Yes/No so "No, I am not a veteran" matches "I am not a veteran". */
export function stripLeadingYesNoPhrase(value = '') {
  return normalizeDemoText(value).replace(/^(yes|no)[,.\s]+/, '').trim();
}

/**
 * Veteran option polarity. "I am not a veteran" is not the same as
 * "I am not a protected veteran" (that can still be a veteran).
 */
export function veteranStatusKind(text = '') {
  const t = stripLeadingYesNoPhrase(text);
  if (!t) return '';
  if (/choose not to disclose|do not (wish|want) to|decline to|prefer not/.test(t)) return 'decline';
  if (/identify as one or more|classifications of (a )?protected veteran/.test(t)) return 'protected';
  if (/identify as a veteran|just not a protected/.test(t)) return 'veteran_not_protected';
  if (/not a protected veteran/.test(t)) return 'not_protected';
  if (/not a veteran/.test(t)) return 'not_veteran';
  return '';
}

export function isSelectOnePlaceholder(value = '') {
  return !String(value || '').trim() || /^select(\s+one)?\.?$/i.test(String(value).trim());
}

export function eeoQuestionKind(text = '') {
  const t = normalizeDemoText(text).replace(/[^\w\s]/g, ' ');
  if (/hispanic|latino/.test(t)) return 'hispanic';
  if (/veteran/.test(t)) return 'veteran';
  if (/\bgender\b|\bsex\b/.test(t)) return 'gender';
  if (/\bethnicity\b|\brace\b/.test(t)) return 'race';
  return '';
}

/**
 * Exact whitespace/case match first. Unique leaf/prefix only when one option remains.
 */
export function matchDemographicOption(answer, options = []) {
  const wanted = normalizeDemoText(answer);
  if (!wanted || !options.length) return null;
  const cleaned = options.map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const stripped = stripLeadingYesNoPhrase(wanted);

  const exact = cleaned.find((o) => normalizeDemoText(o) === wanted);
  if (exact) return exact;

  const exactStripped = cleaned.find((o) => stripLeadingYesNoPhrase(o) === stripped);
  if (exactStripped) return exactStripped;

  const wantVet = veteranStatusKind(wanted);
  if (wantVet) {
    const same = cleaned.filter((o) => veteranStatusKind(o) === wantVet);
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      return [...same].sort((a, b) => a.length - b.length)[0];
    }
    if (wantVet === 'not_veteran') {
      const fallback = cleaned.filter((o) => veteranStatusKind(o) === 'not_protected');
      if (fallback.length === 1) return fallback[0];
    }
    if (wantVet === 'not_protected') {
      const fallback = cleaned.filter((o) => veteranStatusKind(o) === 'not_veteran');
      if (fallback.length === 1) return fallback[0];
    }
  }

  const yn = extractYesNoAnswer(wanted);
  if (yn && !wantVet) {
    const hits = cleaned.filter((o) => extractYesNoAnswer(o) === yn);
    if (hits.length === 1) return hits[0];
  }

  const uniquePrefix = cleaned.filter((o) => {
    const n = normalizeDemoText(o);
    return n === wanted || n === stripped
      || n.startsWith(`${wanted} `) || n.startsWith(`${stripped} `)
      || n.startsWith(`${wanted}(`) || n.startsWith(`${stripped}(`)
      || n.startsWith(`${wanted},`) || n.startsWith(`${stripped},`);
  });
  if (uniquePrefix.length === 1) return uniquePrefix[0];
  return null;
}

export function inferWidgetKind(raw = {}) {
  if (raw.nativeSelect === true) return 'native-select';
  if (raw.widgetKind) return raw.widgetKind;
  if (raw.selectOneIndex != null || /select-one|selectwidget/i.test(String(raw.fieldType || ''))) {
    return 'workday-selectOne';
  }
  if (/combobox|typeahead/i.test(String(raw.fieldType || raw.role || ''))) return 'aria-combobox';
  if (/dropdown|select/i.test(String(raw.fieldType || ''))) return 'custom-dropdown';
  return 'unknown';
}

function normLabel(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Mark the selectOne/selectWidget that belongs to this question.
 * Pair each widget to its own question sentence so a shared Voluntary legal
 * blob (which mentions veteran/ethnicity/gender) cannot attach every dropdown
 * to the first widget.
 */
export async function markDropdownByLabel(page, targetArg = '') {
  const target = typeof targetArg === 'string'
    ? { label: targetArg, questionId: '' }
    : { label: targetArg?.label || '', questionId: targetArg?.questionId || targetArg?._raw?.wdQId || '' };
  return page.evaluate((tgt) => {
    function norm(s) {
      return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function kind(text) {
      const t = norm(text);
      if (/hispanic|latino/.test(t)) return 'hispanic';
      if (/veteran/.test(t)) return 'veteran';
      if (/\bgender\b|\bsex\b/.test(t)) return 'gender';
      if (/\bethnicity\b|\brace\b/.test(t)) return 'race';
      return '';
    }
    function clean(s) {
      return String(s || '').replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
    }
    function splitQuestions(text) {
      const t = clean(text);
      if (!t) return [];
      const found = [];
      const re = /please select the veteran status[^.?!]{0,160}[.?!]?|please indicate whether you are in one or more of the protected veteran[^.?!]{0,80}[.?!]?|please select your (?:veteran|veterans) status[^.?!]{0,80}[.?!]?|please select the (?:ethnicity|race|gender|sex)[^.?!]{0,160}[.?!]?|please select your (?:gender|sex|race|ethnicity)[^.?!]{0,80}[.?!]?|are you hispanic[^.?!]{0,60}[.?!]?|[^.!?]{8,600}\?/gi;
      let m;
      while ((m = re.exec(t))) {
        const s = clean(m[0]);
        if (s && !found.some((x) => norm(x) === norm(s))) found.push(s);
      }
      if (found.length) return found;
      if (t.length >= 3) return [t];
      return [];
    }
    function isNestedSelectWidget(widget) {
      return widget.closest('[data-automation-id="selectOne"]')
        && widget.getAttribute('data-automation-id') === 'selectWidget';
    }
    function readValue(widget) {
      const selected = widget.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectedItem"]');
      if (selected?.textContent?.trim()) {
        const t = selected.textContent.replace(/\s+/g, ' ').trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const btn = widget.querySelector('button, [role="combobox"]') || (widget.matches('button, [role="combobox"]') ? widget : null);
      const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 160 && !/\?$/.test(t)) return t;
      return '';
    }
    function widgetAria(widget) {
      const bits = [
        widget.getAttribute('aria-label'),
        widget.querySelector('[aria-label]')?.getAttribute('aria-label'),
        widget.getAttribute('data-automation-label'),
        widget.getAttribute('data-automation-id'),
      ];
      return bits.map(clean).filter((s) => s && s.length < 240);
    }

    document.querySelectorAll('[data-wd-eeo-target]').forEach((el) => el.removeAttribute('data-wd-eeo-target'));
    document.querySelectorAll('[data-wd-eeo-target-root]').forEach((el) => el.removeAttribute('data-wd-eeo-target-root'));

    const targetLabel = tgt.label || '';
    const targetQId = tgt.questionId || '';
    const wantKind = kind(targetLabel);
    const wantNorm = norm(targetLabel);

    // 0. Direct match by persistent data-wd-q-id marker
    if (targetQId) {
      const markedContainer = document.querySelector(`[data-wd-q-id="${CSS.escape(targetQId)}"]`);
      if (markedContainer) {
        const directWidget = markedContainer.querySelector('[data-automation-id="selectOne"], [data-automation-id="selectWidget"], [data-automation-id="select-one"], button[aria-haspopup="listbox"], button[aria-haspopup], [role="combobox"]');
        if (directWidget && !isNestedSelectWidget(directWidget)) {
          directWidget.setAttribute('data-wd-eeo-target', '1');
          return { found: true, current: readValue(directWidget), score: 300 };
        }
      }
    }

    // Direct match: find container by label text first
    const containers = Array.from(document.querySelectorAll('[data-automation-id*="formField"], [data-automation-id*="question"], [data-automation-id*="secondaryQuestionnaire"], [data-wd-q-id], fieldset, [role="group"]'));
    for (const c of containers) {
      const cText = norm(c.textContent);
      if (wantNorm && (cText.includes(wantNorm.slice(0, 40)) || wantNorm.includes(cText.slice(0, 40)))) {
        const directWidget = c.querySelector('[data-automation-id="selectOne"], [data-automation-id="selectWidget"], [data-automation-id="select-one"], button[aria-haspopup="listbox"], button[aria-haspopup], [role="combobox"]');
        if (directWidget && !isNestedSelectWidget(directWidget)) {
          directWidget.setAttribute('data-wd-eeo-target', '1');
          return { found: true, current: readValue(directWidget), score: 200 };
        }
      }
    }

    const widgets = Array.from(document.querySelectorAll(
      '[data-automation-id="selectOne"], [data-automation-id="selectWidget"], [data-automation-id="select-one"], [data-automation-id="multiSelectContainer"], button[aria-haspopup="listbox"], [role="combobox"]',
    )).filter((w) => !isNestedSelectWidget(w));

    const questions = [];
    const labelEls = Array.from(document.querySelectorAll(
      '[data-automation-id*="richText"], label, legend, [data-automation-id*="label"], [data-automation-id*="formLabel"]',
    ));
    for (const el of labelEls) {
      if (el.querySelector('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]')) continue;
      for (const text of splitQuestions(el.textContent || '')) {
        questions.push({ text, el, kind: kind(text) });
      }
    }

    const used = new Set();
    const pairs = widgets.map((widget) => {
      const wrect = widget.getBoundingClientRect();
      const sameElFirst = [];
      let closestIdx = -1;
      let closestTop = -Infinity;
      for (let i = 0; i < questions.length; i++) {
        if (used.has(i)) continue;
        const qrect = questions[i].el.getBoundingClientRect();
        if (qrect.top > wrect.top + 12) continue;
        if (qrect.top >= closestTop) {
          closestTop = qrect.top;
          closestIdx = i;
        }
      }
      if (closestIdx >= 0) {
        const el = questions[closestIdx].el;
        for (let i = 0; i < questions.length; i++) {
          if (used.has(i)) continue;
          if (questions[i].el === el && questions[i].el.getBoundingClientRect().top <= wrect.top + 12) {
            sameElFirst.push(i);
          }
        }
      }
      const pickIdx = sameElFirst.length ? sameElFirst[0] : closestIdx;
      if (pickIdx >= 0) used.add(pickIdx);
      const pairedText = pickIdx >= 0 ? questions[pickIdx].text : '';
      const ariaBits = widgetAria(widget);
      const exclusiveAria = ariaBits.find((a) => kind(a) || a.length >= 8) || '';
      return {
        widget,
        pairedText,
        exclusiveAria,
        autoId: String(widget.getAttribute('data-automation-id') || ''),
        kind: kind(exclusiveAria) || kind(pairedText) || kind(ariaBits.join(' ')),
      };
    });

    let best = null;
    let bestScore = -1;
    for (const pair of pairs) {
      let score = 0;
      const labels = [pair.exclusiveAria, pair.pairedText].filter(Boolean);
      if (wantKind && pair.kind === wantKind) score += 120;
      if (wantKind && pair.kind && pair.kind !== wantKind) score -= 110;
      if (wantKind === 'veteran' && /veteran/i.test(pair.autoId)) score += 160;
      for (const lab of labels) {
        const n = norm(lab);
        if (!n) continue;
        const labKind = kind(lab);
        if (n === wantNorm) score += 140;
        if (wantNorm && n.includes(wantNorm.slice(0, 40))) score += 70;
        if (wantNorm && wantNorm.includes(n.slice(0, 40)) && n.length > 12) score += 40;
        if (wantKind && labKind === wantKind) score += 30;
        if (wantKind && labKind && labKind !== wantKind) score -= 50;
      }
      if (score > bestScore) {
        bestScore = score;
        best = pair.widget;
      }
    }

    if (!best || bestScore < 30) {
      const kindHit = pairs.find((p) => wantKind && p.kind === wantKind);
      if (kindHit) {
        best = kindHit.widget;
        bestScore = 80;
      }
    }
    if (!best || bestScore < 30) return { found: false, current: '', score: bestScore };
    best.setAttribute('data-wd-eeo-target', '1');
    return { found: true, current: readValue(best), score: bestScore };
  }, target);
}

async function readVisibleOptions(page) {
  return page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes
      .filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length;
      })
      .map((el) => (el.getAttribute('data-automation-label') || el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && !/^select(\s+one)?\.?$/i.test(t));
  }, OPTION_SELECTOR).catch(() => []);
}

async function collectOpenOptions(page) {
  await page.waitForSelector(OPTION_SELECTOR, { timeout: 2000, state: 'visible' }).catch(() => {});
  return readVisibleOptions(page);
}

async function optionsVisible(page, timeout = 450) {
  const opened = await page.waitForSelector(OPTION_SELECTOR, { timeout, state: 'visible' }).catch(() => null);
  if (opened) return true;
  return (await readVisibleOptions(page)).length > 0;
}

async function searchBoxVisible(page) {
  return page.locator(SEARCH_SELECTOR).last().isVisible().catch(() => false);
}

async function promptUiOpen(page, timeout = 450) {
  if (await optionsVisible(page, timeout)) return true;
  return searchBoxVisible(page);
}

async function typeIntoOpenPrompt(page, text) {
  const needle = String(text || '').replace(/\s+/g, ' ').trim();
  if (!needle) return false;
  const loc = page.locator(SEARCH_SELECTOR).last();
  if (await loc.isVisible().catch(() => false)) {
    await loc.click({ force: true }).catch(() => {});
    await loc.fill('').catch(() => {});
    await loc.pressSequentially(needle, { delay: 25 }).catch(async () => {
      await loc.fill(needle).catch(() => {});
    });
    return true;
  }
  await page.keyboard.type(needle, { delay: 25 }).catch(() => {});
  return true;
}

async function clickChevronSide(page, loc) {
  const box = await loc.boundingBox().catch(() => null);
  if (!box || box.width < 8) return false;
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  return true;
}

async function forceActivate(loc) {
  await loc.click({ force: true, timeout: 2500 }).catch(async () => {
    await loc.evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      if (typeof el.click === 'function') el.click();
    });
  });
}

async function clickMarkedWidget(page) {
  const marked = page.locator('[data-wd-eeo-target="1"]').first();
  if (!(await marked.count())) return false;
  await marked.scrollIntoViewIfNeeded().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  const targets = [
    marked.locator('[data-automation-id="promptIcon"]').first(),
    marked.locator('[data-automation-id="arrow"]').first(),
    marked.locator('[data-automation-id="selectWidget"]').first(),
    marked.locator('button[aria-haspopup="listbox"]').first(),
    marked.locator('[role="combobox"]').first(),
    marked.locator('button').first(),
    marked,
  ];

  let attempts = 0;
  for (const loc of targets) {
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    await forceActivate(loc);
    // One open attempt first — extra clicks toggle Workday's prompt closed.
    if (await promptUiOpen(page, attempts === 0 ? 2200 : 800)) return true;
    await clickChevronSide(page, loc);
    if (await promptUiOpen(page, 1000)) return true;
    attempts += 1;
    if (attempts >= 2) break;
  }

  await marked.evaluate((el) => {
    const hit = el.querySelector('[data-automation-id="promptIcon"], [data-automation-id="arrow"], [data-automation-id="selectWidget"], button, [role="combobox"]') || el;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof hit.click === 'function') hit.click();
  }).catch(() => {});
  return promptUiOpen(page, 1500);
}

async function readMarkedValue(page) {
  return page.evaluate(() => {
    const widget = document.querySelector('[data-wd-eeo-target="1"]');
    if (!widget) return '';
    const selected = widget.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectedItem"]');
    if (selected?.textContent?.trim()) {
      const t = selected.textContent.replace(/\s+/g, ' ').trim();
      if (!/^select(\s+one)?\.?$/i.test(t)) return t;
    }
    const btn = widget.querySelector('button[aria-haspopup="listbox"], [role="combobox"], button');
    const t = ((btn || widget).textContent || '').replace(/\s+/g, ' ').trim();
    if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 160 && !/\?$/.test(t)) return t;
    return '';
  }).catch(() => '');
}

async function clickExactOption(page, text) {
  const exact = page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(`^\\s*${escapeRe(text)}\\s*$`, 'i') });
  const count = await exact.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = exact.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true, timeout: 2500 }).catch(async () => {
      await el.evaluate((node) => node.click());
    });
    return true;
  }
  return page.evaluate(({ wanted, sel }) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const hit = nodes.find((el) => {
      const t = norm(el.getAttribute('data-automation-label') || el.textContent);
      if (t === wanted) return true;
      if (/^i am not a veteran$/i.test(wanted) && /i am not a veteran/i.test(t) && !/protected/i.test(t)) {
        return true;
      }
      return false;
    });
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    hit.click();
    return true;
  }, { wanted: text, sel: OPTION_SELECTOR });
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open the widget beside the question, rescan live options, select exact text, verify.
 */
export async function fillWorkdayCustomDropdown(page, field, answer) {
  const widgetKind = inferWidgetKind(field._raw || field);
  const wanted = String(answer || '').trim();
  const label = String(field.label || field._raw?.label || '').replace(/\*+/g, '').trim();
  const targetObj = { label, questionId: field.questionId || field._raw?.wdQId || '' };
  if (!wanted) {
    return { success: false, verifiedValue: '', options: [], reason: 'missing_answer', widgetKind };
  }

  const mark = await markDropdownByLabel(page, targetObj);
  if (!mark?.found) {
    return { success: false, verifiedValue: '', options: [], reason: 'field_not_found', widgetKind };
  }

  const before = mark.current || await readMarkedValue(page);
  if (before && matchDemographicOption(wanted, [before]) && !isSelectOnePlaceholder(before)) {
    return { success: true, verifiedValue: before, options: [before], widgetKind };
  }

  let lastOptions = [];
  const typeNeedle = veteranStatusKind(wanted) === 'not_veteran'
    ? 'I am not a veteran'
    : wanted;
  for (let attempt = 1; attempt <= 1; attempt++) {
    await markDropdownByLabel(page, targetObj);
    await clickMarkedWidget(page);
    lastOptions = await collectOpenOptions(page);
    if (!lastOptions.length) {
      await typeIntoOpenPrompt(page, typeNeedle);
      await page.waitForTimeout(350);
      lastOptions = await collectOpenOptions(page);
    }
    const pick = matchDemographicOption(wanted, lastOptions);
    if (!pick) {
      await page.keyboard.press('Escape').catch(() => {});
      return {
        success: false,
        verifiedValue: await readMarkedValue(page),
        options: lastOptions,
        reason: lastOptions.length ? 'option_not_in_list' : 'options_not_visible',
        widgetKind,
        attempts: attempt,
      };
    }
    const clicked = await clickExactOption(page, pick);
    await waitForDomSettled(page, { timeout: 800 }).catch(() => {});
    const actual = await readMarkedValue(page);
    if (clicked && actual && matchDemographicOption(wanted, [actual]) && !isSelectOnePlaceholder(actual)) {
      return { success: true, verifiedValue: actual, options: lastOptions, widgetKind, attempts: attempt };
    }
    if (await optionsVisible(page, 200)) {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  return {
    success: false,
    verifiedValue: await readMarkedValue(page),
    options: lastOptions,
    reason: 'verification_failed',
    widgetKind,
    attempts: MAX_ATTEMPTS,
  };
}

export { normLabel };
