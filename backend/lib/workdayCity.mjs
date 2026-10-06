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
 * Fill City by DOM label/id — verifies value stuck before returning success.
 * If city contains a gap / multiple words and initial fill fails, automatically retries without the gap ("BocaRaton").
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

  const attemptDomFill = async (val) => {
    return await page.evaluate((value) => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const fire = (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
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
      await input.press('Tab').catch(() => {});
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
      console.log(`    🏙️ Setting city in small letters: "${fillVal}"...`);
    }
    let filled = await attemptDomFill(fillVal);
    if (!filled) await attemptPlaywrightFill(fillVal);
    await page.waitForTimeout(400);
    domValue = await getCityInputValue(page);
    if (cityValueMatches(domValue, fillVal) || cityValueMatches(domValue, cityLower)) {
      console.log(`    ✅ City DOM verified: "${domValue}"`);
      profile.personal = profile.personal || {};
      profile.personal.city = domValue.toLowerCase();
      profile.qa_answers = profile.qa_answers || {};
      profile.qa_answers.city = domValue.toLowerCase();
      return { success: true, value: domValue.toLowerCase(), domValue };
    }
  }

  console.log(`    ⚠️  City fill failed — DOM shows: "${domValue || '(empty)'}" (wanted "${city}")`);
  return { success: false, value: city, domValue };
}

export { CITY_LABEL, WORKDAY_DEFAULT_CITY };
