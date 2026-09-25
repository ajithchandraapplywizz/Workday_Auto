/**
 * fillHandlers.mjs — Explicit per-control-type fill handlers for Workday & universal forms
 *
 * Provides dedicated, robust handlers for:
 * 1. Dropdown (native-select & custom-dropdown)
 * 2. Checkbox group (multi-select)
 * 3. Radio group (single-select)
 * 4. Date picker (direct text entry into MM/DD/YYYY input/spinbuttons)
 * 5. Free-text (input/textarea)
 *
 * Uses tokenSetRatio >= 85 for option matching against visible DOM options.
 */

import { tokenSetRatio, findBestOptionMatch } from './fields.mjs';
import { detectControlType } from './scanner.mjs';

/**
 * Standardize date values to MM/DD/YYYY format for Workday date inputs.
 * @param {string|Date} val
 * @returns {string}
 */
export function formatToMMDDYYYY(val) {
  if (!val) return '';
  if (val instanceof Date && !isNaN(val.getTime())) {
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    const y = String(val.getFullYear());
    return `${m}/${d}/${y}`;
  }

  const str = String(val).trim();
  // Already MM/DD/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str;

  // M/D/YYYY
  const m1 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    return `${m1[1].padStart(2, '0')}/${m1[2].padStart(2, '0')}/${m1[3]}`;
  }

  // YYYY-MM-DD
  const m2 = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) {
    return `${m2[2].padStart(2, '0')}/${m2[3].padStart(2, '0')}/${m2[1]}`;
  }

  // Parseable date string
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    const y = String(parsed.getFullYear());
    return `${m}/${d}/${y}`;
  }

  return str;
}

/**
 * 1. Dropdown handler (native-select + custom-dropdown)
 * Opens control, scrapes visible options, fuzzy-matches (threshold >= 85), and clicks.
 */
export async function fillDropdown(page, field, resolvedValue, options = {}) {
  const threshold = options.threshold ?? 85;
  const target = String(resolvedValue || '').trim();
  if (!target) {
    return { success: false, reason: 'empty_resolved_value' };
  }

  const controlType = field.controlType || detectControlType(field);

  // 1a. Native <select> element
  if (controlType === 'native-select' || field.type === 'select-one') {
    try {
      const selectLocator = field.selector ? page.locator(field.selector).first() : null;
      if (selectLocator && await selectLocator.isVisible({ timeout: 1500 }).catch(() => false)) {
        const optionData = await selectLocator.evaluate((sel) => {
          return Array.from(sel.options || []).map((o) => ({
            value: o.value,
            text: (o.textContent || '').trim(),
          })).filter((o) => o.value !== '' && !/^select/i.test(o.text));
        }).catch(() => []);

        const match = findBestOptionMatch(target, optionData, threshold);
        if (match.matched && match.option) {
          await selectLocator.selectOption(match.option.value);
          return { success: true, actualValue: match.bestMatch, method: 'native-select' };
        }
      }
    } catch {
      // fallback to universal click below
    }
  }

  // 1b. Custom dropdown / combobox
  try {
    const trigger = await resolveDropdownTrigger(page, field);
    if (!trigger) {
      return { success: false, reason: 'dropdown_trigger_not_found' };
    }

    // Click trigger to open dropdown
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 2500, force: true }).catch(() => {});
    await page.waitForTimeout(options.openDelay ?? 80);

    // Scrape actually visible options from popup listbox
    const visibleOptions = await scrapeVisibleDropdownOptions(page);
    if (visibleOptions.length === 0) {
      // Try pressing ArrowDown in case clicking didn't expand listbox
      await page.keyboard.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(80);
    }

    const refreshedOptions = visibleOptions.length > 0
      ? visibleOptions
      : await scrapeVisibleDropdownOptions(page);

    const match = findBestOptionMatch(target, refreshedOptions, threshold);

    if (match.matched && match.option) {
      // Find element for bestMatch and click it
      const clicked = await clickDropdownOptionElement(page, match.bestMatch, match.option);
      if (clicked) {
        await page.waitForTimeout(options.settleDelay ?? 80);
        return {
          success: true,
          actualValue: match.bestMatch,
          matchedOption: match.bestMatch,
          score: match.bestScore,
          method: 'custom-dropdown',
        };
      }
    }

    // No matching option found or click failed — close dropdown without selecting
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(60);

    return {
      success: false,
      reason: 'no_matching_option',
      target,
      availableOptions: refreshedOptions.map((o) => o.text).slice(0, 20),
    };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => {});
    return { success: false, reason: `dropdown_error: ${err.message}` };
  }
}

