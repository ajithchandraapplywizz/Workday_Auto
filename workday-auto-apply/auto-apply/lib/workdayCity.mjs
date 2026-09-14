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
  return String(
    profile?.personal?.city
    || profile?.personal?.City
    || profile?.qa_answers?.city
    || profile?.qa_answers?.['address city']
    || ''
  ).trim();
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
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function cityValueMatches(actual, expected) {
  const a = String(actual || '').trim().toLowerCase();
  const e = String(expected || '').trim().toLowerCase();
  if (!a || !e) return false;
  return a === e || a.includes(e) || e.includes(a);
}

/**
 * Fill City by DOM label/id — verifies value stuck before returning success.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ success: boolean, value?: string, domValue?: string }>}
 */
export async function fillCityFromDom(page, profile = {}) {
  const city = resolveCityValue(profile);
  if (!city) {
    console.log('    ⚠️  No city value in profile or defaults.');
    return { success: false };
  }

  const current = await getCityInputValue(page);
  if (cityValueMatches(current, city)) {
    console.log(`    ✓ City already set in DOM: "${current}"`);
    return { success: true, value: current, domValue: current };
  }

  const filled = await page.evaluate((value) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const fire = (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const tryInput = (input) => {
      if (!input || input.disabled || input.readOnly) return false;
      input.focus();
      input.value = value;
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
  }, city);

  if (!filled) {
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
      await input.fill(city);
      await input.press('Tab').catch(() => {});
      break;
    }
  }

  await page.waitForTimeout(400);
  const domValue = await getCityInputValue(page);
  if (cityValueMatches(domValue, city)) {
    console.log(`    ✅ City DOM verified: "${domValue}"`);
    profile.personal = profile.personal || {};
    profile.personal.city = city;
    profile.qa_answers = profile.qa_answers || {};
    profile.qa_answers.city = city;
    return { success: true, value: city, domValue };
  }

  console.log(`    ⚠️  City fill failed — DOM shows: "${domValue || '(empty)'}" (wanted "${city}")`);
  return { success: false, value: city, domValue };
}

export { CITY_LABEL, WORKDAY_DEFAULT_CITY };
