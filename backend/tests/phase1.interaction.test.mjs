import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { interactField } from '../lib/interaction/index.mjs';
import { normalizeDiscoveredField } from '../lib/interaction/fieldSchema.mjs';
import { withLocalPage, openFixture } from './helpers/browser.mjs';
import { scanFixtureFields } from './helpers/scanFixture.mjs';
import { fillFixtureControl } from './helpers/fixtureAdapter.mjs';
import { metric } from './helpers/metrics.mjs';

const CONTROLS = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/controls.html');
const RESUME = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/empty-resume.txt');

function byLabel(fields, re) {
  return fields.find((f) => re.test(f.label || ''));
}

async function verifyAndRescan(page, field, expected) {
  const after = await scanFixtureFields(page, { pageNumber: 1 });
  const next = after.find((f) => f.questionId === field.questionId) || byLabel(after, new RegExp(field.label.slice(0, 12), 'i'));
  const actual = next?.currentValue || '';
  const ok = String(actual).toLowerCase().includes(String(expected).toLowerCase())
    || String(expected).toLowerCase().includes(String(actual).toLowerCase());
  return { after, actual, ok, next };
}

test('Playwright can fill and verify each supported control on the fixture', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, CONTROLS);
    let fields = await scanFixtureFields(page, { pageNumber: 1 });

    const script = [
      { re: /first name/i, value: 'Test', type: 'text' },
      { re: /email address/i, value: 'test.user@example.test', type: 'email' },
      { re: /phone number/i, value: '5550100', type: 'telephone' },
      { re: /years of professional/i, value: '2', type: 'number' },
      { re: /additional comments/i, value: 'Fixture note', type: 'textarea' },
      { re: /available start date/i, value: '2026-10-01', type: 'date' },
      { re: /^country/i, value: 'United States of America', type: 'select' },
      { re: /^degree/i, value: 'B.Tech Computer Science', type: 'custom-dropdown' },
      { re: /preferred work location/i, value: 'Remote', type: 'combobox' },
      { re: /legally authorized/i, value: 'Yes', type: 'radio' },
      { re: /i agree to the terms/i, value: 'Yes', type: 'checkbox' },
      { re: /skills/i, value: 'React, Python', type: 'multi-checkbox' },
    ];

    for (const step of script) {
      const field = byLabel(fields, step.re);
      assert.ok(field, `missing ${step.type} field`);
      try {
        await fillFixtureControl(page, field, step.value);
        const checked = await verifyAndRescan(page, field, step.value.split(',')[0].trim());
        metric('phase1', 'interaction', checked.ok, { detail: step.type, code: checked.ok ? '' : 'F3' });
        metric('phase1', 'verification', checked.ok, { detail: step.type, code: checked.ok ? '' : 'F11' });
        assert.ok(checked.ok, `${step.type} verify failed: ${checked.actual}`);
        fields = checked.after;
      } catch (err) {
        metric('phase1', 'interaction', false, { detail: `${step.type}: ${err.message}`, code: 'F3' });
        throw err;
      }
    }

    const fileField = byLabel(fields, /resume/i);
    assert.ok(fileField);
    await page.locator('#resume').setInputFiles(RESUME);
    const fileName = await page.locator('#resume').evaluate((el) => el.files?.[0]?.name || '');
    const fileOk = /empty-resume/.test(fileName);
    metric('phase1', 'interaction', fileOk, { detail: 'file', code: fileOk ? '' : 'F3' });
    metric('phase1', 'verification', fileOk, { detail: 'file', code: fileOk ? '' : 'F11' });
    assert.ok(fileOk, `file input was ${fileName}`);

    await page.getByLabel('Yes', { exact: true }).nth(1).check().catch(async () => {
      await page.locator('#licYes').check();
    });
    fields = await scanFixtureFields(page, { pageNumber: 1 });
    const licenseNo = byLabel(fields, /license number/i);
    metric('phase1', 'dynamic_detection', Boolean(licenseNo), { code: licenseNo ? '' : 'F9' });
    assert.ok(licenseNo, 'license number did not appear after Yes');
  });
});

test('interactField fills a labeled text box and verifies the DOM value', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, CONTROLS);
    const field = normalizeDiscoveredField({
      label: 'First Name *',
      fieldType: 'text',
      required: true,
    });
    const result = await interactField(page, field, { answer: 'Ada', confidence: 0.95 });
    const value = await page.locator('#firstName').inputValue();
    const ok = result.success === true && value === 'Ada';
    metric('phase1', 'interactField_text', ok, { code: ok ? '' : 'F3', detail: `${result.reason || ''} actual=${value}` });
    assert.equal(value, 'Ada');
  });
});
