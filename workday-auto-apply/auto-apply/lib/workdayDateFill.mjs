/**
 * workdayDateFill.mjs — Fill Workday My Experience From/To calendar spin maps.
 *
 * Workday month/year widgets are a pair of spin inputs (dateSectionMonth / dateSectionYear).
 * A human types the month digits, the widget advances, then types the year.
 * Do not Tab between segments and do not click the calendar icon.
 */

export const DATE_INPUT_SELECTOR = [
  'input[role="spinbutton"]',
  '[role="spinbutton"]',
  'input[data-automation-id*="dateSectionMonth"]',
  'input[data-automation-id*="dateSectionYear"]',
  'input[data-automation-id*="dateSectionDay"]',
  'input[data-automation-id*="dateSection"]',
  '[data-automation-id="dateSectionMonth-input"]',
  '[data-automation-id="dateSectionYear-input"]',
  '[data-automation-id="dateSectionDay-input"]',
  '[data-automation-id="dateSectionMonth-display"]',
  '[data-automation-id="dateSectionYear-display"]',
  '[data-automation-id="dateSectionDay-display"]',
  '[data-automation-id*="dateSectionMonth-input"]',
  '[data-automation-id*="dateSectionYear-input"]',
  '[data-automation-id*="dateSectionMonth-display"]',
  '[data-automation-id*="dateSectionYear-display"]',
  '[data-automation-id*="dateInputWrapper"] input:not([type="hidden"]):not([type="checkbox"])',
  'input[aria-label*="Month" i]',
  'input[aria-label*="Year" i]',
  'input[aria-label*="Day" i]',
  'input[placeholder="MM"]',
  'input[placeholder="YYYY"]',
  'input[placeholder="M"]',
  'input[placeholder="YY"]',
].join(', ');

const PLACEHOLDER_RE = /^(m+|y+|d+|mm|yyyy|yy|dd|empty|select)$/i;

/**
 * Drop Workday placeholders so "MM/YYYY" is never treated as a filled date.
 * @param {string} raw
 * @returns {string}
 */
export function cleanSpinValue(raw = '') {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!v || PLACEHOLDER_RE.test(v)) return '';
  return v;
}

/**
 * Month and year must both match. A leftover year (2/2025 for 06/2025) is a miss.
 * @param {{month?: string, year?: string, text?: string}} actual
 * @param {{month: string, year: string}} expected
 * @param {{requireMonth?: boolean}} [opts]
 */
