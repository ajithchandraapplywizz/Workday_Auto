/**
 * workdayDom.mjs — Fast, role-based DOM detection & field discovery for Workday forms.
 *
 * Design principles:
 *  - NO page.accessibility.snapshot() — too slow for production.
 *  - Uses parallel Playwright locators: [data-automation-id], getByRole, and page.evaluate.
 *  - Returns a standard field object for every discovered Workday form element.
 *  - Preserves all existing utility exports consumed by downstream modules.
 */

import { normalizeLabel } from './qaStore.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const FORM_ROOT_SELECTOR =
  '[data-automation-id="formContent"], form, main, [role="main"], body';

/** Selectors for every Workday field type we need to detect. */
const FIELD_SELECTORS = {
  text: 'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], [role="textbox"]',
  dropdown:
    '[role="combobox"], [data-automation-id="selectWidget"], [data-automation-id="selectOne"], [aria-haspopup="listbox"]',
  radio: '[role="radio"], input[type="radio"]',
  checkbox: '[role="checkbox"], input[type="checkbox"]',
  spinbutton: '[role="spinbutton"]',
  file: 'input[type="file"]',
  textarea: 'textarea, [contenteditable="true"]',
  date: '[data-automation-id*="datePicker"], [data-automation-id*="dateSection"]',
  'tag-input':
    '[data-automation-id*="multiSelectWidget"], [data-automation-id*="multiSelect"]',
};

// ─── MutationObserver helpers (kept as-is — production-proven) ───────────────

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
    const root =
      document.querySelector(sel.split(',')[0].trim()) ||
      document.querySelector('[data-automation-id="formContent"]') ||
      document.querySelector('form') ||
      document.querySelector('main') ||
      document.body;
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
 * Wait until the observer reports 100ms of quiet DOM activity.
 * Fast, non-blocking: allows swift form filling without artificial lag.
 * @param {import('playwright').Page} page
 * @param {{ timeout?: number }} [opts]
 */
export async function waitForDomSettled(page, { timeout = 350 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        if (typeof window.__workdayLastMutation !== 'number') return true;
        return (
          !window.__workdayDomDirty &&
          Date.now() - window.__workdayLastMutation >= 100
        );
      },
      { timeout: Math.min(timeout, 800) },
    );
  } catch {
    /* timeout is acceptable — continue with current DOM */
  }
}

// ─── Value / required helpers (preserved for downstream consumers) ────────────

/**
 * True when a dropdown already has a real selection (not placeholder).
 * @param {string} currentValue
 */
export function isDropdownAnsweredInDom(currentValue) {
  const v = String(currentValue || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v || /^select(\s+one)?\.?$/i.test(v) || /^0\s+items?\s+selected$/i.test(v))
    return false;
  if (/^[1-9]\d*\s+items?\s+selected$/i.test(v)) return true;
  if (/^yes$/i.test(v) || /^no$/i.test(v)) return true;
  return v.length > 0 && v.length < 120;
}

/** @param {string} current */
export function isFormFieldValueFilled(current, label = '') {
  const s = String(current || '').trim();
  if (!s) return false;
  if (/^select(\s+one)?\.?$/i.test(s)) return false;
  if (/^please\s+select/i.test(s)) return false;
  if (/^mm\/dd\/yyyy$/i.test(s)) return false;
  if (/^no items selected$/i.test(s)) return false;
  const essay =
    /briefly describe|please describe|describe your|tell us about|why are you looking|explain your|level of expertise|if so,?\s*briefly|which of the following/i.test(
      label,
    );
  if (s.length > 100 && !essay) return false;
  const normCur = normalizeLabel(s);
  const normLabel = normalizeLabel(label);
  if (normLabel && normCur === normLabel) return false;
  if (normLabel && normLabel.length > 20 && normCur.includes(normLabel.slice(0, 30)))
    return false;
  if (/\?/.test(s) && s.length > 40) return false;
  if (/select all that apply/i.test(label)) {
    const picks = s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return picks.length > 0 && !picks.some((p) => /select all that apply|\?$/.test(p));
  }
  if (
    /^(what|how|which|please|are you|do you|have you)\b/i.test(s) &&
    normLabel &&
    normCur.includes(normLabel.slice(0, 24))
  ) {
    return false;
  }
  return true;
}

/**
 * True when live DOM already has an acceptable answer.
 * @param {object} field
 * @param {string} [questionLabel]
 */
