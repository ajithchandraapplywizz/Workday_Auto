/**
 * workdayDom.mjs — DOM / accessibility field discovery for Workday forms
 *
 * Primary sources: Playwright DOM + accessibility tree + data-automation-id.
 * Vision is not used here.
 */

import { discoverFields } from './scanner.mjs';
import { normalizeLabel } from './qaStore.mjs';

const FORM_ROOT_SELECTOR = '[data-automation-id="formContent"], form, main, [role="main"], body';
const A11Y_ROLES = new Set([
  'textbox', 'combobox', 'listbox', 'radio', 'radiogroup',
  'checkbox', 'searchbox', 'spinbutton', 'switch',
]);

/**
 * Walk Playwright accessibility snapshot into structured field objects.
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
export async function parseStepFromA11y(page) {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
  if (!snapshot) return [];

  const fields = [];

  function walk(node, inheritedName) {
    if (!node) return;
    const role = node.role || '';
    const name = (node.name || inheritedName || '').trim();

    if (A11Y_ROLES.has(role)) {
      const options = [];
      for (const child of node.children || []) {
        if (child.role === 'option' || child.role === 'radio' || child.role === 'menuitem' || child.role === 'treeitem') {
          if (child.name) options.push(child.name.trim());
        }
      }
      const type = (role === 'combobox' || role === 'listbox')
        ? 'select'
        : (role === 'textbox' || role === 'searchbox' || role === 'spinbutton')
          ? 'text'
          : role === 'radiogroup'
            ? 'radio'
            : role;

      fields.push({
        label: name,
        normalizedLabel: normalizeLabel(name),
        type,
        role,
        options,
        required: Boolean(node.required),
        currentValue: node.value ?? '',
        automationId: '',
        selector: '',
      });
    }

    for (const child of node.children || []) {
      walk(child, name || inheritedName);
    }
  }

  walk(snapshot);
  return fields;
}

function fieldKey(f) {
  if (f.automationId) return `aid:${f.automationId}`;
  const label = normalizeLabel(f.label);
  if (label) return `label:${label}`;
  if (f.id) return `id:${f.id}`;
  if (f.name) return `name:${f.name}`;
  if (f.role) return `role:${f.role}:${label || f.selector || ''}`;
  return `fallback:${f.selector || f.key || ''}`;
}

function collapseRadioGroups(fields) {
  const groups = new Map();
  const rest = [];
  for (const f of fields) {
    if (f.type === 'radio' && f.name) {
      const existing = groups.get(f.name);
      if (existing) {
        const opts = new Set([...(existing.options || []).map(o => (typeof o === 'string' ? o : o.text)), ...(f.options || []).map(o => (typeof o === 'string' ? o : o.text))].filter(Boolean));
        existing.options = [...opts];
        if (f.required) existing.required = true;
        continue;
      }
      groups.set(f.name, {
        ...f,
        type: 'radio',
        options: (f.options || []).map(o => (typeof o === 'string' ? o : o.text)).filter(Boolean),
      });
      continue;
    }
    rest.push(f);
  }
  return [...rest, ...groups.values()];
}

/**
 * Merge DOM scanner fields with accessibility fields.
 * Priority: data-automation-id > label > id/name > ARIA role.
 * @param {object[]} domFields
 * @param {object[]} a11yFields
 * @returns {object[]}
 */
export function mergeFieldSources(domFields = [], a11yFields = []) {
  const merged = [];
  const seen = new Set();

  for (const f of domFields) {
    const k = fieldKey(f);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push({
      ...f,
      normalizedLabel: f.normalizedLabel || normalizeLabel(f.label),
      currentValue: f.currentValue ?? f.value ?? '',
      options: f.options || [],
    });
  }

  for (const a of a11yFields) {
    const k = fieldKey(a);
    const existing = merged.find(m =>
      fieldKey(m) === k
      || (m.normalizedLabel && a.normalizedLabel && m.normalizedLabel === a.normalizedLabel)
      || (m.label && a.label && normalizeLabel(m.label) === normalizeLabel(a.label))
    );
    if (existing) {
      if ((!existing.options || existing.options.length === 0) && a.options?.length) {
        existing.options = a.options;
      }
      if (!existing.required && a.required) existing.required = true;
      if (!existing.label && a.label) {
        existing.label = a.label;
        existing.normalizedLabel = normalizeLabel(a.label);
      }
      if (existing.currentValue === '' && a.currentValue) existing.currentValue = a.currentValue;
      if (!existing.role && a.role) existing.role = a.role;
    } else if (a.label) {
      merged.push({
        ...a,
        normalizedLabel: a.normalizedLabel || normalizeLabel(a.label),
        automationId: a.automationId || '',
      });
      seen.add(k);
    }
  }

  return collapseRadioGroups(merged);
}

