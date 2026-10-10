/**
 * workdayCity.mjs — Mandatory City field on My Information (wd5 / visa tenants)
 */

import { WORKDAY_DEFAULT_CITY } from './workdayDefaults.mjs';

const CITY_LABEL = 'City';

/**
 * Resolve city value from profile or defaults.
 * @param {object} profile
 * @returns {string}
 */
export function resolveCityValue(profile = {}) {
  const raw = String(
    profile?.personal?.city
    || profile?.personal?.City
    || profile?.qa_answers?.city
    || profile?.qa_answers?.['address city']
    || ''
  ).trim();
  return raw ? raw.toLowerCase() : '';
}

/**
 * Read the live City input value from the DOM.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function getCityInputValue(page) {
  return await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const directSelectors = [
      '#address--city',
      '[data-automation-id="address--city"]',
      'input[id*="address--city" i]',
      'input[data-automation-id*="city" i]',
      'input[name*="city" i]',
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'INPUT' && !el.disabled) {
        const v = norm(el.value);
        if (v) return v;
      }
    }

    for (const labelEl of document.querySelectorAll('label, legend, [data-automation-id*="label"]')) {
      const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
      if (!/^city$/i.test(labelText)) continue;

      const field = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement;
      if (!field) continue;

      const input = field.querySelector(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
      );
      if (input) return norm(input.value);
    }
    return '';
  });
}

/**
 * Robust matching between actual DOM value and expected city.
 * Supports matching even if two words have a gap in one and no gap in the other (e.g. "Boca Raton" vs "BocaRaton").
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function cityValueMatches(actual, expected) {
  const a = String(actual || '').trim().toLowerCase();
  const e = String(expected || '').trim().toLowerCase();
  if (!a || !e) return false;
  const aNoGap = a.replace(/\s+/g, '');
  const eNoGap = e.replace(/\s+/g, '');
  return a === e || aNoGap === eNoGap || a.includes(e) || e.includes(a) || aNoGap.includes(eNoGap) || eNoGap.includes(aNoGap);
}

/**
 * Check if the City field exists and whether it is marked required in the DOM.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ exists: boolean, required: boolean }>}
 */
export async function getCityFieldStatus(page) {
  return await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      '#address--city',
      '[data-automation-id="address--city"]',
      'input[id*="address--city" i]',
      'input[data-automation-id*="city" i]',
      'input[name*="city" i]',
    ];

    let cityInput = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'INPUT' && !el.disabled && el.type !== 'hidden') {
        cityInput = el;
        break;
      }
    }

    if (!cityInput) {
      for (const labelEl of document.querySelectorAll('label, legend, [data-automation-id*="label"]')) {
        const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
        if (!/^city$/i.test(labelText)) continue;

        const field = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement;
        if (!field) continue;

        const input = field.querySelector(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
        );
        if (input) {
          cityInput = input;
          break;
        }
      }
    }

    if (!cityInput) {
      return { exists: false, required: false };
    }

    // Check if required
    const container = cityInput.closest('[data-automation-id*="formField"]') || cityInput.parentElement;
    const isRequired = Boolean(
      cityInput.required ||
      cityInput.getAttribute('aria-required') === 'true' ||
      container?.getAttribute('aria-required') === 'true' ||
      container?.querySelector?.('.required, .asterisk, [aria-required="true"], abbr[title*="required" i], [data-automation-id*="required" i], [class*="required" i], [class*="asterisk" i], [class*="mandatory" i]') ||
      /\*/.test(container?.textContent?.slice(0, 50) || '')
    );

    return { exists: true, required: isRequired };
  }).catch(() => ({ exists: false, required: false }));
}

/**
 * Fill City by DOM label/id — verifies value stuck before returning success.
 * If city is not required and cannot be filled or found, skips cleanly without erroring or looping.
 * After filling the exact city, presses Enter to commit so Workday does not mark it as unfilled.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ success: boolean, value?: string, domValue?: string, skipped?: boolean }>}
 */