/**
 * 2. Checkbox-group handler
 * Supports selecting one or more options; checks each matching box individually.
 */
export async function fillCheckboxGroup(page, field, resolvedValues, options = {}) {
  const threshold = options.threshold ?? 85;
  const targets = (Array.isArray(resolvedValues) ? resolvedValues : String(resolvedValues || '').split(/[,;\n]/))
    .map((v) => String(v).trim())
    .filter(Boolean);

  if (targets.length === 0) {
    return { success: false, reason: 'empty_checkbox_values' };
  }

  try {
    const container = await resolveFieldContainer(page, field);
    const scope = container || page;

    // Collect all checkboxes within this field/group
    const checkboxes = await scope.locator('input[type="checkbox"], [role="checkbox"]').all();
    if (checkboxes.length === 0) {
      return { success: false, reason: 'no_checkboxes_found' };
    }

    const checkboxData = [];
    for (const cb of checkboxes) {
      const text = await getCheckboxLabelText(cb);
      const isChecked = await cb.isChecked().catch(async () => {
        return (await cb.getAttribute('aria-checked')) === 'true';
      });
      checkboxData.push({ locator: cb, text, isChecked });
    }

    let checkedCount = 0;
    const matchedLabels = [];

    for (const target of targets) {
      const match = findBestOptionMatch(target, checkboxData, threshold);
      if (match.matched && match.option) {
        matchedLabels.push(match.bestMatch);
        if (!match.option.isChecked) {
          await match.option.locator.scrollIntoViewIfNeeded().catch(() => {});
          await match.option.locator.click({ timeout: 2000, force: true }).catch(() => {});
          match.option.isChecked = true;
          checkedCount++;
        }
      }
    }

    if (matchedLabels.length > 0) {
      return {
        success: true,
        actualValue: matchedLabels.join(', '),
        checkedCount,
        matchedLabels,
      };
    }

    return {
      success: false,
      reason: 'no_matching_checkbox_options',
      availableOptions: checkboxData.map((c) => c.text),
    };
  } catch (err) {
    return { success: false, reason: `checkbox_group_error: ${err.message}` };
  }
}

/**
 * 3. Radio-group handler
 * Single-select radio option click matching resolved value.
 */
export async function fillRadioGroup(page, field, resolvedValue, options = {}) {
  const threshold = options.threshold ?? 85;
  const target = String(resolvedValue || '').trim();
  if (!target) {
    return { success: false, reason: 'empty_radio_value' };
  }

  try {
    const container = await resolveFieldContainer(page, field);
    const scope = container || page;

    const radios = await scope.locator('input[type="radio"], [role="radio"]').all();
    if (radios.length === 0) {
      return { success: false, reason: 'no_radios_found' };
    }

    const radioData = [];
    for (const rb of radios) {
      const text = await getCheckboxLabelText(rb);
      const isChecked = await rb.isChecked().catch(async () => {
        return (await rb.getAttribute('aria-checked')) === 'true';
      });
      radioData.push({ locator: rb, text, isChecked });
    }

    const match = findBestOptionMatch(target, radioData, threshold);
    if (match.matched && match.option) {
      await match.option.locator.scrollIntoViewIfNeeded().catch(() => {});
      await match.option.locator.click({ timeout: 2000, force: true }).catch(() => {});
      await page.waitForTimeout(options.settleDelay ?? 50);
      return {
        success: true,
        actualValue: match.bestMatch,
        matchedOption: match.bestMatch,
        score: match.bestScore,
      };
    }

    return {
      success: false,
      reason: 'no_matching_radio_option',
      availableOptions: radioData.map((r) => r.text),
    };
  } catch (err) {
    return { success: false, reason: `radio_group_error: ${err.message}` };
  }
}