export function strictDateMatch(actual, expected, opts = {}) {
  const year = cleanSpinValue(actual?.year) || (String(actual?.text || '').match(/(1[89]\d{2}|20\d{2}|21\d{2})/) || [])[1] || '';
  const monthRaw = cleanSpinValue(actual?.month);
  const fromText = String(actual?.text || '').match(/^(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  const month = monthRaw || (fromText ? fromText[1] : '');
  const yearFinal = year || (fromText ? fromText[2] : '');
  if (String(yearFinal) !== String(expected.year)) return false;
  if (String(yearFinal).length !== 4) return false;
  if (opts.requireMonth !== false) {
    if (!month || String(month).length > 2) return false;
    if (Number(month) !== Number(expected.month)) return false;
  }
  return true;
}

/**
 * Classify a Workday date-segment control from its attributes.
 * @param {string} hint
 * @returns {'month'|'year'|'day'|''}
 */
export function classifyDateHint(hint = '') {
  const h = String(hint || '').toLowerCase();
  if (!h) return '';
  if (/dateicon|calendar/.test(h)) return '';
  if (/year|yyyy|dateSectionYear/.test(h)) return 'year';
  if (/month|\bmm\b|dateSectionMonth/.test(h)) return 'month';
  if (/day|\bdd\b|dateSectionDay/.test(h)) return 'day';
  return '';
}

/**
 * True when a From/To label (or its required marker) shows Workday's star.
 * @param {string} text
 * @returns {boolean}
 */
export function isRequiredLabelText(text = '') {
  const t = String(text || '');
  if (/\*/.test(t)) return true;
  if (/\brequired\b/i.test(t)) return true;
  return false;
}

/**
 * Parse MM/YYYY or YYYY into month + year digits for the spin map.
 * @param {string|number} value
 * @param {'monthyear'|'year'} mode
 * @returns {{month: string, year: string, padded: string}|null}
 */
export function parseDateFillValue(value, mode = 'monthyear') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const my = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  if (my) {
    const month = Number(my[1]);
    const year = Number(my[2]);
    if (month < 1 || month > 12 || year < 1900 || year > 2100) return null;
    const mm = String(month).padStart(2, '0');
    return { month: mm, year: String(year), padded: `${mm}/${year}` };
  }
  const y = raw.match(/^(1[89]\d{2}|20\d{2}|21\d{2})$/);
  if (y) {
    const year = y[1];
    const month = mode === 'year' ? '01' : '01';
    return { month, year, padded: `${month}/${year}` };
  }
  return null;
}

function dateHintFromEl(el) {
  return [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('data-automation-id'),
    el.getAttribute?.('name'),
    el.id,
    el.getAttribute?.('aria-roledescription'),
  ].filter(Boolean).join(' ');
}

/**
 * Mark the month/year spins that belong to one From/To label.
 * @param {import('playwright').Page} page
 * @param {{labelPattern: string, sectionType?: string}} opts
 * @returns {Promise<{found: boolean, required: boolean, count: number, reason?: string}>}
 */
export async function markDateWidget(page, opts) {
  return await page.evaluate(({ labelPattern, sectionType, dateSel, optionalRe }) => {
    document.querySelectorAll('[data-wd-date-month], [data-wd-date-year], [data-wd-date-day], [data-wd-date-root]')
      .forEach((el) => {
        el.removeAttribute('data-wd-date-month');
        el.removeAttribute('data-wd-date-year');
        el.removeAttribute('data-wd-date-day');
        el.removeAttribute('data-wd-date-root');
      });

    const labelRe = new RegExp(labelPattern, 'i');
    const optionalPattern = new RegExp(optionalRe, 'i');
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    function detectSection(el) {
      let node = el;
      for (let depth = 0; depth < 40 && node; depth++) {
        const auto = (node.getAttribute?.('data-automation-id') || '').toLowerCase();
        if (/certificat|licen[cs]|language|award|publication|affiliation|reference|socialnetwork|volunteer/.test(auto)) {
          return 'optional';
        }
        if (/workexperiencesection|work-experience-section|workexperiencepanelset|workexperienceitem/.test(auto)) {
          return 'work';
        }
        if (/educationsection|educationpanelset|educationitem/.test(auto)) return 'education';
        node = node.parentElement;
      }
      let nearest = '';
      const headings = document.querySelectorAll('h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"]');
      for (const h of headings) {
        const t = norm(h.textContent);
        if (!t || t.length > 60) continue;
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) nearest = t;
      }
      if (/work\s*experience/i.test(nearest)) return 'work';
      if (/^education\b/i.test(nearest)) return 'education';
      if (optionalPattern.test(nearest)) return 'optional';
      return 'unknown';
    }

    function classify(el) {
      const hint = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('data-automation-id'),
        el.getAttribute('name'),
        el.id,
      ].filter(Boolean).join(' ').toLowerCase();
      if (/dateicon|calendar/.test(hint)) return '';
      if (/year|yyyy|datesectionyear/.test(hint)) return 'year';
      if (/month|\bmm\b|datesectionmonth/.test(hint)) return 'month';
      if (/day|\bdd\b|datesectionday/.test(hint)) return 'day';
      return '';
    }

    function isDateControl(el) {
      if (!el || el.disabled) return false;
      if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') return false;
      const auto = (el.getAttribute('data-automation-id') || '').toLowerCase();
      if (/dateicon|datepicker|calendar/.test(auto) && el.tagName === 'BUTTON') return false;
      if (/datesectionmonth-display|datesectionyear-display|datesectionday-display/.test(auto)) return true;
      if (el.getAttribute('role') === 'spinbutton') return true;
      if (el.tagName === 'INPUT' && /dateSection|dateInput/i.test(auto)) return true;
      if (el.tagName === 'INPUT' && classify(el)) return true;
      if (el.tagName === 'INPUT' && /^(mm|yyyy|m|yy|dd)$/i.test(el.getAttribute('placeholder') || '')) return true;
      return false;
    }

    function unwrapDateControl(el) {
      if (!el) return null;
      if (isDateControl(el)) return el;
      const auto = (el.getAttribute('data-automation-id') || '').toLowerCase();
      if (/datesectionmonth|datesectionyear|datesectionday|dateinputwrapper|datesection/.test(auto)) {
        const inner = el.querySelector('input:not([type="hidden"]), [role="spinbutton"]');
        if (inner && isDateControl(inner)) return inner;
        if (inner) return inner;
      }
      return null;
    }

    function collectControls(root) {
      if (!root) return [];
      const out = [];
      const seen = new Set();
      const add = (el) => {
        const control = unwrapDateControl(el);
        if (!control || seen.has(control)) return;
        seen.add(control);
        out.push(control);
      };
      add(root);
      for (const el of root.querySelectorAll(dateSel)) add(el);
      return out;
    }

    function labelRequired(labelEl, controls) {
      const own = norm(labelEl.textContent);
      if (/\*/.test(own) || /\brequired\b/i.test(own)) return true;
      if (labelEl.querySelector('[data-automation-id*="equired" i], [data-automation-id*="Required"], [aria-label*="required" i], abbr[title*="required" i], .asterisk, .required')) {
        return true;
      }
      let sib = labelEl.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++) {
        const t = norm(sib.textContent);
        const auto = sib.getAttribute('data-automation-id') || '';
        if (/\*/.test(t) || /required/i.test(auto) || /required/i.test(sib.className || '')) return true;
        sib = sib.nextElementSibling;
      }
      const field = labelEl.closest('[data-automation-id*="formField"], [data-automation-id*="Field"], fieldset, [role="group"]');
      if (field) {
        const head = norm(field.textContent).slice(0, 80);
        if (/\*/.test(head)) return true;
        if (field.querySelector('[data-automation-id*="formLabelRequired"], [data-automation-id*="Required"], [aria-required="true"]')) {
          return true;
        }
      }
      for (const el of controls) {
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
      }
      return false;
    }

    const labels = [];
    for (const el of document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"], [id*="label"]')) {
      const raw = norm(el.textContent);
      if (!raw || raw.length > 80) continue;
      const text = raw.replace(/\*+/g, '').trim();
      if (!labelRe.test(text)) continue;
      const sec = detectSection(el);
      if (sec === 'optional') continue;
      if (sectionType && sec !== sectionType && sec !== 'unknown') continue;
      if (sectionType === 'work' && sec === 'education') continue;
      if (sectionType === 'education' && sec === 'work') continue;
      labels.push(el);
    }
    if (!labels.length) return { found: false, required: false, count: 0, reason: 'no From/To label' };

    labels.sort((a, b) => {
      const aSec = detectSection(a);
      const bSec = detectSection(b);
      const aMatch = sectionType && aSec === sectionType ? 0 : 1;
      const bMatch = sectionType && bSec === sectionType ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    const labelEl = labels[0];
    const sameKind = labels.filter((el) => detectSection(el) === detectSection(labelEl) || detectSection(el) === 'unknown');
    const idx = sameKind.indexOf(labelEl);
    const nextLabel = sameKind[idx + 1] || null;

    function widgetWrappers(scope) {
      const nodes = [
        ...scope.querySelectorAll('[data-automation-id="dateInputWrapper"], [data-automation-id*="dateInputWrapper"]'),
        ...scope.querySelectorAll('[data-automation-id*="startDate"], [data-automation-id*="endDate"], [data-automation-id*="fromDate"], [data-automation-id*="toDate"]'),
      ];
      const seen = new Set();
      const out = [];
      for (const node of nodes) {
        const wrap = node.closest('[data-automation-id*="dateInputWrapper"]') || node;
        if (seen.has(wrap)) continue;
        const controls = collectControls(wrap);
        if (!controls.length) continue;
        seen.add(wrap);
        out.push({ wrap, controls });
      }
      return out;
    }

    function nearestControls(label, candidates) {
      if (!candidates.length) return [];
      const lr = label.getBoundingClientRect();
      let best = candidates[0];
      let bestScore = Infinity;
      for (const c of candidates) {
        const wr = c.wrap.getBoundingClientRect();
        const dx = wr.left + wr.width / 2 - (lr.left + lr.width / 2);
        const dy = wr.top + wr.height / 2 - (lr.top + lr.height / 2);
        const score = Math.abs(dx) + Math.abs(dy);
        if (score < bestScore) {
          best = c;
          bestScore = score;
        }
      }
      return best.controls;
    }

    const scopes = [
      labelEl.closest('[data-automation-id*="dateInputWrapper"]'),
      labelEl.closest('[data-automation-id*="formField"]'),
      labelEl.closest('[data-automation-id*="Field"]'),
      labelEl.closest('fieldset'),
      labelEl.closest('[role="group"]'),
      labelEl.parentElement,
      labelEl.parentElement?.parentElement,
      labelEl.parentElement?.parentElement?.parentElement,
    ].filter(Boolean);

    let controls = [];
    for (const scope of scopes) {
      const widgets = widgetWrappers(scope);
      if (widgets.length === 1) {
        controls = widgets[0].controls;
        break;
      }
      if (widgets.length > 1) {
        controls = nearestControls(labelEl, widgets);
        if (controls.length) break;
      }
      const found = collectControls(scope);
      const inOrNear = found.filter((el) => {
        const pos = labelEl.compareDocumentPosition(el);
        if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) return true;
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          if (!nextLabel) return true;
          return nextLabel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING;
        }
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
          return el.closest('[data-automation-id*="formField"], [data-automation-id*="dateInput"]')
            === labelEl.closest('[data-automation-id*="formField"], [data-automation-id*="dateInput"]');
        }
        return false;
      });
      if (inOrNear.length) {
        controls = inOrNear;
        break;
      }
    }

    if (!controls.length) {
      let node = labelEl;
      for (let hops = 0; hops < 8 && node && !controls.length; hops++) {
        node = node.nextElementSibling || node.previousElementSibling || node.parentElement?.nextElementSibling;
        if (!node) break;
        controls = collectControls(node);
      }
    }

    if (!controls.length) return { found: false, required: labelRequired(labelEl, []), count: 0, reason: 'no date spins near label' };

    let monthEl = controls.find((el) => classify(el) === 'month');
    let yearEl = controls.find((el) => classify(el) === 'year');
    let dayEl = controls.find((el) => classify(el) === 'day');
    if (!monthEl && !yearEl) {
      if (controls.length >= 3) {
        monthEl = controls[0];
        dayEl = controls[1];
        yearEl = controls[2];
      } else if (controls.length >= 2) {
        monthEl = controls[0];
        yearEl = controls[1];
      } else {
        yearEl = controls[0];
      }
    }
    if (!yearEl && controls.length === 1) yearEl = controls[0];
    if (!monthEl && controls.length >= 2) monthEl = controls[0];
    if (!yearEl && controls.length >= 2) yearEl = controls[controls.length - 1];

    const root = monthEl?.closest('[data-automation-id*="dateInputWrapper"], [data-automation-id*="formField"], [role="group"]')
      || yearEl?.closest('[data-automation-id*="dateInputWrapper"], [data-automation-id*="formField"], [role="group"]')
      || labelEl.closest('[data-automation-id*="formField"]')
      || labelEl.parentElement;
    if (root) root.setAttribute('data-wd-date-root', '1');
    if (monthEl) monthEl.setAttribute('data-wd-date-month', '1');
    if (yearEl) yearEl.setAttribute('data-wd-date-year', '1');
    if (dayEl) dayEl.setAttribute('data-wd-date-day', '1');

    return {
      found: Boolean(monthEl || yearEl),
      required: labelRequired(labelEl, controls),
      count: controls.length,
      hasMonth: Boolean(monthEl),
      hasYear: Boolean(yearEl),
      hasDay: Boolean(dayEl),
    };
  }, {
    labelPattern: opts.labelPattern,
    sectionType: opts.sectionType || null,
    dateSel: DATE_INPUT_SELECTOR,
    optionalRe: 'certificat|licen[cs]e|language|award|publication|web\\s*site|skill',
  }).catch(() => ({ found: false, required: false, count: 0, reason: 'evaluate failed' }));
}

