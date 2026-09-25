/**
 * Test-only ATS adapter for controlled HTML fixtures.
 * Same method names as workdayAdapter. Does not click Submit.
 */

import { scanFixtureFields, fixturePageTitle, fixtureVisibleErrors } from './scanFixture.mjs';
import { selectionMatchesAnswer } from '../../lib/workdayDefaults.mjs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const RESUME = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/empty-resume.txt');

export function createFixtureAdapter({ order = [], failFillOnce = false, alwaysFailFill = false, failValidate = false } = {}) {
  let fillAttempts = 0;

  return {
    name: 'fixture',
    async detectPage(page) {
      order.push('detect');
      return fixturePageTitle(page);
    },
    async waitStable(_page) {
      order.push('wait');
    },
    async scan(page, meta = {}) {
      order.push('scan');
      const fields = await scanFixtureFields(page, meta);
      return { fields };
    },
    shouldFill(field) {
      if (!field?.label) return false;
      if (field.disabled || field.visible === false) return false;
      if (field.elementType === 'button') return false;
      return true;
    },
    async fill(page, field, answer) {
      order.push('fill');
      fillAttempts += 1;
      if (alwaysFailFill) return { success: false, verifiedValue: '', reason: 'forced_fail' };
      if (failFillOnce && fillAttempts === 1) return { success: false, verifiedValue: '', reason: 'stale_once' };
      try {
        await fillFixtureControl(page, field, answer);
        return { success: true, verifiedValue: String(answer) };
      } catch (err) {
        return { success: false, verifiedValue: '', reason: String(err.message || err).slice(0, 120) };
      }
    },
    async readValue(page, field, meta = {}) {
      order.push('verify');
      const all = await scanFixtureFields(page, meta);
      const match = all.find((f) => f.questionId === field.questionId)
        || all.find((f) => f.label === field.label);
      return {
        current: match?.currentValue ?? '',
        field: match || null,
        all,
      };
    },
    valuesMatch(requested, actual) {
      if (requested == null) return false;
      if (String(requested) === String(actual)) return true;
      if (toInputValue('date', requested) && toInputValue('date', requested) === toInputValue('date', actual)) {
        return true;
      }
      return selectionMatchesAnswer(actual, requested);
    },
    async validatePage(page, _profile, _step) {
      order.push('validate');
      if (failValidate) {
        return { ok: false, requiredRemaining: 1, errors: ['forced validation error'], reason: 'visible_error' };
      }
      const errors = await fixtureVisibleErrors(page);
      const fields = await scanFixtureFields(page, {});
      const requiredEmpty = fields.filter((f) => f.required && !f.disabled && !(f.currentValue || '').trim());
      return {
        ok: errors.length === 0 && requiredEmpty.length === 0,
        requiredRemaining: requiredEmpty.length,
        errors,
        reason: errors[0] || (requiredEmpty.length ? 'required_empty' : ''),
      };
    },
  };
}

export async function fillFixtureControl(page, field, answer) {
  const label = String(field.label || '').replace(/\*+/g, '').trim();
  const type = field.elementType || field.controlType;

  if (type === 'file') {
    const input = page.locator('[data-automation-id*="formField"]').filter({ hasText: label }).locator('input[type="file"]');
    await input.setInputFiles(RESUME);
    return;
  }

  if (type === 'radio') {
    const group = page.locator('[data-automation-id*="formField"], [data-test-field]').filter({ hasText: label }).first();
    const byName = group.getByRole('radio', { name: new RegExp(`^${escapeRe(String(answer))}$`, 'i') });
    if (await byName.count()) {
      await byName.first().check({ timeout: 4000 });
      return;
    }
    await group.getByText(String(answer), { exact: true }).first().click({ timeout: 4000 });
    return;
  }

  if (type === 'checkbox') {
    const box = page.getByLabel(label, { exact: false });
    if (isTruthy(answer)) await box.check();
    else await box.uncheck();
    return;
  }

  if (type === 'multi-checkbox') {
    const values = String(answer).split(',').map((s) => s.trim()).filter(Boolean);
    const root = page.locator('[data-automation-id*="formField"], [data-test-field]').filter({ hasText: label }).first();
    for (const value of values) {
      await root.getByLabel(value, { exact: false }).check();
    }
    return;
  }

  if (type === 'select') {
    const select = page.getByLabel(label, { exact: false });
    await select.selectOption({ label: String(answer) }).catch(async () => {
      await select.selectOption({ value: String(answer) });
    });
    return;
  }

  if (type === 'custom-dropdown' || type === 'custom-combobox' || type === 'combobox') {
    const root = page.locator('[data-automation-id*="formField"], [data-test-field]').filter({ hasText: label }).first();
    const trigger = root.locator('button[aria-haspopup="listbox"], [role="combobox"]').first();
    await trigger.click({ timeout: 4000 });
    await root.getByRole('option', { name: String(answer), exact: true }).click({ timeout: 4000 });
    return;
  }

  const control = page.getByLabel(label, { exact: false });
  await control.fill(toInputValue(type, answer), { timeout: 4000 });
}

function toInputValue(type, answer) {
  const text = String(answer ?? '').trim();
  if (type === 'date') {
    const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return text;
  }
  return text;
}

function isTruthy(answer) {
  return /^(yes|true|1|on|checked)$/i.test(String(answer).trim());
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