export async function fillCityFromDom(page, profile = {}) {
  // Check field status in DOM first
  const status = await getCityFieldStatus(page);
  if (!status.exists) {
    console.log('    ℹ️  City field not present on current step/DOM — skipping cleanly.');
    return { success: true, skipped: true };
  }

  const city = resolveCityValue(profile);
  if (!city) {
    if (!status.required) {
      console.log('    ℹ️  No city value in profile, but City is optional — skipping cleanly.');
      return { success: true, skipped: true };
    }
    console.log('    ⚠️  City is required but no city value found in profile or defaults.');
    return { success: false, skipped: false };
  }

  const current = await getCityInputValue(page);
  if (cityValueMatches(current, city)) {
    console.log(`    ✓ City already set in DOM: "${current}"`);
    return { success: true, value: current, domValue: current };
  }

  const attemptDomFill = async (val) => {
    return await page.evaluate((value) => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const fire = (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      const tryInput = (input) => {
        if (!input || input.disabled || input.readOnly) return false;
        input.focus();
        input.value = String(value || '').toLowerCase();
        fire(input);
        return norm(input.value).toLowerCase() === norm(value).toLowerCase();
      };

      const selectors = [
        '#address--city',
        '[data-automation-id="address--city"]',
        'input[id*="address--city" i]',
        'input[data-automation-id*="city" i]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && tryInput(el)) return true;
      }

      for (const labelEl of document.querySelectorAll('label, legend, [data-automation-id*="label"]')) {
        const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
        if (!/^city$/i.test(labelText)) continue;
        const field = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement;
        const input = field?.querySelector(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
        );
        if (input && tryInput(input)) return true;
      }
      return false;
    }, val);
  };

  const attemptPlaywrightFill = async (val) => {
    const locators = [
      page.locator('#address--city'),
      page.locator('[data-automation-id="address--city"]'),
      page.getByLabel(/^city$/i),
      page.locator('input[data-automation-id*="city" i]'),
    ];
    for (const loc of locators) {
      const input = loc.first();
      if (!(await input.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.click({ force: true }).catch(() => {});
      await input.fill(String(val || '').toLowerCase());
      
      // Press Enter to commit the city input and dismiss auto-suggest dropdown
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(200);

      // If Workday opened a suggestion dropdown or popup list, select or dismiss
      const dropdownOption = page.locator('[role="listbox"] [role="option"], [data-automation-id="menu-item"], ul[role="listbox"] li').first();
      if (await dropdownOption.isVisible({ timeout: 300 }).catch(() => false)) {
        await dropdownOption.click({ force: true }).catch(() => {});
      } else {
        await input.press('Tab').catch(() => {});
      }
      return true;
    }
    return false;
  };

  // 1. Try standard city in small letters only (all lowercase)
  const cityLower = city.toLowerCase();
  const mergedCity = cityLower.includes(' ') ? cityLower.replace(/\s+/g, '') : cityLower;
  const valuesToTry = [cityLower];
  if (mergedCity !== cityLower) {
    // Only as a secondary fallback if standard city fill fails
    valuesToTry.push(mergedCity);
  }

  let domValue = '';
  for (const fillVal of valuesToTry) {
    if (fillVal === mergedCity && fillVal !== cityLower) {
      console.log(`    🏙️ Fallback: Retrying city in small letters merged without spaces: "${fillVal}"...`);
    } else {
      console.log(`    🏙️ Setting city in small letters: "${fillVal}" (and pressing Enter)...`);
    }
    let filled = await attemptPlaywrightFill(fillVal);
    if (!filled) filled = await attemptDomFill(fillVal);
    await page.waitForTimeout(400);
    domValue = await getCityInputValue(page);
    if (cityValueMatches(domValue, fillVal) || cityValueMatches(domValue, cityLower)) {
      console.log(`    ✅ City DOM verified and committed: "${domValue}"`);
      profile.personal = profile.personal || {};
      profile.personal.city = domValue.toLowerCase();
      profile.qa_answers = profile.qa_answers || {};
      profile.qa_answers.city = domValue.toLowerCase();
      return { success: true, value: domValue.toLowerCase(), domValue };
    }
  }

  if (!status.required) {
    console.log(`    ℹ️  City could not be fully verified but is NOT required (DOM: "${domValue || '(empty)'}") — skipping cleanly.`);
    return { success: true, skipped: true, value: city, domValue };
  }

  console.log(`    ⚠️  City fill failed — DOM shows: "${domValue || '(empty)'}" (wanted "${city}")`);
  return { success: false, value: city, domValue, skipped: false };
}

export { CITY_LABEL, WORKDAY_DEFAULT_CITY };
