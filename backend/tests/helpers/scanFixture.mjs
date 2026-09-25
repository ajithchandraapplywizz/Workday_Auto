/**
 * Label-first scan of the controlled HTML fixtures.
 * Used by the test ATS adapter so dry-run does not depend on live Workday widgets.
 */

import { normalizeDiscoveredField } from '../../lib/interaction/fieldSchema.mjs';

export async function scanFixtureFields(page, meta = {}) {
  const raws = await page.evaluate(() => {
    function clean(s) {
      return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function optionTexts(root) {
      const fromRadio = Array.from(root.querySelectorAll('input[type="radio"]')).map((el) => {
        const id = el.id;
        const lab = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest('label');
        return clean(lab?.textContent || el.value);
      });
      const fromCheck = Array.from(root.querySelectorAll('input[type="checkbox"]')).map((el) => {
        const id = el.id;
        const lab = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest('label');
        return clean(lab?.textContent || el.getAttribute('aria-label') || el.value);
      });
      const fromSelect = Array.from(root.querySelectorAll('select option'))
        .map((o) => clean(o.textContent))
        .filter((t) => t && !/^select/i.test(t));
      const fromList = Array.from(root.querySelectorAll('[role="option"]')).map((o) => clean(o.textContent));
      return [...fromRadio, ...fromCheck, ...fromSelect, ...fromList].filter(Boolean);
    }

    function currentValue(root) {
      const checkedRadio = root.querySelector('input[type="radio"]:checked');
      if (checkedRadio) {
        const id = checkedRadio.id;
        const lab = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : checkedRadio.closest('label');
        return clean(lab?.textContent || checkedRadio.value);
      }
      const boxes = Array.from(root.querySelectorAll('input[type="checkbox"]:checked')).map((el) => {
        const id = el.id;
        const lab = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest('label');
        return clean(lab?.textContent || el.value);
      });
      if (boxes.length) {
        const onlyOne = root.querySelectorAll('input[type="checkbox"]').length === 1;
        return onlyOne ? 'Yes' : boxes.join(', ');
      }
      const select = root.querySelector('select');
      if (select?.selectedOptions?.[0]) {
        const t = clean(select.selectedOptions[0].textContent);
        if (t && !/^select/i.test(t)) return t;
      }
      const selected = root.querySelector('[data-automation-id="selectedItem"], [data-selected="true"]');
      if (selected) return clean(selected.textContent);
      const file = root.querySelector('input[type="file"]');
      if (file?.files?.length) return file.files[0].name;
      const input = root.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea');
      return input ? String(input.value || '').trim() : '';
    }

    function isShown(el) {
      if (!el) return false;
      if (el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    const nodes = Array.from(document.querySelectorAll('[data-automation-id*="formField"], [data-test-field]'));
    return nodes.map((root) => {
      const control = root.querySelector('input, textarea, select, [role="combobox"], button[aria-haspopup="listbox"]');
      const labelEl = root.querySelector('[data-automation-id*="label"], label, legend, [data-test-label]');
      const label = clean(labelEl?.textContent || control?.getAttribute('aria-label') || '');
      const visible = isShown(root);
      const typeAttr = (control?.getAttribute('type') || '').toLowerCase();
      const declared = root.getAttribute('data-control') || '';
      let fieldType = declared;
      if (!fieldType) {
        if (typeAttr === 'email') fieldType = 'email';
        else if (typeAttr === 'tel') fieldType = 'tel';
        else if (typeAttr === 'number') fieldType = 'number';
        else if (typeAttr === 'date') fieldType = 'date';
        else if (typeAttr === 'file') fieldType = 'file';
        else if (typeAttr === 'radio') fieldType = 'radio';
        else if (typeAttr === 'checkbox') {
          fieldType = root.querySelectorAll('input[type="checkbox"]').length > 1 ? 'checkbox-group' : 'checkbox';
        } else if (control?.tagName === 'TEXTAREA') fieldType = 'textarea';
        else if (control?.tagName === 'SELECT') fieldType = 'select';
        else if (control?.getAttribute('role') === 'combobox' || root.getAttribute('data-control') === 'custom-combobox') {
          fieldType = 'combobox';
        } else if (root.querySelector('[data-automation-id="selectOne"]')) fieldType = 'dropdown';
        else fieldType = 'text';
      }
      if (control?.tagName === 'SELECT') {
        return {
          questionId: root.getAttribute('data-test-field') || root.getAttribute('data-automation-id'),
          label,
          description: control.getAttribute('placeholder') || '',
          fieldType,
          nativeSelect: true,
          required: root.getAttribute('data-required') === 'true' || /\*/.test(label) || control.required,
          options: optionTexts(root),
          currentValue: currentValue(root),
          disabled: Boolean(control.disabled),
          visible,
          wdQId: root.getAttribute('data-wd-q-id') || null,
        };
      }
      return {
        questionId: root.getAttribute('data-test-field') || root.getAttribute('data-automation-id'),
        label,
        description: control?.getAttribute('placeholder') || root.querySelector('[data-test-help]')?.textContent || '',
        fieldType,
        required: root.getAttribute('data-required') === 'true' || /\*/.test(label) || control?.required || control?.getAttribute('aria-required') === 'true',
        options: optionTexts(root),
        currentValue: currentValue(root),
        disabled: Boolean(control?.disabled || root.getAttribute('data-disabled') === 'true'),
        visible,
        wdQId: root.getAttribute('data-wd-q-id') || null,
      };
    }).filter((row) => row.label && row.visible);
  });

  return raws.map((raw) => normalizeDiscoveredField(raw, meta));
}

export async function fixturePageTitle(page) {
  const title = await page.locator('[data-page-title]').first().textContent().catch(() => '');
  return String(title || '').trim() || 'Unknown';
}

export async function fixtureVisibleErrors(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-test-error]:not([hidden]), [role="alert"]'))
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}