/**
 * Install a MutationObserver on the Workday form container (300ms debounce).
 * @param {import('playwright').Page} page
 */
export async function attachFormMutationObserver(page) {
  await page.evaluate((sel) => {
    if (window.__workdayObserver) {
      window.__workdayObserver.disconnect();
      window.__workdayObserver = null;
    }
    window.__workdayDomDirty = false;
    window.__workdayLastMutation = Date.now();
    let timer = null;
    const root = document.querySelector(sel.split(',')[0].trim())
      || document.querySelector('[data-automation-id="formContent"]')
      || document.querySelector('form')
      || document.querySelector('main')
      || document.body;
    const observer = new MutationObserver(() => {
      window.__workdayLastMutation = Date.now();
      window.__workdayDomDirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        window.__workdayDomDirty = false;
      }, 300);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    window.__workdayObserver = observer;
  }, FORM_ROOT_SELECTOR);
}

/**
 * Disconnect the form MutationObserver.
 * @param {import('playwright').Page} page
 */
export async function detachFormMutationObserver(page) {
  await page.evaluate(() => {
    if (window.__workdayObserver) {
      window.__workdayObserver.disconnect();
      window.__workdayObserver = null;
    }
  }).catch(() => {});
}

/**
 * Wait until the observer reports 300ms of quiet DOM activity.
 * @param {import('playwright').Page} page
 * @param {{ timeout?: number }} [opts]
 */
export async function waitForDomSettled(page, { timeout = 8000 } = {}) {
  try {
    await page.waitForFunction(() => {
      if (typeof window.__workdayLastMutation !== 'number') return true;
      return !window.__workdayDomDirty && (Date.now() - window.__workdayLastMutation) >= 300;
    }, { timeout });
  } catch {
    /* timeout is acceptable — continue with current DOM */
  }
}

/**
 * True when a formField already has a real answer (not placeholder / question text).
 * @param {string} current
 * @param {string} [label]
 */
export function isFormFieldValueFilled(current, label = '') {
  const s = String(current || '').trim();
  if (!s) return false;
  if (/^select(\s+one)?\.?$/i.test(s)) return false;
  if (/^please\s+select/i.test(s)) return false;
  if (/^mm\/dd\/yyyy$/i.test(s)) return false;
  if (s.length > 100) return false;
  const normCur = normalizeLabel(s);
  const normLabel = normalizeLabel(label);
  if (normLabel && normCur === normLabel) return false;
  if (normLabel && normLabel.length > 20 && normCur.includes(normLabel.slice(0, 30))) return false;
  if (/\?/.test(s) && s.length > 40) return false;
  return true;
}

/**
 * Pure-DOM discovery: Workday question widgets inside formField containers.
 * Works on Application Questions, Voluntary Disclosures, and any similar step.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ label: string, fieldType: string, currentValue: string, required: boolean }>>}
 */
