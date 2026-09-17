/**
 * workdayDom.mjs — DOM / accessibility field discovery for Workday forms
 *
 * Primary sources: Playwright DOM + accessibility tree + data-automation-id.
 * Vision is not used here.
 */

import { discoverFields } from './scanner.mjs';
import { normalizeLabel } from './qaStore.mjs';

const FORM_ROOT_SELECTOR = '[data-automation-id="formContent"], form, main, [role="main"], body';

/** Build a safe regex pattern from label text (truncate before escape to avoid trailing \\). */
function labelToRegexPattern(label, maxLen = 120) {
  const trimmed = String(label || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
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
/** Dropdown/combobox shows a real selection (not "Select one"). */
export function isDropdownAnsweredInDom(currentValue) {
  const v = String(currentValue || '').replace(/\s+/g, ' ').trim();
  if (!v || /^select(\s+one)?\.?$/i.test(v) || /^0\s+items?\s+selected$/i.test(v)) return false;
  if (/^[1-9]\d*\s+items?\s+selected$/i.test(v)) return true;
  if (/^yes$/i.test(v) || /^no$/i.test(v)) return true;
  return v.length > 0 && v.length < 120;
}

/**
 * True when live DOM already has an acceptable answer — skip fill (no expected-value re-match).
 */
export function isDiscoveredFieldFilled(field = {}, questionLabel = '') {
  const label = questionLabel || field.questionLabel || field.label || '';
  const live = field.currentValue ?? field.value ?? '';
  const ft = field.fieldType || field.type || '';

  if (ft === 'checkbox-group') {
    const checked = (field.options || []).filter((opt) => opt.checked).map((opt) => opt.text);
    if (checked.length > 0) return true;
    const picks = String(live).split(',').map((part) => part.trim()).filter(Boolean);
    return picks.length > 0 && isFormFieldValueFilled(live, label);
  }
  if (ft === 'dropdown' || ft === 'select' || ft === 'combobox' || ft === 'typeahead') {
    return isDropdownAnsweredInDom(live);
  }
  if (ft === 'checkbox' || ft === 'radio') {
    if (field.checked === true) return true;
    return isFormFieldValueFilled(live, label);
  }
  return isFormFieldValueFilled(live, label);
}

export function isFormFieldValueFilled(current, label = '') {
  const s = String(current || '').trim();
  if (!s) return false;
  if (/^select(\s+one)?\.?$/i.test(s)) return false;
  if (/^please\s+select/i.test(s)) return false;
  if (/^mm\/dd\/yyyy$/i.test(s)) return false;
  if (/^no items selected$/i.test(s)) return false;
  const essay = /briefly describe|please describe|describe your|tell us about|why are you looking|explain your|level of expertise|if so,?\s*briefly|which of the following/i.test(label);
  if (s.length > 100 && !essay) return false;
  const normCur = normalizeLabel(s);
  const normLabel = normalizeLabel(label);
  if (normLabel && normCur === normLabel) return false;
  if (normLabel && normLabel.length > 20 && normCur.includes(normLabel.slice(0, 30))) return false;
  if (/\?/.test(s) && s.length > 40) return false;
  if (/select all that apply/i.test(label)) {
    const picks = s.split(',').map((part) => part.trim()).filter(Boolean);
    return picks.length > 0 && !picks.some((part) => /select all that apply|\?$/.test(part));
  }
  if (/^(what|how|which|please|are you|do you|have you)\b/i.test(s) && normLabel && normCur.includes(normLabel.slice(0, 24))) {
    return false;
  }
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

    function fieldTypeToCode(fieldType) {
      const t = String(fieldType || '').toLowerCase();
      if (/checkbox-group|multi/.test(t)) return 5;
      if (/^checkbox$/.test(t)) return 4;
      if (/radio/.test(t)) return 3;
      if (/dropdown|select|combobox|typeahead/.test(t)) return 2;
      return 1;
    }

    /** Persist markers across rescans — random ids caused orchestrator duplicate-fill loops. */
    function ensureMarkerId(el, label, disambiguator = '') {
      if (!el) return '';
      const existing = el.getAttribute('data-wd-q-id');
      if (existing) return existing;
      const base = norm(label).slice(0, 36).replace(/\s+/g, '-') || 'field';
      let markerId = `wdq-${base}${disambiguator ? `-${disambiguator}` : ''}`.replace(/[^a-z0-9_-]/gi, '') || 'wdq-field';
      let n = 0;
      while (document.querySelector(`[data-wd-q-id="${CSS.escape(markerId)}"]`) && n < 24) {
        n += 1;
        markerId = `wdq-${base}-${n}`.replace(/[^a-z0-9_-]/gi, '');
      }
      el.setAttribute('data-wd-q-id', markerId);
      return markerId;
    }

    function readValueFromWidget(widget) {
      if (!widget) return '';
      const selected = widget.querySelector('[data-automation-id="selectedItem"]');
      if (selected?.textContent?.trim()) {
        const t = selected.textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const btn = widget.querySelector(
        'button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, button'
      );
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
      }
      const combo = widget.querySelector('[role="combobox"]');
      if (combo) {
        const t = (combo.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 80 && !/^select/i.test(t) && !/\?$/.test(t)) return t;
      }
      return '';
    }

    function extractQuestionFromText(raw) {
      const text = (raw || '').replace(/\s+/g, ' ').trim().replace(/\*+$/, '');
      const questions = [...text.matchAll(/([^.!?]{8,500}\?)/g)].map((m) => m[1].trim());
      if (questions.length) {
        const preferred = questions.find((q) => /are you|have you|do you|will you|years old|age of|please select|please indicate/i.test(q));
        return preferred || questions[questions.length - 1];
      }
      const ageish = text.match(/((?:are you|must be|at least|over the age).{0,80}(?:1[68]).{0,40})/i);
      if (ageish) return ageish[1].trim();
      return text;
    }

    /** Short labels that are still valid Workday questions (not noise). */
    function isValidShortLabel(label) {
      return /^(race|ethnicity|gender|sex|hispanic|veteran(\s*status)?|name|date|language|city|state|country|phone|email|from|to|degree|school|major|gpa|title|company|source|address)$/i.test(
        String(label || '').replace(/\*+/g, '').trim()
      );
    }

    function isShortEeoLabel(label) {
      return isValidShortLabel(label);
    }

    function cleanLabelText(raw) {
      return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/\*+/g, ' ')
        .replace(/\s*\(required\)\s*/gi, ' ')
        .replace(/^\s*(please\s+select|select\s+one|choose)\s+/i, '')
        .replace(/\s+select(\s+one)?(\s+required)?\s*$/i, '')
        .replace(/\s+required\s*$/i, '')
        .trim();
    }

    function resolveAriaLabelledBy(el) {
      const ids = String(el?.getAttribute?.('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return '';
      return ids
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /**
     * Collect every possible label/text signal for a control or formField root.
     * Prefer short explicit labels; fall back to nearby richText / aria / sibling text.
     */
    function collectLabelCandidates(root, control = null) {
      const out = [];
      const push = (raw, source) => {
        const cleaned = cleanLabelText(raw);
        if (!cleaned) return;
        if (/indicates a required field|application questions \d+ of|save and continue|drop files here/i.test(cleaned)) return;
        if (/^dateSection|dateSection(Month|Year|Day)/i.test(cleaned)) return;
        out.push({ text: cleaned, source });
      };

      if (root) {
        const labelEl =
          root.querySelector('[data-automation-id*="richText"]')
          || root.querySelector('label')
          || root.querySelector('legend')
          || root.querySelector('[data-automation-id*="label"]')
          || root.querySelector('[data-automation-id*="formLabel"]');
        if (labelEl) push(labelEl.textContent, 'formField_label');
      }

      if (control) {
        push(control.getAttribute('aria-label'), 'aria-label');
        push(resolveAriaLabelledBy(control), 'aria-labelledby');
        push(control.getAttribute('placeholder'), 'placeholder');
        push(control.getAttribute('name'), 'name');
        push(control.getAttribute('data-automation-id'), 'automation-id');
        const title = control.getAttribute('title');
        push(title, 'title');
      }

      // Preceding sibling / heading text (common when label is outside formField)
      let cursor = control || root;
      for (let hops = 0; hops < 4 && cursor; hops++) {
        let sib = cursor.previousElementSibling;
        while (sib) {
          const t = cleanLabelText(sib.textContent);
          if (t && t.length >= 2 && t.length < 900 && !sib.querySelector('input,select,textarea,button[aria-haspopup]')) {
            push(t, 'prev_sibling');
            break;
          }
          sib = sib.previousElementSibling;
        }
        cursor = cursor.parentElement;
      }

      return out;
    }

    function pickBestLabel(candidates, { allowShort = true } = {}) {
      if (!candidates?.length) return '';
      // Prefer real questions (even long Voluntary/legal blobs) over widget chrome
      const scored = candidates.map((c) => {
        const t = extractQuestionFromText(c.text);
        let score = 0;
        if (/\?/.test(t)) score += 50;
        if (/are you|have you|do you|will you|years old|age of|please select|please indicate/i.test(t)) score += 25;
        if (t.length >= 14 && t.length <= 400) score += 30;
        if (t.length > 400 && /\?/.test(t)) score += 20;
        if (t.length >= 8 && t.length < 14) score += 15;
        if (allowShort && isValidShortLabel(t)) score += 25;
        if (/^(race|gender|hispanic|veteran|name|date|language|city|state)$/i.test(t)) score += 20;
        if (c.source === 'formField_label' || c.source === 'aria-label') score += 10;
        if (c.source === 'automation-id' || c.source === 'name' || c.source === 'placeholder') score -= 25;
        if (/dateSection|beecatcher|honeypot|website$/i.test(t)) score -= 100;
        return { text: t, score, source: c.source };
      }).filter((c) => c.text && !/dateSection/i.test(c.text) && (c.text.length >= 8 || isValidShortLabel(c.text)));
      scored.sort((a, b) => b.score - a.score);
      return scored[0]?.text || '';
    }

    function labelForSelectWidget(widget) {
      const fieldRoot = widget.closest('[data-automation-id*="formField"]')
        || widget.closest('[data-automation-id*="question"]')
        || widget.closest('[role="group"]');
      const candidates = collectLabelCandidates(fieldRoot, widget);
      const best = pickBestLabel(candidates);
      if (best) return best;

      // Legacy proximity scan over nearby richText / labels
      const richTexts = Array.from(document.querySelectorAll(
        '[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]'
      ));
      let nearest = '';
      let bestDist = Infinity;
      const wrect = widget.getBoundingClientRect();
      for (const el of richTexts) {
        const label = extractQuestionFromText(el.textContent || '');
        if (!label || (label.length < 8 && !isValidShortLabel(label))) continue;
        if (/indicates a required field|application questions \d+ of/i.test(label)) continue;
        if (!(el.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const rect = el.getBoundingClientRect();
        const dist = wrect.top - rect.bottom;
        if (dist >= -40 && dist < bestDist) {
          bestDist = dist;
          nearest = label;
        }
      }
      return nearest;
    }

    function dropdownTriggerSelector() {
      return 'button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id="selectOne"] button, [data-automation-id="selectWidget"] button, [data-automation-id*="select"] button';
    }

    function isDropdownFormField(field) {
      return Boolean(field?.querySelector?.(dropdownTriggerSelector()));
    }

    function formFieldIndexFor(field) {
      const fields = Array.from(document.querySelectorAll('[data-automation-id*="formField"]'))
        .filter((node) => isDropdownFormField(node));
      return fields.indexOf(field);
    }

    function selectOneIndexForWidget(widget) {
      const all = document.querySelectorAll('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]');
      return Array.from(all).indexOf(widget);
    }

    function readValue(field) {
      if (field?.matches?.('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]')) {
        return readValueFromWidget(field);
      }
      const selected = field.querySelector('[data-automation-id="selectedItem"]');
      if (selected?.textContent?.trim()) {
        const t = selected.textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }
      const btn = field.querySelector(
        '[data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, [data-automation-id*="select"] button, button[aria-haspopup="listbox"]'
      );
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t)) return t;
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
      const textInput = field.querySelector('input[type="text"]:not([type="hidden"]), input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea');
      const dateInput = field.querySelector('input[type="date"]');
      const spinButtons = field.querySelectorAll('input[role="spinbutton"]');
      if (spinButtons.length >= 3) {
        const values = Array.from(spinButtons).map((input) => input.value || '');
        if (values.some(Boolean) && !values.every((v) => /^m+$/i.test(v) || /^d+$/i.test(v) || /^y+$/i.test(v))) {
          return `${String(values[0]).padStart(2, '0')}/${String(values[1]).padStart(2, '0')}/${values[2] || ''}`;
        }
      }
      if (spinButtons.length === 1 && spinButtons[0].value) return spinButtons[0].value.trim();
      if (textInput?.value) return textInput.value.trim();
      if (dateInput?.value) return dateInput.value.trim();
      const checked = field.querySelector('input[type="radio"]:checked');
      if (checked) {
        const id = checked.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : checked.closest('label');
        if (lab?.textContent?.trim()) return lab.textContent.trim();
      }
      const checkedBoxes = [];
      field.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (!cb.checked) return;
        const id = cb.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : cb.closest('label');
        const text = (lab?.textContent || cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (text) checkedBoxes.push(text);
      });
      if (checkedBoxes.length > 0) return checkedBoxes.join(', ');
      return '';
    }

    const results = [];
    const seen = new Set();
    const pageContext = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const selfIdentifyContext = /self\s*identify|voluntary self-identification of disability|cc-305|omb control number/i.test(pageContext);
    const containers = document.querySelectorAll(
      '[data-automation-id*="formField"], [data-automation-id*="FormField"], [data-automation-id*="question"], [data-automation-id*="Question"], [data-automation-id*="secondaryQuestionnaire"], [data-automation-id*="Questionnaire"], fieldset[role="group"], [role="group"][data-automation-id]'
    );

    for (const field of containers) {
      // Multi-widget questionnaire panels: do not skip — child selectWidgets are
      // harvested in the selectOne fallback + full control walk below.
      if (field.matches?.('[data-automation-id*="secondaryQuestionnaire"]')) {
        const multiWidgets = field.querySelectorAll('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]');
        if (multiWidgets.length > 1) {
          // Still try to push each child widget via labelForSelectWidget later.
          continue;
        }
      }

      const candidates = collectLabelCandidates(field, field.querySelector('input, select, textarea, button[aria-haspopup="listbox"], [role="combobox"]'));
      const rawLabel = candidates[0]?.text
        || (field.querySelector('[data-automation-id*="richText"], label, legend, [data-automation-id*="label"]')?.textContent || '');
      const labelHadRequiredAsterisk = /\*/.test(String(rawLabel))
        || Boolean(field.querySelector('abbr[title*="required" i], [data-automation-id*="required"]'));
      let label = pickBestLabel(candidates) || cleanLabelText(rawLabel);
      const containerText = (field.textContent || '').replace(/\s+/g, ' ').trim();
      const shortLabel = label;
      const isShortEeo = isValidShortLabel(shortLabel);
      if (selfIdentifyContext && /^(name|date|language)$/i.test(shortLabel)) {
        label = shortLabel;
      } else if (!label || (label.length < 3 && !isShortEeo)) {
        continue;
      } else if (label.length < 8 && !isShortEeo) {
        // Keep short labels that look like real field names; drop noise.
        if (!/^[A-Za-z][A-Za-z0-9 /&-]{1,30}$/.test(label)) continue;
      }
      const questionMatch = label.match(/[^.?!]*\?/);
      if (questionMatch && questionMatch[0].length >= 12) {
        label = questionMatch[0].trim();
      } else if (/please\s+enter\s+your\s+name/i.test(label)) {
        label = 'Please enter your name:';
      } else if (/please\s+enter\s+today['’]?s\s+date/i.test(label)) {
        label = "Please enter today's date:";
      } else if (/sign\s+to\s+acknowledge|read.*sign.*acknowledge|please\s+read.*carefully.*sign/i.test(label)) {
        // Long legal acknowledgement paragraph — normalize to short signature-field label
        label = 'Please sign (type name) and enter the date:';
      }
      if (/indicates a required field|application questions \d+ of/i.test(label)) continue;
      if (/recruitment privacy statement.*vibe philosophy/i.test(label)) continue;
      if (/employee\s*id.*if applicable/i.test(label)) continue;

      const key = norm(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const combo = field.querySelector(
        'select, [role="combobox"], [data-automation-id="selectOne"], [data-automation-id="selectWidget"], button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button, [data-automation-id*="select"] button, [data-automation-id="select-one"]'
      );
      const radios = field.querySelectorAll('input[type="radio"]');
      const textInput = field.querySelector(
        'input[type="text"]:not([type="hidden"]), input[type="number"], input[type="tel"], input[type="email"], input:not([type]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
      );
      const dateInput = field.querySelector('input[type="date"]');
      const spinButtons = field.querySelectorAll('input[role="spinbutton"]');
      const checkboxes = field.querySelectorAll('input[type="checkbox"]');
      const checkbox = checkboxes[0] || null;
      const describeTextarea = Boolean(
        textInput
        && String(textInput.tagName || '').toUpperCase() === 'TEXTAREA'
        && /please describe|briefly describe|tell us about|why are you looking|which of the following/i.test(label)
      );
      const multiSelect = !describeTextarea && (
        checkboxes.length > 1 || (/select all that apply/i.test(label) && checkboxes.length > 0)
      );

      let fieldType = 'text';
      if (multiSelect) fieldType = 'checkbox-group';
      else if (checkbox && !combo && radios.length === 0 && !textInput && spinButtons.length === 0) fieldType = 'checkbox';
      else if (spinButtons.length >= 3 && !combo && radios.length === 0) fieldType = 'date';
      else if (combo) fieldType = 'dropdown';
      else if ((textInput || dateInput || spinButtons.length > 0) && radios.length === 0) {
        fieldType = dateInput ? 'date' : 'text';
      } else if (radios.length > 0 && !combo) fieldType = 'radio';
      else if (!combo && !textInput && radios.length === 0 && !checkbox && spinButtons.length === 0) continue;

      let currentValue = readValue(field);
      if (spinButtons.length >= 3) {
        const values = Array.from(spinButtons).map((input) => input.value || '');
        if (values.every(Boolean)) {
          currentValue = `${String(values[0]).padStart(2, '0')}/${String(values[1]).padStart(2, '0')}/${values[2]}`;
        }
      }
      const hasRequiredMarker = Boolean(
        field.querySelector('.required, .asterisk, [aria-required="true"], abbr[title*="required" i], [data-automation-id*="required"], [class*="required" i], [class*="asterisk" i], [class*="mandatory" i]')
        || field.getAttribute('aria-required') === 'true'
        || combo?.getAttribute('aria-required') === 'true'
        || textInput?.getAttribute('aria-required') === 'true'
        || textInput?.required
        || field.querySelector('[style*="color: rgb(19"], [style*="color: rgb(2"], [style*="color:red"], [style*="color: red"]')
      );
      const required = labelHadRequiredAsterisk
        || /\*/.test(containerText.slice(0, Math.max(containerText.indexOf(label) + label.length, label.length + 2)))
        || hasRequiredMarker;

      const checkboxOptions = Array.from(checkboxes).map((cb) => {
        const id = cb.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : cb.closest('label');
        return {
          text: (lab?.textContent || cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          checked: Boolean(cb.checked),
        };
      }).filter((option) => option.text);

      const selectWidget = field.querySelector('[data-automation-id="selectOne"], [data-automation-id="selectWidget"]');
      const selectOneIndex = selectWidget ? selectOneIndexForWidget(selectWidget) : null;
      const formFieldIndex = (fieldType === 'dropdown' || fieldType === 'select') ? formFieldIndexFor(field) : -1;
      const fieldTypeCode = fieldTypeToCode(fieldType);
      const selectIdx = selectOneIndex != null && selectOneIndex >= 0 ? selectOneIndex : -1;
      const markerDisambig = formFieldIndex >= 0
        ? String(formFieldIndex)
        : (selectIdx >= 0 ? `s${selectIdx}` : '');
      const markerId = ensureMarkerId(field, label, markerDisambig);

      results.push({
        label,
        fieldType,
        field_type_code: fieldTypeCode,
        fieldTypeCode,
        currentValue,
        required,
        hasRequiredMarker,
        placeholder: textInput?.getAttribute('placeholder') || dateInput?.getAttribute('placeholder') || '',
        inputType: dateInput ? 'date' : (textInput?.getAttribute('type') || (spinButtons.length ? 'number' : 'text')),
        containerText: (field.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        labelCandidates: candidates.map((c) => c.text).slice(0, 8),
        selectOneIndex: selectOneIndex >= 0 ? selectOneIndex : null,
        formFieldIndex: formFieldIndex >= 0 ? formFieldIndex : null,
        wdQId: markerId,
        options: fieldType === 'checkbox-group'
          ? checkboxOptions
          : Array.from(field.querySelectorAll('select option')).map((option) => ({
            text: (option.textContent || '').replace(/\s+/g, ' ').trim(),
            value: option.value,
          })).filter((option) => option.text && !/^select(\s+one)?$/i.test(option.text)),
      });
    }

    // Fallback: each Workday selectOne/selectWidget is often one question (State Street AQ, etc.)
    const selectWidgets = document.querySelectorAll(
      '[data-automation-id="selectOne"], [data-automation-id="selectWidget"]'
    );
    selectWidgets.forEach((widget, selectOneIndex) => {
      const label = labelForSelectWidget(widget);
      if (!label || (label.length < 3 && !isValidShortLabel(label))) return;
      if (label.length < 8 && !isValidShortLabel(label) && !/^[A-Za-z][A-Za-z0-9 /&-]{1,40}$/.test(label)) return;

      const key = norm(label);
      if (!key || seen.has(key)) return;
      seen.add(key);

      const fieldRoot = widget.closest('[data-automation-id*="formField"]')
        || widget.closest('[data-automation-id*="question"]')
        || widget.parentElement;
      const containerText = (fieldRoot?.textContent || widget.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const currentValue = readValueFromWidget(widget);
      const hasRequiredMarker = Boolean(
        fieldRoot?.querySelector('.required, .asterisk, [aria-required="true"], abbr[title*="required" i], [class*="required" i], [class*="asterisk" i]')
        || widget.querySelector('[aria-required="true"]')
        || fieldRoot?.querySelector('[style*="color: rgb(19"], [style*="color: rgb(2"], [style*="color:red"], [style*="color: red"]')
      );
      const labelHadRequiredAsterisk = /\*/.test(containerText)
        && containerText.includes(label)
        && /\*/.test(containerText.slice(
          Math.max(0, containerText.indexOf(label)),
          containerText.indexOf(label) + label.length + 4,
        ));
      const required = labelHadRequiredAsterisk
        || /\*/.test(containerText.slice(0, Math.max(0, containerText.indexOf(label)) + label.length + 4))
        || hasRequiredMarker
        || /race which most accurately|gender|hispanic/i.test(label);

      const markerId = ensureMarkerId(fieldRoot || widget, label, `s${selectOneIndex}`);

      results.push({
        label,
        fieldType: 'dropdown',
        field_type_code: 2,
        fieldTypeCode: 2,
        currentValue,
        required,
        hasRequiredMarker,
        placeholder: '',
        inputType: 'text',
        containerText,
        labelCandidates: collectLabelCandidates(fieldRoot, widget).map((c) => c.text).slice(0, 8),
        widgetId: widget.id || widget.getAttribute('data-automation-id') || '',
        selectOneIndex,
        wdQId: markerId,
        options: [],
      });
    });

    // Full control walk — catch every interactive element the formField pass missed
    const controlNodes = document.querySelectorAll([
      'input:not([type="hidden"]):not([data-automation-id="beecatcher"])',
      'textarea',
      'select',
      '[role="combobox"]',
      'button[aria-haspopup="listbox"]',
      '[data-automation-id="selectOne"]',
      '[data-automation-id="selectWidget"]',
      'input[type="radio"]',
      'input[type="checkbox"]',
    ].join(','));

    for (const control of controlNodes) {
      if (control.closest('[data-automation-id="beecatcher"]')) continue;
      if (control.getAttribute('type') === 'file') continue;
      if (control.getAttribute('name') === 'website') continue;

      // Skip radios/checkboxes already represented by a parent field — use group root
      const groupRoot = control.closest('[data-automation-id*="formField"], [data-automation-id*="question"], fieldset, [role="group"]')
        || control;
      if (groupRoot.getAttribute('data-wd-q-id') && groupRoot !== control) continue;
      if (control.getAttribute('data-wd-q-id')) continue;

      const candidates = collectLabelCandidates(groupRoot, control);
      const label = pickBestLabel(candidates);
      if (!label) continue;
      if (label.length < 3) continue;
      if (label.length < 8 && !isValidShortLabel(label) && !/^[A-Za-z][A-Za-z0-9 /&-]{1,40}$/.test(label)) continue;

      const typeAttr = (control.getAttribute('type') || '').toLowerCase();
      // Radio/checkbox option text is not a question — skip bare Yes/No leaves
      if ((typeAttr === 'radio' || typeAttr === 'checkbox') && /^(yes|no|male|female|n\/a|prefer not to answer)$/i.test(label)) {
        continue;
      }

      const key = norm(label);
      if (!key || seen.has(key)) continue;

      let fieldType = 'text';
      const tag = (control.tagName || '').toLowerCase();
      if (tag === 'select' || control.getAttribute('role') === 'combobox' || control.getAttribute('aria-haspopup') === 'listbox'
        || control.matches?.('[data-automation-id="selectOne"], [data-automation-id="selectWidget"], button[aria-haspopup="listbox"]')) {
        fieldType = 'dropdown';
      } else if (typeAttr === 'radio') fieldType = 'radio';
      else if (typeAttr === 'checkbox') {
        const cbs = groupRoot.querySelectorAll('input[type="checkbox"]');
        fieldType = cbs.length > 1 ? 'checkbox-group' : 'checkbox';
      } else if (typeAttr === 'date' || control.getAttribute('role') === 'spinbutton') fieldType = 'date';

      const required = Boolean(
        control.getAttribute('aria-required') === 'true'
        || control.required
        || /\*/.test(groupRoot.textContent || '')
        || groupRoot.querySelector('[aria-required="true"], abbr[title*="required" i]')
      );

      seen.add(key);
      const markerId = ensureMarkerId(groupRoot, label, typeAttr || tag || 'ctrl');

      const walkCheckboxOptions = fieldType === 'checkbox-group'
        ? Array.from(groupRoot.querySelectorAll('input[type="checkbox"]')).map((cb) => {
          const id = cb.id;
          const lab = id ? groupRoot.querySelector(`label[for="${CSS.escape(id)}"]`) : cb.closest('label');
          return {
            text: (lab?.textContent || cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
            checked: Boolean(cb.checked),
          };
        }).filter((o) => o.text)
        : [];

      results.push({
        label,
        fieldType,
        field_type_code: fieldTypeToCode(fieldType),
        fieldTypeCode: fieldTypeToCode(fieldType),
        currentValue: readValue(groupRoot) || (control.value || '').trim(),
        required,
        hasRequiredMarker: required,
        placeholder: control.getAttribute('placeholder') || '',
        inputType: typeAttr || tag,
        containerText: (groupRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        labelCandidates: candidates.map((c) => c.text).slice(0, 8),
        elementText: cleanLabelText(control.textContent || control.getAttribute('aria-label') || ''),
        wdQId: markerId,
        options: walkCheckboxOptions,
        source: 'full_control_walk',
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
          field_type_code: 3,
          fieldTypeCode: 3,
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
  const domFields = await discoverFields(page, FORM_ROOT_SELECTOR).catch(() => []);
  const a11yFields = await parseStepFromA11y(page).catch(() => []);
  const formQuestions = await discoverFormFieldQuestions(page).catch(() => []);

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
 * Collect live option labels for a Workday formField (dropdown, radio, checkbox-group).
 * Opens dropdowns briefly when needed, then closes with Escape.
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {string} [fieldType]
 * @returns {Promise<string[]>}
 */
export async function collectLiveFieldOptions(page, label, fieldType = 'dropdown') {
  const labelPattern = labelToRegexPattern(label, 120);
  if (!labelPattern) return [];

  const staticOptions = await page.evaluate(({ pattern }) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    let labelRe;
    try {
      labelRe = new RegExp(pattern, 'i');
    } catch {
      return [];
    }
    const out = [];
    const seen = new Set();

    const add = (text) => {
      const t = norm(text);
      if (!t || t.length > 140 || /^select(\s+one)?$/i.test(t)) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };

    const fields = document.querySelectorAll('[data-automation-id*="formField"], fieldset[role="group"]');
    for (const field of fields) {
      const blob = norm(field.textContent);
      if (!labelRe.test(blob)) continue;

      field.querySelectorAll('select option').forEach((opt) => add(opt.textContent));
      field.querySelectorAll('input[type="radio"]').forEach((radio) => {
        const id = radio.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : radio.closest('label');
        add(lab?.textContent || radio.getAttribute('aria-label'));
      });
      field.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        const id = cb.id;
        const lab = id ? field.querySelector(`label[for="${CSS.escape(id)}"]`) : cb.closest('label');
        add(lab?.textContent || cb.getAttribute('aria-label'));
      });
      if (out.length > 0) break;
    }
    return out;
  }, { pattern: labelPattern }).catch(() => []);

  const type = String(fieldType || '').toLowerCase();
  const needsDropdownOpen = staticOptions.length === 0
    && (type.includes('dropdown') || type.includes('select') || type === 'dropdown');

  if (!needsDropdownOpen) return staticOptions;

  await page.keyboard.press('Escape').catch(() => {});
  const trigger = await locateWorkdayFieldByLabel(page, labelPattern);
  if (!trigger) return staticOptions;

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);

  const listOptions = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [role="treeitem"], [role="menuitem"]')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (!el.offsetParent && el.getClientRects().length === 0) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 140 || /^select(\s+one)?$/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }).catch(() => []);

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return listOptions.length > 0 ? listOptions : staticOptions;
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
    let labelRe;
    try {
      labelRe = new RegExp(pattern, 'i');
    } catch {
      return null;
    }
    const excludeRes = exclude.map((e) => {
      try { return new RegExp(e, 'i'); } catch { return null; }
    }).filter(Boolean);
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
  const raw = String(profileValue || 'United States of America (+1)').trim();
  const withoutCode = raw.replace(/\s*\(\s*\+?\d+\s*\)\s*$/, '').replace(/\s*\+\d+\s*$/, '').trim();
  const searchTerm = (withoutCode || raw).toLowerCase();
  return {
    searchTerm: searchTerm.split(/\s+/)[0] || searchTerm,
    optionText: raw,
  };
}