async function readMarkedDate(page) {
  return await page.evaluate(() => {
    const junk = /^(m+|y+|d+|mm|yyyy|yy|dd|empty|select)$/i;
    const spinVal = (el) => {
      if (!el) return '';
      const raw = (el.value || el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw || junk.test(raw)) return '';
      return raw;
    };
    const month = spinVal(document.querySelector('[data-wd-date-month]'));
    const year = spinVal(document.querySelector('[data-wd-date-year]'));
    const day = spinVal(document.querySelector('[data-wd-date-day]'));
    const root = document.querySelector('[data-wd-date-root]');
    const shown = (root?.textContent || '').replace(/\s+/g, ' ').trim();
    if (month && year && !junk.test(month) && !junk.test(year)) {
      return { month, year, day, text: `${month}/${year}` };
    }
    if (year && /^\d{4}$/.test(year) && !month) return { month, year, day, text: year };
    const m = shown.match(/\b(\d{1,2})\s*[/\-.]\s*(\d{4})\b/);
    if (m) return { month: m[1], year: m[2], day, text: `${m[1]}/${m[2]}` };
    return { month, year, day, text: '' };
  }).catch(() => ({ month: '', year: '', day: '', text: '' }));
}

async function readSpinLocator(locator) {
  if (!(await locator.count())) return '';
  return await locator.evaluate((el) => {
    const junk = /^(m+|y+|d+|mm|yyyy|yy|dd|empty|select)$/i;
    const raw = (el.value || el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return !raw || junk.test(raw) ? '' : raw;
  }).catch(() => '');
}

function numbersEqual(actual, expected) {
  const a = String(actual || '').replace(/\D/g, '');
  const e = String(expected || '').replace(/\D/g, '');
  if (!a || !e) return false;
  return Number(a) === Number(e);
}

/**
 * Type one month or year segment into its own spin/display. Never dump MMYYYY together.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 * @param {string} digits
 */
async function typeSegment(page, locator, digits) {
  if (!(await locator.count())) return false;
  const wanted = String(digits);
  const variants = [wanted];
  if (wanted.startsWith('0') && wanted.length === 2) variants.push(String(Number(wanted)));

  await locator.scrollIntoViewIfNeeded().catch(() => {});

  for (const variant of variants) {
    await locator.click({ force: true }).catch(() => {});
    await page.waitForTimeout(70);
    await locator.press('Control+A').catch(() => {});
    await locator.press('Delete').catch(() => {});
    await locator.press('Backspace').catch(() => {});
    for (const ch of variant) {
      await locator.press(ch).catch(() => {});
      await page.waitForTimeout(35);
    }
    if (numbersEqual(await readSpinLocator(locator), wanted)) return true;

    await locator.click({ force: true }).catch(() => {});
    await locator.press('Control+A').catch(() => {});
    await locator.pressSequentially(variant, { delay: 50 }).catch(() => {});
    if (numbersEqual(await readSpinLocator(locator), wanted)) return true;
  }

  await locator.fill(wanted).catch(() => {});
  if (numbersEqual(await readSpinLocator(locator), wanted)) return true;

  await locator.evaluate((el, v) => {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc?.set?.call(el, v);
    try { el.value = v; } catch { /* display div */ }
    try { el.setAttribute('aria-valuenow', String(Number(v) || v)); } catch { /* ignore */ }
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') el.textContent = v;
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: v, inputType: 'insertText' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: v, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, wanted).catch(() => {});
  return numbersEqual(await readSpinLocator(locator), wanted);
}

/**
 * Fill one Workday From/To date. Types month, then year, as separate spin segments.
 * @param {import('playwright').Page} page
 * @param {{labelPattern: string, sectionType: string, value: string, mode?: 'monthyear'|'year', requiredOnly?: boolean}} opts
 * @returns {Promise<{ok: boolean, skippedOptional?: boolean, attempts: string[], after?: string}>}
 */
export async function fillWorkdayDateField(page, opts) {
  const attempts = [];
  const mode = opts.mode || 'monthyear';
  const parsed = parseDateFillValue(opts.value, mode);
  if (!parsed) return { ok: false, attempts: [`invalid date: ${opts.value}`] };

  let marked = await markDateWidget(page, {
    labelPattern: opts.labelPattern,
    sectionType: opts.sectionType,
  });
  if (!marked?.found) {
    await page.locator('[data-automation-id*="dateInputWrapper"], [data-automation-id*="dateSectionMonth"]').first()
      .click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    marked = await markDateWidget(page, {
      labelPattern: opts.labelPattern,
      sectionType: opts.sectionType,
    });
  }
  if (!marked?.found) {
    attempts.push(marked?.reason || 'date widget not found');
    return { ok: false, attempts };
  }

  if (opts.requiredOnly && !marked.required) {
    return { ok: true, skippedOptional: true, attempts: ['optional (no *) — skipped'] };
  }

  const monthLoc = page.locator('[data-wd-date-month]').first();
  const yearLoc = page.locator('[data-wd-date-year]').first();
  const dayLoc = page.locator('[data-wd-date-day]').first();
  const hasMonth = (await monthLoc.count()) > 0;
  const hasYear = (await yearLoc.count()) > 0;
  const hasDay = (await dayLoc.count()) > 0;

  const before = await readMarkedDate(page);
  if (strictDateMatch(before, parsed, { requireMonth: hasMonth })) {
    return { ok: true, attempts: [`already ${before.text || parsed.padded}`], after: before.text || parsed.padded };
  }

  // Activate the widget (lazy spins / display divs) by clicking the month or wrapper.
  const start = hasMonth ? monthLoc : yearLoc;
  await start.scrollIntoViewIfNeeded().catch(() => {});
  await start.click({ force: true }).catch(() => {});
  await page.waitForTimeout(80);

  const needMonth = hasMonth;
  let monthOk = !needMonth;
  let yearOk = false;

  if (hasMonth) {
    monthOk = await typeSegment(page, monthLoc, parsed.month);
    attempts.push(`month ${parsed.month} ${monthOk ? '✓' : '✗'}`);
  }
  if (hasDay) {
    const dayOk = await typeSegment(page, dayLoc, '01');
    attempts.push(`day 01 ${dayOk ? '✓' : '✗'}`);
  }
  if (hasYear) {
    yearOk = await typeSegment(page, yearLoc, parsed.year);
    attempts.push(`year ${parsed.year} ${yearOk ? '✓' : '✗'}`);
  } else if (hasMonth && mode === 'year') {
    yearOk = await typeSegment(page, monthLoc, parsed.year);
    attempts.push(`year-as-single ${parsed.year} ${yearOk ? '✓' : '✗'}`);
  }

  // Year edit can clear month — write month again, then year again if needed.
  if (hasMonth && !numbersEqual(await readSpinLocator(monthLoc), parsed.month)) {
    monthOk = await typeSegment(page, monthLoc, parsed.month);
    attempts.push(`month rewrite ${parsed.month} ${monthOk ? '✓' : '✗'}`);
  }
  if (hasYear && !numbersEqual(await readSpinLocator(yearLoc), parsed.year)) {
    yearOk = await typeSegment(page, yearLoc, parsed.year);
    attempts.push(`year rewrite ${parsed.year} ${yearOk ? '✓' : '✗'}`);
  }

  await yearLoc.press('Enter').catch(() => {});
  await page.waitForTimeout(100);

  let after = await readMarkedDate(page);
  if (strictDateMatch(after, parsed, { requireMonth: needMonth })) {
    attempts.push(`RESULT ${after.text || parsed.padded}`);
    return { ok: true, attempts, after: after.text || parsed.padded };
  }
  if (monthOk && yearOk) {
    const text = needMonth ? parsed.padded : parsed.year;
    attempts.push(`segments verified ${text}`);
    return { ok: true, attempts, after: text };
  }

  attempts.push(`after "${after.text || '(empty)'}" wanted ${needMonth ? parsed.padded : parsed.year}`);
  return { ok: false, attempts, after: after.text || '' };
}

export { dateHintFromEl };