export async function discoverFormFieldQuestions(page) {
  return await page.evaluate(() => {
    function norm(s) {
      return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    function readValue(field) {
      const selected = field.querySelector('[data-automation-id="selectedItem"]');
      if (selected?.textContent?.trim()) {
        const t = selected.textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const btn = field.querySelector(
        '[data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, button[aria-haspopup="listbox"]'
      );
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120) return t;
      }
      const nativeSelect = field.querySelector('select');
      if (nativeSelect?.selectedOptions?.[0]?.textContent?.trim()) {
        const t = nativeSelect.selectedOptions[0].textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const combo = field.querySelector('[role="combobox"]');
      if (combo) {
        const t = (combo.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 80 && !/^select/i.test(t) && !/\?$/.test(t)) return t;
      }
      const textInput = field.querySelector('input[type="text"]:not([type="hidden"]), textarea');
      const dateInput = field.querySelector('input[type="date"]');
      const spinButtons = field.querySelectorAll('input[role="spinbutton"]');
      if (spinButtons.length >= 3) {
        const values = Array.from(spinButtons).map((input) => input.value || '');
        if (values.some(Boolean) && !values.every((v) => /^m+$/i.test(v) || /^d+$/i.test(v) || /^y+$/i.test(v))) {
          return `${String(values[0]).padStart(2, '0')}/${String(values[1]).padStart(2, '0')}/${values[2] || ''}`;
        }
      }
      if (textInput?.value) return textInput.value.trim();
      if (dateInput?.value) return dateInput.value.trim();
      const checked = field.querySelector('input[type="radio"]:checked');
      if (checked) {
        const id = checked.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : checked.closest('label');
        if (lab?.textContent?.trim()) return lab.textContent.trim();
      }
      return '';
    }

    const results = [];
    const seen = new Set();
    const pageContext = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const selfIdentifyContext = /self\s*identify|voluntary self-identification of disability|cc-305|omb control number/i.test(pageContext);
    const containers = document.querySelectorAll(
      '[data-automation-id*="formField"], [data-automation-id*="question"], fieldset[role="group"]'
    );

    for (const field of containers) {
      const labelEl =
        field.querySelector('[data-automation-id*="richText"]')
        || field.querySelector('label')
        || field.querySelector('legend')
        || field.querySelector('[data-automation-id*="label"]');
      let label = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const containerText = (field.textContent || '').replace(/\s+/g, ' ').trim();
      const shortLabel = label.replace(/\*+$/, '').trim();
      if (selfIdentifyContext && /^(name|date|language)$/i.test(shortLabel)) {
        label = shortLabel;
      } else if (!label || label.length < 8) {
        continue;
      }
      label = label.replace(/\*+$/, '').trim();
      const questionMatch = label.match(/[^.?!]*\?/);
      if (questionMatch && questionMatch[0].length >= 15) {
        label = questionMatch[0].trim();
      } else if (/please\s+enter\s+your\s+name/i.test(label)) {
        label = 'Please enter your name:';
      } else if (/please\s+enter\s+today['’]?s\s+date/i.test(label)) {
        label = "Please enter today's date:";
      }
      if (/indicates a required field|application questions \d+ of/i.test(label)) continue;
      if (/recruitment privacy statement.*vibe philosophy/i.test(label)) continue;
      if (/employee\s*id.*if applicable/i.test(label)) continue;

      const key = norm(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const combo = field.querySelector(
        'select, [role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button, [data-automation-id="select-one"]'
      );
      const radios = field.querySelectorAll('input[type="radio"]');
      const textInput = field.querySelector('input[type="text"]:not([type="hidden"]), textarea');
      const dateInput = field.querySelector('input[type="date"]');
      const spinButtons = field.querySelectorAll('input[role="spinbutton"]');
      const checkbox = field.querySelector('input[type="checkbox"]');

      let fieldType = 'dropdown';
      if (checkbox && !combo && radios.length === 0 && !textInput) fieldType = 'checkbox';
      else if (spinButtons.length >= 3 && !combo && radios.length === 0) fieldType = 'date';
      else if ((textInput || dateInput) && !combo && radios.length === 0) fieldType = dateInput ? 'date' : 'text';
      else if (radios.length > 0 && !combo) fieldType = 'radio';
      else if (!combo && !textInput && radios.length === 0 && !checkbox) continue;

      let currentValue = readValue(field);
      if (spinButtons.length >= 3) {
        const values = Array.from(spinButtons).map((input) => input.value || '');
        if (values.every(Boolean)) {
          currentValue = `${String(values[0]).padStart(2, '0')}/${String(values[1]).padStart(2, '0')}/${values[2]}`;
        }
      }
      const required = label.includes('*')
        || Boolean(field.querySelector('.required, .asterisk, [aria-required="true"]'))
        || field.getAttribute('aria-required') === 'true';

      results.push({
        label,
        fieldType,
        currentValue,
        required,
        placeholder: textInput?.getAttribute('placeholder') || dateInput?.getAttribute('placeholder') || '',
        inputType: dateInput ? 'date' : (textInput?.getAttribute('type') || 'text'),
        containerText: (field.textContent || '').replace(/\s+/g, ' ').trim(),
        options: Array.from(field.querySelectorAll('select option')).map((option) => ({
          text: (option.textContent || '').replace(/\s+/g, ' ').trim(),
          value: option.value,
        })).filter((option) => option.text && !/^select(\s+one)?$/i.test(option.text)),
      });
    }

    if (selfIdentifyContext && /please check one of the boxes below/i.test(pageContext)) {
      const disabilityKey = norm('please check one of the boxes below');
      if (!seen.has(disabilityKey)) {
        seen.add(disabilityKey);
        let currentValue = '';
        const disabilityRadios = Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => {
          const id = radio.id;
          const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : radio.closest('label');
          const text = (lab?.textContent || '').toLowerCase();
          return /disability|do not want to answer/i.test(text);
        });
        const checked = disabilityRadios.find((radio) => radio.checked);
        if (checked) {
          const id = checked.id;
          const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : checked.closest('label');
          currentValue = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
        }
        results.push({
          label: 'Please check one of the boxes below:',
          fieldType: 'radio',
          currentValue,
          required: true,
          containerText: pageContext.slice(0, 800),
          options: disabilityRadios.map((radio) => {
            const id = radio.id;
            const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : radio.closest('label');
            return { text: (lab?.textContent || '').replace(/\s+/g, ' ').trim(), value: radio.value };
          }).filter((option) => option.text),
        });
      }
    }

    return results;
  });
}

/** @deprecated Use discoverFormFieldQuestions */
export const discoverApplicationQuestionFields = discoverFormFieldQuestions;

/**
 * Discover Workday fields from DOM + accessibility tree + formField widgets.
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
export async function discoverWorkdayFields(page) {
  const [domFields, a11yFields, formQuestions] = await Promise.all([
    discoverFields(page, FORM_ROOT_SELECTOR).catch(() => []),
    parseStepFromA11y(page).catch(() => []),
    discoverFormFieldQuestions(page).catch(() => []),
  ]);

  const formAsFields = (formQuestions || []).map((q) => ({
    label: q.label,
    normalizedLabel: normalizeLabel(q.label),
    type: q.fieldType === 'dropdown' ? 'select' : q.fieldType,
    required: q.required,
    currentValue: q.currentValue,
    value: q.currentValue,
    source: 'formField',
    _formField: true,
    options: [],
  }));

  return mergeFieldSources(domFields || [], [...(a11yFields || []), ...formAsFields]);
}

function isEmptyValue(val) {
  if (val === undefined || val === null || val === false) return true;
  if (typeof val === 'boolean') return !val;
  const s = String(val).trim();
  if (!s) return true;
  if (/^select(\s+one)?\.?$/i.test(s)) return true;
  if (/^1 item selected$/i.test(s)) return false;
  return false;
}

/**
 * Check required fields against current DOM values.
 * @param {object[]} fields
 * @returns {{ ok: boolean, unresolved: object[] }}
 */
export function verifyRequiredFields(fields = [], profile = {}) {
  const filledKeys = Object.keys(profile._filledValues || {}).map(k => normalizeLabel(k));
  const unresolved = [];
  for (const f of fields) {
    if (f.disabled) continue;
    if (f.role === 'searchbox' || /search/i.test(f.label || '')) continue;
    if (!f.required && !(typeof f.label === 'string' && f.label.includes('*'))) continue;
    const nl = normalizeLabel(f.label || f.id || '');
    if (nl && filledKeys.some(k => k && (k === nl || nl.includes(k) || k.includes(nl)))) continue;
    const val = f.currentValue ?? f.value;
    if (typeof val === 'string' && /item selected|workday\.com|united states/i.test(val)) continue;
    if (isEmptyValue(val)) unresolved.push(f);
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * Re-check scanner "empty" required fields against live Workday DOM.
 * Workday labels often have a broken `for` attribute, so values live on
 * selectedItem / nested input rather than the scanned node.
 * @param {import('playwright').Page} page
 * @param {object[]} unresolved
 * @returns {Promise<object[]>}
 */
export async function filterTrulyEmptyRequired(page, unresolved = []) {
  const still = [];
  for (const f of unresolved) {
    const live = await page.evaluate(({ selector, label, automationId }) => {
      const clean = (label || '').replace(/\*+/g, '').trim();
      function readVal(root) {
        if (!root) return '';
        if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') return (root.value || '').trim();
        const selected = root.querySelector('[data-automation-id="selectedItem"]')
          || root.closest('[data-automation-id]')?.querySelector('[data-automation-id="selectedItem"]');
        if (selected && selected.textContent.trim()) return selected.textContent.trim();
        const input = root.querySelector('input:not([type="hidden"]):not([type="search"]), textarea');
        if (input && input.value) return input.value.trim();
        const combo = root.querySelector('[role="combobox"]');
        if (combo && (combo.innerText || '').trim() && !/^select/i.test(combo.innerText.trim())) {
          return combo.innerText.trim();
        }
        return (root.value || root.innerText || '').trim();
      }
      if (selector) {
        try {
          const el = document.querySelector(selector);
          const v = readVal(el);
          if (v && !/^select(\s+one)?$/i.test(v)) return v;
        } catch {}
      }
      if (automationId) {
        const el = document.querySelector(`[data-automation-id="${automationId}"]`);
        const v = readVal(el);
        if (v && !/^select(\s+one)?$/i.test(v)) return v;
      }
      const labels = Array.from(document.querySelectorAll('label, legend'));
      const lab = labels.find(l => clean && (l.textContent || '').replace(/\*+/g, '').includes(clean));
      if (lab) {
        const root = lab.closest('[data-automation-id*="formField"], [data-automation-id*="Field"], fieldset, div') || lab.parentElement;
        return readVal(root);
      }
      return '';
    }, { selector: f.selector || '', label: f.label || '', automationId: f.automationId || '' }).catch(() => '');

    if (!live || isEmptyValue(live)) still.push(f);
  }
  return still;
}

/**
 * Print unresolved required fields to the terminal.
 * @param {object[]} unresolved
 */
export function printUnresolvedFields(unresolved = []) {
  console.log('\n========================================');
  console.log('UNRESOLVED REQUIRED FIELDS');
  console.log('========================================');
  if (unresolved.length === 0) {
    console.log('(none)');
  } else {
    for (const f of unresolved) {
      console.log(`  • ${f.label || f.id || f.automationId || '(unnamed field)'}`);
    }
  }
  console.log('========================================\n');
}

/**
 * Parse Review page displayed values from the DOM.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ pairs: object[], bodyText: string }>}
 */
export async function parseReviewDOM(page) {
  return page.evaluate(() => {
    const pairs = [];

    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        pairs.push({ label: (dt.textContent || '').trim(), value: (dd.textContent || '').trim() });
      }
    });

    document.querySelectorAll('[data-automation-id*="formField"], [class*="formField"]').forEach(field => {
      const labelEl = field.querySelector('label, [data-automation-id*="label"], legend');
      if (!labelEl) return;
      const valueEl = field.querySelector(
        'input, textarea, select, [data-automation-id*="selectedItem"], [data-automation-id*="promptOption"], [data-automation-id*="value"]'
      );
      const label = (labelEl.textContent || '').trim();
      let value = '';
      if (valueEl) {
        value = (valueEl.value || valueEl.textContent || '').trim();
      }
      if (label) pairs.push({ label, value: value || (field.textContent || '').trim() });
    });

    document.querySelectorAll('[data-automation-id]').forEach(el => {
      const id = el.getAttribute('data-automation-id') || '';
      if (!/review|summary|display|selectedItem/i.test(id)) return;
      const text = (el.textContent || '').trim();
      if (text && text.length < 400) pairs.push({ automationId: id, text, value: text });
    });

    return { pairs, bodyText: document.body?.innerText || '' };
  });
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function reviewHaystack(review) {
  const pairText = (review.pairs || []).map(p => `${p.label || ''} ${p.value || ''} ${p.text || ''}`).join(' ');
  return `${review.bodyText || ''} ${pairText}`.toLowerCase();
}

function findDisplayed(review, fieldName) {
  const needle = fieldName.toLowerCase();
  const pair = (review.pairs || []).find(p =>
    (p.label || p.automationId || '').toLowerCase().includes(needle)
  );
  return pair?.value || pair?.text || '';
}

/**
 * Compare expected filled values against Review page text.
 * @param {Record<string, string>} expected
 * @param {{ pairs: object[], bodyText: string }} review
 * @returns {{ field: string, expected: string, displayed: string }[]}
 */
export function crossCheckReview(expected = {}, review = { pairs: [], bodyText: '' }) {
  const mismatches = [];
  const haystack = reviewHaystack(review);
  const haystackDigits = digitsOnly(haystack);

  for (const [field, expectedVal] of Object.entries(expected)) {
    if (expectedVal === undefined || expectedVal === null || String(expectedVal).trim() === '') continue;
    const needle = String(expectedVal).toLowerCase().trim();
    const digits = digitsOnly(needle);
    const foundText = haystack.includes(needle);
    const foundDigits = digits.length >= 7 && haystackDigits.includes(digits);
    if (foundText || foundDigits) continue;
    mismatches.push({
      field,
      expected: String(expectedVal),
      displayed: findDisplayed(review, field) || '(not found on Review page)',
    });
  }
  return mismatches;
}

/**
 * Locate a Workday form control by its visible label text (smallest matching formField).
 * Avoids grabbing the first combobox in a large parent that contains multiple fields.
 * @param {import('playwright').Page} page
 * @param {string|RegExp} labelPattern
 * @param {{ excludePatterns?: string[] }} [options]
 * @returns {Promise<import('playwright').Locator|null>}
 */
export async function locateWorkdayFieldByLabel(page, labelPattern, options = {}) {
  const pattern = typeof labelPattern === 'string' ? labelPattern : labelPattern.source;
  const exclude = options.excludePatterns || [];

  const selector = await page.evaluate(({ pattern, exclude }) => {
    const labelRe = new RegExp(pattern, 'i');
    const excludeRes = exclude.map((e) => new RegExp(e, 'i'));
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const candidates = [];
    const labelEls = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"]'));

    for (const labelEl of labelEls) {
      const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
      if (!labelText || !labelRe.test(labelText)) continue;
      if (excludeRes.some((re) => re.test(labelText))) continue;

      const formField = labelEl.closest('[data-automation-id*="formField"]')
        || labelEl.closest('fieldset')
        || labelEl.closest('[role="group"]')
        || labelEl.parentElement;
      if (!formField) continue;

      const trigger = formField.querySelector(
        'button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button, input[role="combobox"]'
      );
      if (!trigger) continue;

      const rect = formField.getBoundingClientRect();
      candidates.push({
        trigger,
        labelLen: labelText.length,
        area: Math.max(1, rect.width * rect.height),
      });
    }

    if (candidates.length === 0) return '';
    candidates.sort((a, b) => a.labelLen - b.labelLen || a.area - b.area);
    const trigger = candidates[0].trigger;
    if (trigger.id) return `#${CSS.escape(trigger.id)}`;
    const automation = trigger.getAttribute('data-automation-id');
    if (automation) return `[data-automation-id="${CSS.escape(automation)}"]`;
    const name = trigger.getAttribute('name');
    if (name) return `${trigger.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    return '';
  }, { pattern, exclude });

  return selector ? page.locator(selector).first() : null;
}

/**
 * Split a country phone-code profile value into search term + option matcher.
 * @param {string} profileValue
 * @returns {{ searchTerm: string, optionText: string }}
 */
export function parseCountryPhoneCode(profileValue) {
  const raw = String(profileValue || 'India (+91)').trim();
  const withoutCode = raw.replace(/\s*\(\s*\+?\d+\s*\)\s*$/, '').replace(/\s*\+\d+\s*$/, '').trim();
  const searchTerm = (withoutCode || raw).toLowerCase();
  return {
    searchTerm: searchTerm.split(/\s+/)[0] || searchTerm,
    optionText: raw,
  };
}
