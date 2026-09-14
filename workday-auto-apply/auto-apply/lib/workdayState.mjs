/**
 * workdayState.mjs — Mandatory State / Province field on My Information
 */

import { getTenantExperienceOverrides } from './tenantQuestionYaml.mjs';

export const STATE_LABEL = 'State';
export const WORKDAY_DEFAULT_STATE = 'California';

/**
 * Resolve state/province value from tenant YAML, profile, or default.
 * @param {object} profile
 * @param {string} [tenant]
 * @returns {string}
 */
export function resolveStateValue(profile = {}, tenant = '') {
  const tenantKey = String(tenant || profile?._tenant || '').trim().toLowerCase();
  try {
    const exp = getTenantExperienceOverrides(tenantKey);
    // personal block is on tenant doc — fall through to profile
  } catch {}

  // Tenant YAML may expose personal via profile merge elsewhere; prefer profile.
  const fromTenantPersonal = profile?.personal?.state
    || profile?.personal?.State
    || profile?.personal?.province
    || profile?.qa_answers?.state
    || profile?.qa_answers?.['state / province']
    || profile?.qa_answers?.province;

  return String(fromTenantPersonal || WORKDAY_DEFAULT_STATE).trim();
}

/**
 * Read live State/Province control text from the DOM.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function getStateDomValue(page) {
  return await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      '#address--countryRegion',
      '#address--countryRegion--countryRegion',
      '[data-automation-id="address--countryRegion"]',
      '[data-automation-id*="countryRegion" i]',
      'button[id*="countryRegion" i]',
      'input[id*="countryRegion" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const v = norm(el.value || el.textContent || el.getAttribute('value') || '');
      if (v && !/^select/i.test(v) && v !== '–' && v !== '-') return v;
    }
    for (const labelEl of document.querySelectorAll('label, legend, [data-automation-id*="label"]')) {
      const labelText = norm(labelEl.textContent).replace(/\*+$/, '');
      if (!/^(state|province|state\/province|state \/ province)$/i.test(labelText)) continue;
      const field = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement;
      if (!field) continue;
      const button = field.querySelector('[data-automation-id="selectOneWidget"], button, [role="combobox"]');
      if (button) {
        const v = norm(button.textContent || button.getAttribute('aria-label') || '');
        if (v && !/^select/i.test(v)) return v;
      }
      const input = field.querySelector('input:not([type="hidden"])');
      if (input) {
        const v = norm(input.value);
        if (v) return v;
      }
    }
    return '';
  });
}

/**
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function stateValueMatches(actual, expected) {
  const a = String(actual || '').trim().toLowerCase();
  const e = String(expected || '').trim().toLowerCase();
  if (!a || !e) return false;
  return a === e || a.includes(e) || e.includes(a);
}

/**
 * Fill State/Province via DOM (dropdown or text) and verify.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<{ success: boolean, value?: string, domValue?: string }>}
 */
export async function fillStateFromDom(page, profile = {}) {
  const state = resolveStateValue(profile, profile?._tenant);
  if (!state) {
    console.log('    ⚠️  No state value in profile or defaults.');
    return { success: false };
  }

  const current = await getStateDomValue(page);
  if (stateValueMatches(current, state)) {
    console.log(`    ✓ State already set in DOM: "${current}"`);
    return { success: true, value: current, domValue: current };
  }

  // Try Playwright label-based dropdown / text fill
  try {
    const combobox = page.getByRole('combobox', { name: /state|province/i }).first();
    if (await combobox.isVisible({ timeout: 800 }).catch(() => false)) {
      await combobox.click({ force: true });
      await page.waitForTimeout(300);
      const option = page.getByRole('option', { name: new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
      if (await option.isVisible({ timeout: 1500 }).catch(() => false)) {
        await option.click({ force: true });
      } else {
        await page.keyboard.type(state, { delay: 40 });
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(400);
    } else {
      const input = page.getByLabel(/^state|province|state \/ province$/i).first();
      if (await input.isVisible({ timeout: 800 }).catch(() => false)) {
        await input.click({ force: true });
        await input.fill(state);
        await input.press('Tab').catch(() => {});
      } else {
        // data-automation fallbacks
        const locators = [
          page.locator('[data-automation-id="address--countryRegion"]'),
          page.locator('#address--countryRegion'),
          page.locator('[data-automation-id*="countryRegion" i]').first(),
        ];
        for (const loc of locators) {
          if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
          await loc.click({ force: true });
          await page.waitForTimeout(250);
          const opt = page.getByRole('option', { name: new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
          if (await opt.isVisible({ timeout: 1200 }).catch(() => false)) {
            await opt.click({ force: true });
          } else {
            await page.keyboard.type(state, { delay: 40 });
            await page.keyboard.press('Enter');
          }
          break;
        }
      }
    }
  } catch (err) {
    console.log(`    ⚠️  State fill attempt error: ${String(err.message || err).slice(0, 100)}`);
  }

  await page.waitForTimeout(400);
  const domValue = await getStateDomValue(page);
  if (stateValueMatches(domValue, state)) {
    console.log(`    ✅ State DOM verified: "${domValue}"`);
    profile.personal = profile.personal || {};
    profile.personal.state = state;
    profile.qa_answers = profile.qa_answers || {};
    profile.qa_answers.state = state;
    return { success: true, value: state, domValue };
  }

  console.log(`    ⚠️  State not verified in DOM (wanted "${state}", got "${domValue || '(empty)'}")`);
  return { success: false, value: state, domValue };
}