/**
 * 4. Date-picker handler
 * Types the value directly into the input / spinbuttons without clicking calendar widget.
 */
export async function fillDatePicker(page, field, resolvedValue, options = {}) {
  const formattedDate = formatToMMDDYYYY(resolvedValue);
  if (!formattedDate) {
    return { success: false, reason: 'invalid_date_format' };
  }

  const [month, day, year] = formattedDate.split('/');

  try {
    const container = await resolveFieldContainer(page, field);
    const scope = container || page;

    // 4a. Workday date spinbutton inputs (dateSectionMonth / Day / Year)
    const spinButtons = await scope.locator('input[role="spinbutton"], input[data-automation-id*="dateSection"]').all();
    if (spinButtons.length >= 2 && month && year) {
      for (const sp of spinButtons) {
        const hint = (
          (await sp.getAttribute('aria-label') || '') + ' ' +
          (await sp.getAttribute('data-automation-id') || '') + ' ' +
          (await sp.getAttribute('placeholder') || '')
        ).toLowerCase();

        if (/month|\bmm\b|datesectionmonth/i.test(hint)) {
          await sp.fill(month).catch(() => {});
        } else if (/day|\bdd\b|datesectionday/i.test(hint)) {
          if (day) await sp.fill(day).catch(() => {});
        } else if (/year|yyyy|datesectionyear/i.test(hint)) {
          await sp.fill(year).catch(() => {});
        }
      }

      await page.waitForTimeout(options.settleDelay ?? 50);
      return { success: true, actualValue: formattedDate, method: 'date-spinbuttons' };
    }

    // 4b. Standard input or date input
    const inputLocator = field.selector
      ? page.locator(field.selector).first()
      : scope.locator('input[type="date"], input[type="text"]').first();

    if (await inputLocator.isVisible({ timeout: 1500 }).catch(() => false)) {
      await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
      await inputLocator.click({ timeout: 1500 }).catch(() => {});
      await inputLocator.fill(formattedDate);
      await inputLocator.press('Tab').catch(() => {});
      await page.waitForTimeout(options.settleDelay ?? 50);
      return { success: true, actualValue: formattedDate, method: 'date-input' };
    }

    return { success: false, reason: 'date_input_not_found' };
  } catch (err) {
    return { success: false, reason: `date_picker_error: ${err.message}` };
  }
}

/**
 * 5. Free-text handler
 * Standard text input or textarea filling.
 */
export async function fillFreeText(page, field, resolvedValue, options = {}) {
  const valueStr = String(resolvedValue ?? '').trim();
  try {
    const inputLocator = field.selector
      ? page.locator(field.selector).first()
      : (field.automationId
        ? page.locator(`[data-automation-id="${field.automationId}"]`).first()
        : null);

    if (!inputLocator || !(await inputLocator.isVisible({ timeout: 1500 }).catch(() => false))) {
      const container = await resolveFieldContainer(page, field);
      const scope = container || page;
      const fallback = scope.locator('textarea, input[type="text"], input:not([type])').first();
      if (await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
        await fallback.scrollIntoViewIfNeeded().catch(() => {});
        await fallback.click().catch(() => {});
        await fallback.fill(valueStr);
        await fallback.dispatchEvent('change').catch(() => {});
        return { success: true, actualValue: valueStr };
      }
      return { success: false, reason: 'free_text_input_not_found' };
    }

    await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
    await inputLocator.click().catch(() => {});
    await inputLocator.fill(valueStr);
    await inputLocator.dispatchEvent('change').catch(() => {});
    return { success: true, actualValue: valueStr };
  } catch (err) {
    return { success: false, reason: `free_text_error: ${err.message}` };
  }
}