export function isDiscoveredFieldFilled(field = {}, questionLabel = '') {
  const label = questionLabel || field.questionLabel || field.label || '';
  const live = field.currentValue ?? field.value ?? '';
  const ft = field.fieldType || field.type || '';

  if (ft === 'checkbox-group') {
    const checked = (field.options || [])
      .filter((opt) => opt.checked)
      .map((opt) => opt.text);
    if (checked.length > 0) return true;
    const picks = String(live)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
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

// ─── In-browser fast DOM scan ─────────────────────────────────────────────────

/**
 * Core in-browser scanner — runs entirely inside page.evaluate for speed.
 * Detects all Workday field types, deduplicates, and returns standard field objects.
 */
function buildInBrowserScanner() {
  /* NOTE: This function body is serialized and executed in the browser context via
     page.evaluate(). It must be fully self-contained (no closures over Node globals). */
  return () => {
    // ── Helpers ────────────────────────────────────────────────────────────────

    function norm(s) {
      return (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function cleanText(raw) {
      return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*\(required\)\s*/gi, ' ')
        .replace(/^\s*(please\s+select|select\s+one|choose)\s+/i, '')
        .replace(/\s+select(\s+one)?(\s+required)?\s*$/i, '')
        .replace(/\s+required\s*$/i, '')
        .trim();
    }

    function resolveAriaLabelledBy(el) {
      const ids = String(el?.getAttribute?.('aria-labelledby') || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!ids.length) return '';
      return ids
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isVisible(el) {
      if (!el) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')
        return false;
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
    }

    /** isRequired — checks all four Workday signals */
    function isRequired(el, container) {
      // 1. aria-required on element
      if (el?.getAttribute?.('aria-required') === 'true') return true;
      // 2. native required attribute
      if (el?.required) return true;
      // 3. * in label text
      const root = container || el?.closest('[data-automation-id*="formField"]');
      if (root) {
        const labelEl = root.querySelector(
          'label, legend, [data-automation-id*="richText"], [data-automation-id*="label"]',
        );
        if (labelEl && /\*/.test(labelEl.textContent || '')) return true;
        // 4. required class / marker in container
        if (
          root.querySelector(
            '.required, .asterisk, [class*="mandatory"], [data-automation-id*="required"], [aria-required="true"], abbr[title*="required" i]',
          )
        )
          return true;
        if (root.getAttribute('aria-required') === 'true') return true;
      }
      return false;
    }

    /** Collect the best label text for a form container or control element. */
    function getLabel(container, control) {
      // Priority: explicit formField label > aria-labelledby > aria-label > legend > preceding sibling
      if (container) {
        const labelEl =
          container.querySelector('[data-automation-id*="richText"]') ||
          container.querySelector('label') ||
          container.querySelector('legend') ||
          container.querySelector('[data-automation-id*="label"]') ||
          container.querySelector('[data-automation-id*="formLabel"]');
        if (labelEl) {
          const t = cleanText(labelEl.textContent);
          if (t && t.length >= 2) return t;
        }
      }
      if (control) {
        const byLabelledBy = resolveAriaLabelledBy(control);
        if (byLabelledBy) return cleanText(byLabelledBy);
        const ariaLabel = control.getAttribute('aria-label');
        if (ariaLabel) return cleanText(ariaLabel);
        const title = control.getAttribute('title');
        if (title && title.length > 2) return cleanText(title);
      }
      // Walk up: preceding sibling scan (max 4 hops)
      let cursor = control || container;
      for (let i = 0; i < 4 && cursor; i++) {
        let sib = cursor.previousElementSibling;
        while (sib) {
          const t = cleanText(sib.textContent);
          if (
            t &&
            t.length >= 3 &&
            t.length < 900 &&
            !sib.querySelector('input, select, textarea, button[aria-haspopup]')
          ) {
            return t;
          }
          sib = sib.previousElementSibling;
        }
        cursor = cursor?.parentElement;
      }
      return '';
    }

    /** Detect field type from a formField container or a raw control element. */
    function detectType(container, control) {
      // tag-input (multi-select widget)
      if (
        container?.querySelector(
          '[data-automation-id*="multiSelectWidget"], [data-automation-id*="multiSelect"]',
        )
      )
        return 'tag-input';

      // file upload
      if (container?.querySelector('input[type="file"]') || control?.type === 'file')
        return 'file';

      // date (spin-button date picker)
      const spinButtons = container
        ? Array.from(container.querySelectorAll('[role="spinbutton"], input[data-automation-id*="dateSection"]'))
        : [];
      if (spinButtons.length >= 2) return 'date';

      // date (automation-id signals)
      if (
        container?.querySelector(
          '[data-automation-id*="datePicker"], [data-automation-id*="dateInput"]',
        ) ||
        control?.getAttribute('data-automation-id')?.toLowerCase().includes('date')
      )
        return 'date';

      // spinbutton (standalone — CC-305 year selectors)
      if (
        control?.getAttribute('role') === 'spinbutton' ||
        container?.querySelector('[role="spinbutton"]')
      )
        return 'spinbutton';

      // dropdown / combobox
      const hasDropdown =
        container?.querySelector(
          '[role="combobox"], [data-automation-id="selectWidget"], [data-automation-id="selectOne"], button[aria-haspopup="listbox"], select',
        ) ||
        control?.getAttribute('role') === 'combobox' ||
        control?.getAttribute('aria-haspopup') === 'listbox';
      if (hasDropdown) return 'dropdown';

      // radio group
      const radios = container
        ? container.querySelectorAll('input[type="radio"], [role="radio"]')
        : [];
      if (
        radios.length > 0 ||
        control?.type === 'radio' ||
        control?.getAttribute('role') === 'radio'
      )
        return 'radio';

      // checkbox group / single checkbox
      const checkboxes = container
        ? container.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
        : [];
      if (
        checkboxes.length > 1 ||
        (checkboxes.length === 1 && /select all that apply/i.test(
          container?.textContent || '',
        ))
      )
        return 'checkbox-group';
      if (
        checkboxes.length === 1 ||
        control?.type === 'checkbox' ||
        control?.getAttribute('role') === 'checkbox'
      )
        return 'checkbox';

      // textarea / contenteditable
      if (
        container?.querySelector('textarea, [contenteditable="true"]') ||
        control?.tagName?.toLowerCase() === 'textarea' ||
        control?.getAttribute('contenteditable') === 'true'
      )
        return 'textarea';

      // text (default)
      return 'text';
    }

    /** Read current DOM value from a formField container. */
    function readValue(container) {
      if (!container) return '';

      // selectedItem (Workday custom dropdown)
      const sel = container.querySelector('[data-automation-id="selectedItem"]');
      if (sel?.textContent?.trim()) {
        const t = sel.textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }

      // button combobox / dropdown trigger text
      const btn = container.querySelector(
        'button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button, [data-automation-id="selectOne"] button',
      );
      if (btn) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120 && !/\?$/.test(t))
          return t;
      }

      // native select
      const nativeSelect = container.querySelector('select');
      if (nativeSelect?.selectedOptions?.[0]?.textContent?.trim()) {
        const t = nativeSelect.selectedOptions[0].textContent.trim();
        if (!/^select(\s+one)?\.?$/i.test(t)) return t;
      }

      // date spinbuttons — build MM/DD/YYYY composite
      const spins = Array.from(
        container.querySelectorAll(
          '[role="spinbutton"], input[data-automation-id*="dateSection"], input[data-automation-id*="dateInput"]',
        ),
      );
      if (spins.length >= 2) {
        let month = '', day = '', year = '';
        for (const sp of spins) {
          const hint =
            `${sp.getAttribute('aria-label') || ''} ${sp.getAttribute('data-automation-id') || ''} ${sp.placeholder || ''}`.toLowerCase();
          const val = (sp.value || '').trim();
          if (/month|\bmm\b|datesectionmonth/i.test(hint)) month = val;
          else if (/day|\bdd\b|datesectionday/i.test(hint)) day = val;
          else if (/year|yyyy|datesectionyear/i.test(hint)) year = val;
        }
        if (!month && !day && !year && spins.length >= 3) {
          [month, day, year] = spins.map((s) => s.value || '');
        }
        const isPlaceholder = (v) =>
          !v || /^(m+|d+|y+|mm|dd|yyyy|empty|select)$/i.test(v);
        if (!isPlaceholder(month) || !isPlaceholder(day) || !isPlaceholder(year)) {
          return [
            isPlaceholder(month) ? '' : String(month).padStart(2, '0'),
            isPlaceholder(day) ? '' : String(day).padStart(2, '0'),
            isPlaceholder(year) ? '' : String(year),
          ]
            .filter(Boolean)
            .join('/');
        }
        return '';
      }

      // textarea
      const textarea = container.querySelector('textarea');
      if (textarea) return (textarea.value || '').trim();

      // text inputs
      const textInput = container.querySelector(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      );
      if (textInput?.value !== undefined) return (textInput.value || '').trim();

      // checked radio
      const checkedRadio = container.querySelector('input[type="radio"]:checked');
      if (checkedRadio) {
        const id = checkedRadio.id;
        const lab = id
          ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
          : checkedRadio.closest('label');
        if (lab?.textContent?.trim()) return lab.textContent.trim();
      }

      // checked checkboxes
      const checkedBoxes = [];
      container.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
        const id = cb.id;
        const lab = id
          ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
          : cb.closest('label');
        const text = (lab?.textContent || cb.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) checkedBoxes.push(text);
      });
      if (checkedBoxes.length > 0) return checkedBoxes.join(', ');

      return '';
    }

    /** Collect live options from within a formField container (radio, checkbox, native select). */
    function collectStaticOptions(container, fieldType) {
      if (!container) return [];
      const out = [];
      const seen = new Set();
      const add = (t) => {
        const clean = (t || '').replace(/\s+/g, ' ').trim();
        if (!clean || clean.length > 140 || /^select(\s+one)?$/i.test(clean)) return;
        const key = clean.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(clean); }
      };

      if (fieldType === 'radio') {
        container.querySelectorAll('input[type="radio"], [role="radio"]').forEach((r) => {
          const id = r.id;
          const lab = id
            ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
            : r.closest('label');
          add(lab?.textContent || r.getAttribute('aria-label') || '');
        });
      } else if (fieldType === 'checkbox' || fieldType === 'checkbox-group') {
        container.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach((cb) => {
          const id = cb.id;
          const lab = id
            ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
            : cb.closest('label');
          add(lab?.textContent || cb.getAttribute('aria-label') || '');
        });
      } else if (fieldType === 'dropdown') {
        container.querySelectorAll('select option').forEach((opt) =>
          add(opt.textContent),
        );
      }
      return out;
    }

    /** Build a reliable CSS selector for a control element. */
    function buildSelector(container, control) {
      if (control?.id) return `#${CSS.escape(control.id)}`;
      const aid =
        control?.getAttribute?.('data-automation-id') ||
        container?.getAttribute?.('data-automation-id');
      if (aid) return `[data-automation-id="${CSS.escape(aid)}"]`;
      const name = control?.getAttribute?.('name');
      if (name) return `${(control.tagName || 'input').toLowerCase()}[name="${CSS.escape(name)}"]`;
      // Fallback: wdQId marker
      const wdQId = container?.getAttribute?.('data-wd-q-id');
      if (wdQId) return `[data-wd-q-id="${CSS.escape(wdQId)}"]`;
      return '';
    }

    // ── Main scan loop ─────────────────────────────────────────────────────────

    const results = [];
    const seen = new Set();

    /** Ensure a stable marker ID on each container for re-scan identity. */
    function ensureMarkerId(el, label) {
      if (!el) return '';
      const existing = el.getAttribute('data-wd-q-id');
      if (existing) return existing;
      const base = norm(label).slice(0, 36).replace(/\s+/g, '-') || 'field';
      let id = `wdq-${base}`.replace(/[^a-z0-9_-]/gi, '') || 'wdq-field';
      let n = 0;
      while (document.querySelector(`[data-wd-q-id="${CSS.escape(id)}"]`) && n < 24) {
        n++;
        id = `wdq-${base}-${n}`.replace(/[^a-z0-9_-]/gi, '');
      }
      el.setAttribute('data-wd-q-id', id);
      return id;
    }

    // Pass 1: formField containers (highest fidelity — Workday's own structure)
    const containers = document.querySelectorAll(
      '[data-automation-id*="formField"], [data-automation-id*="FormField"], [data-automation-id*="question"], [data-automation-id*="Question"], fieldset[role="group"], [role="group"][data-automation-id]',
    );

    for (const container of containers) {
      // Skip outer wrappers — process innermost formFields individually
      if (
        container.querySelector(
          '[data-automation-id*="formField"], [data-automation-id*="FormField"]',
        )
      )
        continue;

      const control = container.querySelector(
        'input:not([type="hidden"]):not([data-automation-id="beecatcher"]), select, textarea, [role="combobox"], button[aria-haspopup="listbox"], [data-automation-id="selectOne"], [data-automation-id="selectWidget"]',
      );

      const label = getLabel(container, control);
      if (
        !label ||
        label.length < 3 ||
        /indicates a required field|application questions \d+ of|drop files here/i.test(label)
      )
        continue;

      const key = norm(label);
      if (!key || seen.has(key)) continue;

      const fieldType = detectType(container, control);
      // Skip containers with no recognizable control
      if (
        !control &&
        !container.querySelector(
          'input, select, textarea, [role="combobox"], button[aria-haspopup="listbox"]',
        )
      )
        continue;

      seen.add(key);
      const markerId = ensureMarkerId(container, label);
      const automationId =
        control?.getAttribute('data-automation-id') ||
        container.getAttribute('data-automation-id') ||
        control?.id ||
        container.id ||
        '';

      results.push({
        label,
        normalizedLabel: key,
        automationId,
        fieldType,
        required: isRequired(control, container),
        currentValue: readValue(container),
        options: collectStaticOptions(container, fieldType),
        selector: buildSelector(container, control),
        wdQId: markerId,
        // Extra context for downstream fill logic
        containerText: (container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        source: 'formField',
      });
    }

    // Pass 2: standalone selectOne / selectWidget not inside a captured formField
    const selectWidgets = document.querySelectorAll(
      '[data-automation-id="selectOne"], [data-automation-id="selectWidget"]',
    );
    selectWidgets.forEach((widget) => {
      const fieldRoot =
        widget.closest('[data-automation-id*="formField"]') ||
        widget.closest('[role="group"]') ||
        widget.parentElement;

      const label = getLabel(fieldRoot, widget);
      if (!label || label.length < 3) return;
      const key = norm(label);
      if (!key || seen.has(key)) return;

      const aid = widget.getAttribute('data-automation-id') ||
        fieldRoot?.getAttribute('data-automation-id') || '';
      const markerId = ensureMarkerId(fieldRoot || widget, label);
      seen.add(key);

      const currentValue = (() => {
        const sel = widget.querySelector('[data-automation-id="selectedItem"]');
        if (sel?.textContent?.trim()) {
          const t = sel.textContent.trim();
          if (!/^select(\s+one)?\.?$/i.test(t)) return t;
        }
        const btn = widget.querySelector('button');
        if (btn) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !/^select(\s+one)?\.?$/i.test(t) && t.length < 120) return t;
        }
        return '';
      })();

      results.push({
        label,
        normalizedLabel: key,
        automationId: aid,
        fieldType: 'dropdown',
        required: isRequired(widget, fieldRoot),
        currentValue,
        options: [],
        selector: `[data-automation-id="${CSS.escape(aid)}"]` || buildSelector(fieldRoot, widget),
        wdQId: markerId,
        containerText: (fieldRoot?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        source: 'selectWidget',
      });
    });

    // Pass 3: full control walk — catch any remaining interactive elements
    const NOISE_SELECTORS = [
      '[data-automation-id="beecatcher"]',
      '[name="website"]',
      '[type="hidden"]',
      '[type="submit"]',
      '[type="button"]',
      '[type="image"]',
      '[type="reset"]',
    ];
    const controlNodes = document.querySelectorAll(
      [
        'input:not([type="hidden"]):not([data-automation-id="beecatcher"])',
        'textarea',
        'select',
        '[role="combobox"]',
        'button[aria-haspopup="listbox"]',
      ].join(','),
    );

    for (const control of controlNodes) {
      // Skip if already covered by a marker
      const groupRoot =
        control.closest(
          '[data-automation-id*="formField"], [data-automation-id*="FormField"], fieldset, [role="group"]',
        ) || control;
      if (groupRoot.getAttribute('data-wd-q-id') && groupRoot !== control) continue;
      if (control.getAttribute('data-wd-q-id')) continue;

      // Skip noise
      if (NOISE_SELECTORS.some((s) => { try { return control.matches(s); } catch { return false; } }))
        continue;
      if (!isVisible(control)) continue;

      const label = getLabel(groupRoot, control);
      if (!label || label.length < 3) continue;

      const key = norm(label);
      if (!key || seen.has(key)) continue;

      // Skip bare option text (Yes/No radio leaves)
      const typeAttr = (control.getAttribute('type') || '').toLowerCase();
      if (
        (typeAttr === 'radio' || typeAttr === 'checkbox') &&
        /^(yes|no|male|female|n\/a|prefer not to answer)$/i.test(label)
      )
        continue;

      const fieldType = detectType(groupRoot, control);
      const automationId =
        control.getAttribute('data-automation-id') ||
        groupRoot.getAttribute('data-automation-id') ||
        control.id ||
        '';

      seen.add(key);
      const markerId = ensureMarkerId(groupRoot, label);

      results.push({
        label,
        normalizedLabel: key,
        automationId,
        fieldType,
        required: isRequired(control, groupRoot),
        currentValue: readValue(groupRoot) || (control.value || '').trim(),
        options: collectStaticOptions(groupRoot, fieldType),
        selector: buildSelector(groupRoot, control),
        wdQId: markerId,
        containerText: (groupRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        source: 'control_walk',
      });
    }

    return results;
  };
}

// ─── Main discovery export ────────────────────────────────────────────────────

/**
 * Discover all form fields on the current Workday wizard page using fast DOM locators.
 * Replaces the old page.accessibility.snapshot() approach.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{
 *   label: string, normalizedLabel: string, automationId: string,
 *   fieldType: string, required: boolean, currentValue: string,
 *   options: string[], selector: string
 * }>>}
 */
export async function discoverFormFieldQuestions(page) {
  // 1. Wait for DOM to settle (max 2s)
  await waitForDomSettled(page, { timeout: 2000 });

  // 2. Run fast in-browser scan using page.evaluate
  let rawFields = [];
  try {
    const scanFn = buildInBrowserScanner();
    rawFields = await page.evaluate(scanFn);
  } catch (err) {
    console.warn('[workdayDom] discoverFormFieldQuestions evaluate error:', err.message);
    return [];
  }

  // 3. Filter out aria-hidden / off-screen elements and noise labels
  const filtered = (rawFields || []).filter((f) => {
    if (!f.label || !f.normalizedLabel) return false;
    if (
      /indicates a required field|application questions \d+ of|recruitment privacy|drop files here/i.test(
        f.label,
      )
    )
      return false;
    return true;
  });

  // 4. Deduplicate by automationId > normalizedLabel (automationId wins when set)
  const deduped = [];
  const seenKeys = new Set();
  for (const f of filtered) {
    const key = f.automationId ? `aid:${f.automationId}` : `label:${f.normalizedLabel}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(f);
  }

  // 5. Already in DOM order (pass 1→2→3 preserves document order)
  return deduped;
}

/** @deprecated Use discoverFormFieldQuestions */
export const discoverApplicationQuestionFields = discoverFormFieldQuestions;

/**
 * Scan for newly appeared fields since the last known set.
 * Call this after every individual field fill to detect dynamic sub-fields.
 *
 * @param {import('playwright').Page} page
 * @param {Set<string>} knownFieldKeys — set of `automationId` or `label:normalizedLabel` keys
 * @returns {Promise<Array>} — only NEW fields not in knownFieldKeys
 */
export async function scanPageForNewFields(page, knownFieldKeys = new Set()) {
  await waitForDomSettled(page, { timeout: 600 });
  const all = await discoverFormFieldQuestions(page);
  return all.filter((f) => {
    const key = f.automationId
      ? `aid:${f.automationId}`
      : `label:${f.normalizedLabel}`;
    return !knownFieldKeys.has(key);
  });
}

// ─── collectLiveFieldOptions — open dropdown, scrape, close ──────────────────

/**
 * Collect live option labels for a Workday field.
 * For dropdowns: opens the dropdown, scrapes visible options, then closes.
 * For radio/checkbox: reads from static DOM (no click needed).
 *
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {string} [automationId]
 * @returns {Promise<string[]>}
 */
export async function collectLiveFieldOptions(page, label, automationId) {
  // First try: read static options (radio / checkbox / native select)
  const staticOptions = await page
    .evaluate(
      ({ labelNorm, aid }) => {
        function norm(s) {
          return (s || '')
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
        const seen = new Set();
        const out = [];
        const add = (t) => {
          const clean = (t || '').replace(/\s+/g, ' ').trim();
          if (!clean || clean.length > 140 || /^select(\s+one)?$/i.test(clean)) return;
          const k = clean.toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(clean); }
        };

        // Locate the field container
        let container = null;
        if (aid) container = document.querySelector(`[data-automation-id="${CSS.escape(aid)}"]`);
        if (!container) {
          // Proximity scan by label text
          for (const root of document.querySelectorAll(
            '[data-automation-id*="formField"], fieldset[role="group"]',
          )) {
            const text = norm(root.textContent || '');
            if (text.includes(labelNorm.slice(0, 40))) { container = root; break; }
          }
        }
        if (!container) return [];

        // Radio options
        container.querySelectorAll('input[type="radio"]').forEach((r) => {
          const id = r.id;
          const lab = id
            ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
            : r.closest('label');
          add(lab?.textContent || r.getAttribute('aria-label') || '');
        });

        // Checkbox options
        container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          const id = cb.id;
          const lab = id
            ? container.querySelector(`label[for="${CSS.escape(id)}"]`)
            : cb.closest('label');
          add(lab?.textContent || cb.getAttribute('aria-label') || '');
        });

        // Native select options
        container.querySelectorAll('select option').forEach((opt) =>
          add(opt.textContent),
        );

        return out;
      },
      { labelNorm: normalizeLabel(label), aid: automationId || '' },
    )
    .catch(() => []);

  if (staticOptions.length > 0) return staticOptions;

  // Second try: open dropdown and scrape live listbox
  try {
    await page.keyboard.press('Escape').catch(() => {});

    // Locate trigger button/combobox for this field
    const triggerSel = automationId
      ? `[data-automation-id="${automationId}"] button[aria-haspopup="listbox"], [data-automation-id="${automationId}"] [role="combobox"], [data-automation-id="${automationId}"]`
      : null;

    if (!triggerSel) return [];

    const trigger = page.locator(triggerSel).first();
    const triggerCount = await trigger.count().catch(() => 0);
    if (!triggerCount) return [];

    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);

    const liveOptions = await page
      .evaluate(() => {
        const seen = new Set();
        const out = [];
        for (const el of document.querySelectorAll(
          '[role="option"], [data-automation-id="promptOption"], [role="treeitem"], [role="menuitem"]',
        )) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          if (!el.offsetParent && el.getClientRects().length === 0) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 140 || /^select(\s+one)?$/i.test(text)) continue;
          const k = text.toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(text); }
        }
        return out;
      })
      .catch(() => []);

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    return liveOptions.length > 0 ? liveOptions : staticOptions;
  } catch {
    return staticOptions;
  }
}

// ─── discoverWorkdayFields — merges formField scan (primary export used by engine) ──

/**
 * Discover Workday fields from DOM (fast scanner only — no a11y snapshot).
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
export async function discoverWorkdayFields(page) {
  const formQuestions = await discoverFormFieldQuestions(page).catch(() => []);
  return (formQuestions || []).map((q) => ({
    ...q,
    type: q.fieldType === 'dropdown' ? 'select' : q.fieldType,
    value: q.currentValue,
    normalizedLabel: q.normalizedLabel || normalizeLabel(q.label),
    source: q.source || 'formField',
    _formField: true,
  }));
}

// ─── locateWorkdayFieldByLabel ────────────────────────────────────────────────

/**
 * Locate a Workday form control by its visible label text (smallest matching formField).
 * @param {import('playwright').Page} page
 * @param {string|RegExp} labelPattern
 * @param {{ excludePatterns?: string[] }} [options]
 * @returns {Promise<import('playwright').Locator|null>}
 */
export async function locateWorkdayFieldByLabel(page, labelPattern, options = {}) {
  const pattern =
    typeof labelPattern === 'string' ? labelPattern : labelPattern.source;
  const exclude = options.excludePatterns || [];

  const selector = await page
    .evaluate(
      ({ pattern, exclude }) => {
        let labelRe;
        try { labelRe = new RegExp(pattern, 'i'); } catch { return ''; }
        const excludeRes = exclude
          .map((e) => { try { return new RegExp(e, 'i'); } catch { return null; } })
          .filter(Boolean);
        const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

        const candidates = [];
        for (const labelEl of document.querySelectorAll(
          'label, legend, [data-automation-id*="label"]',
        )) {
          const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
          if (!labelText || !labelRe.test(labelText)) continue;
          if (excludeRes.some((re) => re.test(labelText))) continue;

          const formField =
            labelEl.closest('[data-automation-id*="formField"]') ||
            labelEl.closest('fieldset') ||
            labelEl.closest('[role="group"]') ||
            labelEl.parentElement;
          if (!formField) continue;

          const trigger = formField.querySelector(
            'button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id="selectWidget"] button, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
          );
          if (!trigger) continue;

          const rect = formField.getBoundingClientRect();
          candidates.push({
            trigger,
            labelLen: labelText.length,
            area: Math.max(1, rect.width * rect.height),
          });
        }

        if (!candidates.length) return '';
        candidates.sort((a, b) => a.labelLen - b.labelLen || a.area - b.area);
        const { trigger } = candidates[0];
        if (trigger.id) return `#${CSS.escape(trigger.id)}`;
        const aid = trigger.getAttribute('data-automation-id');
        if (aid) return `[data-automation-id="${CSS.escape(aid)}"]`;
        const name = trigger.getAttribute('name');
        if (name) return `${trigger.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        if (/textarea/i.test(trigger.tagName)) return 'textarea';
        return '';
      },
      { pattern, exclude },
    )
    .catch(() => '');

  return selector ? page.locator(selector).first() : null;
}

// ─── Verification utilities ───────────────────────────────────────────────────

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
 * @param {object} [profile]
 * @returns {{ ok: boolean, unresolved: object[] }}
 */
export function verifyRequiredFields(fields = [], profile = {}) {
  const filledKeys = Object.keys(profile._filledValues || {}).map((k) =>
    normalizeLabel(k),
  );
  const unresolved = [];
  for (const f of fields) {
    if (f.disabled) continue;
    if (f.role === 'searchbox' || /search/i.test(f.label || '')) continue;
    if (!f.required && !(typeof f.label === 'string' && f.label.includes('*')))
      continue;
    const nl = normalizeLabel(f.label || f.id || '');
    if (
      nl &&
      filledKeys.some((k) => k && (k === nl || nl.includes(k) || k.includes(nl)))
    )
      continue;
    const val = f.currentValue ?? f.value;
    if (typeof val === 'string' && /item selected|workday\.com|united states/i.test(val))
      continue;
    if (isEmptyValue(val)) unresolved.push(f);
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * Re-check scanner "empty" required fields against live Workday DOM.
 * @param {import('playwright').Page} page
 * @param {object[]} unresolved
 * @returns {Promise<object[]>}
 */
export async function filterTrulyEmptyRequired(page, unresolved = []) {
  const still = [];
  for (const f of unresolved) {
    const live = await page
      .evaluate(
        ({ selector, label, automationId }) => {
          const clean = (label || '').replace(/\*+/g, '').trim();
          function readVal(root) {
            if (!root) return '';
            if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA')
              return (root.value || '').trim();
            const selected =
              root.querySelector('[data-automation-id="selectedItem"]') ||
              root
                .closest('[data-automation-id]')
                ?.querySelector('[data-automation-id="selectedItem"]');
            if (selected && selected.textContent.trim())
              return selected.textContent.trim();
            const input = root.querySelector(
              'input:not([type="hidden"]):not([type="search"]), textarea',
            );
            if (input && input.value) return input.value.trim();
            const combo = root.querySelector('[role="combobox"]');
            if (
              combo &&
              (combo.innerText || '').trim() &&
              !/^select/i.test(combo.innerText.trim())
            )
              return combo.innerText.trim();
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
            const el = document.querySelector(
              `[data-automation-id="${automationId}"]`,
            );
            const v = readVal(el);
            if (v && !/^select(\s+one)?$/i.test(v)) return v;
          }
          const labels = Array.from(document.querySelectorAll('label, legend'));
          const lab = labels.find(
            (l) =>
              clean && (l.textContent || '').replace(/\*+/g, '').includes(clean),
          );
          if (lab) {
            const root =
              lab.closest(
                '[data-automation-id*="formField"], [data-automation-id*="Field"], fieldset, div',
              ) || lab.parentElement;
            return readVal(root);
          }
          return '';
        },
        {
          selector: f.selector || '',
          label: f.label || '',
          automationId: f.automationId || '',
        },
      )
      .catch(() => '');

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

// ─── Review page parsing ──────────────────────────────────────────────────────

/**
 * Parse Review page displayed values from the DOM.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ pairs: object[], bodyText: string }>}
 */
export async function parseReviewDOM(page) {
  return page.evaluate(() => {
    const pairs = [];
    const seen = new Set();

    function cleanLabel(raw) {
      if (!raw) return '';
      return raw
        .replace(/^[\s*•\-–—:]+/, '')
        .replace(/[\s*•\-–—:]+$/, '')
        .replace(/\s*\((required|optional|impo.*?)\)/gi, '')
        .replace(/\s*(required|important)\s*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Definition lists (dt/dd) — Workday Review page summary format
    document.querySelectorAll('dt').forEach((dt) => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const rawLabel = (dt.textContent || '').trim();
        const value = (dd.textContent || '').trim();
        const lbl = cleanLabel(rawLabel);
        if (
          lbl &&
          value &&
          value.length < 2000 &&
          !seen.has(lbl.toLowerCase()) &&
          lbl.length >= 2 &&
          lbl.length <= 150
        ) {
          seen.add(lbl.toLowerCase());
          pairs.push({ label: lbl, rawLabel, value, isRequired: true, isImportant: true });
        }
      }
    });

    // Standard form fields
    document
      .querySelectorAll('[data-automation-id*="formField"], [class*="formField"]')
      .forEach((field) => {
        const labelEl = field.querySelector('label, [data-automation-id*="label"], legend');
        if (!labelEl) return;
        const rawLabel = (labelEl.textContent || '').trim();
        const lbl = cleanLabel(rawLabel);
        if (!lbl || seen.has(lbl.toLowerCase()) || lbl.length < 2 || lbl.length > 150)
          return;

        const valueEl = field.querySelector(
          'input, textarea, select, [data-automation-id*="selectedItem"], [data-automation-id*="promptOption"]',
        );
        const value = (valueEl?.value || valueEl?.textContent || '').trim();
        if (value && value.length < 2000) {
          seen.add(lbl.toLowerCase());
          pairs.push({ label: lbl, rawLabel, value, isRequired: true, isImportant: true });
        }
      });

    return { pairs, bodyText: document.body?.innerText || '' };
  });
}

/**
 * Compare expected filled values against Review page text.
 * @param {Record<string, string>} expected
 * @param {{ pairs: object[], bodyText: string }} review
 * @returns {{ field: string, expected: string, displayed: string }[]}
 */
export function crossCheckReview(
  expected = {},
  review = { pairs: [], bodyText: '' },
) {
  const haystack = `${review.bodyText || ''} ${(review.pairs || [])
    .map((p) => `${p.label || ''} ${p.value || ''}`)
    .join(' ')}`.toLowerCase();
  const haystackDigits = haystack.replace(/\D/g, '');
  const mismatches = [];

  for (const [field, expectedVal] of Object.entries(expected)) {
    if (expectedVal === undefined || expectedVal === null || String(expectedVal).trim() === '')
      continue;
    const needle = String(expectedVal).toLowerCase().trim();
    const digits = needle.replace(/\D/g, '');
    const foundText = haystack.includes(needle);
    const foundDigits = digits.length >= 7 && haystackDigits.includes(digits);
    if (foundText || foundDigits) continue;
    const pair = (review.pairs || []).find((p) =>
      (p.label || '').toLowerCase().includes(field.toLowerCase()),
    );
    mismatches.push({
      field,
      expected: String(expectedVal),
      displayed: pair?.value || '(not found on Review page)',
    });
  }
  return mismatches;
}

// ─── Misc utilities (preserved for downstream consumers) ─────────────────────

/**
 * Split a country phone-code profile value into search term + option matcher.
 * @param {string} profileValue
 * @returns {{ searchTerm: string, optionText: string }}
 */
export function parseCountryPhoneCode(profileValue) {
  const raw = String(profileValue || 'United States of America (+1)').trim();
  const withoutCode = raw
    .replace(/\s*\(\s*\+?\d+\s*\)\s*$/, '')
    .replace(/\s*\+\d+\s*$/, '')
    .trim();
  const searchTerm = (withoutCode || raw).toLowerCase();
  return {
    searchTerm: searchTerm.split(/\s+/)[0] || searchTerm,
    optionText: raw,
  };
}

/**
 * Read the current live DOM value of a single field without full-page discovery.
 * @param {import('playwright').Page} page
 * @param {object} field
 * @returns {Promise<string>}
 */
export async function readFieldState(page, field) {
  if (!page || !field) return '';
  try {
    return await page.evaluate(
      ({ selector, automationId, wdQId }) => {
        let root = null;
        if (wdQId) root = document.querySelector(`[data-wd-q-id="${wdQId}"]`);
        if (!root && automationId)
          root = document.querySelector(`[data-automation-id="${automationId}"]`);
        if (!root && selector) root = document.querySelector(selector);
        if (!root) return '';

        // Checkbox group
        const cbs = Array.from(
          root.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
        );
        if (cbs.length > 1) {
          return cbs
            .filter(
              (cb) => cb.checked || cb.getAttribute('aria-checked') === 'true',
            )
            .map((cb) => {
              const lbl = cb.id
                ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`)
                : cb.closest('label');
              return (lbl?.textContent || cb.getAttribute('aria-label') || cb.value || '').trim();
            })
            .filter(Boolean)
            .join(', ');
        }

        // Radio group
        const checked = root.querySelector(
          'input[type="radio"]:checked, [role="radio"][aria-checked="true"]',
        );
        if (checked) {
          const lbl = checked.id
            ? document.querySelector(`label[for="${CSS.escape(checked.id)}"]`)
            : checked.closest('label');
          return (lbl?.textContent || checked.getAttribute('aria-label') || checked.value || '').trim();
        }

        // Dropdown selected item
        const selectedItem = root.querySelector('[data-automation-id="selectedItem"]');
        if (
          selectedItem?.textContent?.trim() &&
          !/^select(\s+one)?\.?$/i.test(selectedItem.textContent.trim())
        )
          return selectedItem.textContent.trim();

        const btn = root.querySelector(
          'button[aria-haspopup="listbox"], [data-automation-id*="select"] button, [role="combobox"]',
        );
        if (btn) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !/^select(\s+one)?\.?$/i.test(t)) return t;
        }

        // Date spinbuttons
        const spins = Array.from(
          root.querySelectorAll(
            'input[role="spinbutton"], input[data-automation-id*="dateSection"]',
          ),
        );
        if (spins.length >= 2) {
          const vals = spins
            .map((s) => (s.value || '').trim())
            .filter((v) => v && !/^(mm|dd|yyyy)$/i.test(v));
          if (vals.length >= 2) return vals.join('/');
        }

        // Standard input / textarea
        const input = root.querySelector('input:not([type="hidden"]), textarea');
        if (input && input.value !== undefined) return (input.value || '').trim();

        return (root.value || root.innerText || root.textContent || '').trim();
      },
      {
        selector: field.selector,
        automationId: field.automationId,
        wdQId: field.wdQId,
      },
    );
  } catch {
    return '';
  }
}