/**
 * Universal dispatcher routing to the proper fill handler by controlType.
 */
export async function dispatchFillHandler(page, field, resolvedValue, options = {}) {
  const controlType = field.controlType || detectControlType(field);
  switch (controlType) {
    case 'native-select':
    case 'custom-dropdown':
      return await fillDropdown(page, field, resolvedValue, options);
    case 'checkbox-group':
      return await fillCheckboxGroup(page, field, resolvedValue, options);
    case 'radio-group':
      return await fillRadioGroup(page, field, resolvedValue, options);
    case 'date-picker':
      return await fillDatePicker(page, field, resolvedValue, options);
    case 'free-text':
    default:
      return await fillFreeText(page, field, resolvedValue, options);
  }
}

// ─── DOM Helper functions ───────────────────────────────────────────────────

async function resolveDropdownTrigger(page, field) {
  if (field.selector) {
    const loc = page.locator(field.selector).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) return loc;
  }

  if (field.automationId) {
    const byAid = page.locator(`[data-automation-id="${field.automationId}"]`).first();
    if (await byAid.isVisible({ timeout: 800 }).catch(() => false)) return byAid;
  }

  const container = await resolveFieldContainer(page, field);
  if (container) {
    const btn = container.locator(
      'button[aria-haspopup="listbox"], [role="combobox"], [data-automation-id*="select"] button, button'
    ).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) return btn;
  }

  return null;
}

async function resolveFieldContainer(page, field) {
  if (field.wdQId) {
    const loc = page.locator(`[data-wd-q-id="${field.wdQId}"]`).first();
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) return loc;
  }
  if (field.automationId) {
    const loc = page.locator(`[data-automation-id="${field.automationId}"]`).first();
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) return loc;
  }
  if (field.selector) {
    const loc = page.locator(field.selector).first();
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) return loc;
  }
  return null;
}

async function scrapeVisibleDropdownOptions(page) {
  return await page.evaluate(() => {
    const optionNodes = Array.from(document.querySelectorAll(
      '[role="option"], [data-automation-id="promptOption"], [data-automation-id="select-item"], .select__option, [data-automation-id*="menuItem"]'
    ));

    return optionNodes.map((el, idx) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const value = el.getAttribute('data-value') || el.id || text;
      const isVisible = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
      return { index: idx, text, value, isVisible };
    }).filter((o) => o.isVisible && o.text && !/^select(\s+one)?\.?$/i.test(o.text));
  }).catch(() => []);
}

async function clickDropdownOptionElement(page, text, optionData) {
  // Method 1: Playwright getByRole option
  const roleLoc = page.getByRole('option', { name: text, exact: true }).first();
  if (await roleLoc.isVisible({ timeout: 800 }).catch(() => false)) {
    await roleLoc.click({ timeout: 1500, force: true }).catch(() => {});
    return true;
  }

  // Method 2: text filter
  const textLoc = page.locator('[role="option"], [data-automation-id="promptOption"], .select__option')
    .filter({ hasText: text }).first();
  if (await textLoc.isVisible({ timeout: 800 }).catch(() => false)) {
    await textLoc.click({ timeout: 1500, force: true }).catch(() => {});
    return true;
  }

  // Method 3: evaluate click by index
  if (typeof optionData?.index === 'number') {
    const clicked = await page.evaluate((idx) => {
      const nodes = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], .select__option'));
      const targetNode = nodes[idx];
      if (targetNode) {
        targetNode.click();
        return true;
      }
      return false;
    }, optionData.index).catch(() => false);
    if (clicked) return true;
  }

  return false;
}

async function getCheckboxLabelText(locator) {
  return await locator.evaluate((el) => {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel?.textContent?.trim()) return parentLabel.textContent.trim();
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    const parent = el.parentElement;
    if (parent) {
      const span = parent.querySelector('span, [class*="label"], [data-automation-id*="label"]');
      if (span?.textContent?.trim()) return span.textContent.trim();
    }
    return el.value || '';
  }).catch(() => '');
}