// ─── Legacy merge helpers (kept for backward compatibility) ───────────────────

function fieldKey(f) {
  if (f.automationId) return `aid:${f.automationId}`;
  const label = normalizeLabel(f.label);
  if (label) return `label:${label}`;
  if (f.id) return `id:${f.id}`;
  if (f.name) return `name:${f.name}`;
  return `fallback:${f.selector || f.key || ''}`;
}

/**
 * Merge DOM scanner fields with a secondary field list.
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
    const existing = merged.find(
      (m) =>
        fieldKey(m) === k ||
        (m.normalizedLabel &&
          a.normalizedLabel &&
          m.normalizedLabel === a.normalizedLabel),
    );
    if (existing) {
      if (!existing.options?.length && a.options?.length)
        existing.options = a.options;
      if (!existing.required && a.required) existing.required = true;
      if (!existing.label && a.label) {
        existing.label = a.label;
        existing.normalizedLabel = normalizeLabel(a.label);
      }
      if (existing.currentValue === '' && a.currentValue)
        existing.currentValue = a.currentValue;
    } else if (a.label) {
      merged.push({
        ...a,
        normalizedLabel: a.normalizedLabel || normalizeLabel(a.label),
        automationId: a.automationId || '',
      });
      seen.add(k);
    }
  }
  return merged;
}
