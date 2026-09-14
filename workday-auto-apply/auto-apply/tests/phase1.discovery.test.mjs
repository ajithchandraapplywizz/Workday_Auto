import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverPage } from '../lib/interaction/pageDiscovery.mjs';
import { withLocalPage, openFixture } from './helpers/browser.mjs';
import { scanFixtureFields } from './helpers/scanFixture.mjs';
import { metric } from './helpers/metrics.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTROLS = resolve(ROOT, 'fixtures/controls.html');
const ROBUST = resolve(ROOT, 'fixtures/robustness.html');

const EXPECTED = [
  { key: 'first name', typeHint: /text/ },
  { key: 'email', typeHint: /email|text/ },
  { key: 'phone', typeHint: /tel|text/ },
  { key: 'years of professional', typeHint: /number|text/ },
  { key: 'additional comments', typeHint: /textarea|text/ },
  { key: 'available start date', typeHint: /date|text/ },
  { key: 'country', typeHint: /select|dropdown|custom/ },
  { key: 'degree', typeHint: /dropdown|select|combobox|custom/ },
  { key: 'university', typeHint: /combo|text|dropdown/ },
  { key: 'preferred work location', typeHint: /combo|dropdown|custom/ },
  { key: 'legally authorized', typeHint: /radio/ },
  { key: 'i agree to the terms', typeHint: /checkbox/ },
  { key: 'skills', typeHint: /checkbox|multi/ },
  { key: 'resume', typeHint: /file|text/ },
  { key: 'city', typeHint: /text/ },
  { key: 'preferred name', typeHint: /text/ },
  { key: 'applicant id', typeHint: /text/ },
  { key: "driver's license?", typeHint: /radio/ },
  { key: 'workday-style custom', typeHint: /dropdown|custom|select/ },
];

function findLabel(fields, key) {
  const k = key.toLowerCase();
  return fields.find((f) => String(f.label || '').toLowerCase().includes(k));
}

test('production discoverPage finds Workday-shaped fields by label, not by nth/XPath', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, CONTROLS);
    const snap = await discoverPage(page, { pageNumber: 1, stepName: 'Controls' });
    metric('phase1', 'total_fields', true, { count: EXPECTED.length });
    metric('phase1', 'fields_detected_count', true, { count: snap.fields.length });

    assert.ok(snap.fields.length > 0, 'discoverPage returned zero fields');

    let detected = 0;
    let typeOk = 0;
    let labels = 0;
    let options = 0;
    let required = 0;

    for (const item of EXPECTED) {
      const hit = findLabel(snap.fields, item.key);
      const ok = Boolean(hit);
      if (ok) {
        detected += 1;
        labels += 1;
        if (item.typeHint.test(String(hit.elementType || hit.controlType || ''))) typeOk += 1;
        if ((hit.options || []).length > 0) options += 1;
        if (hit.required) required += 1;
        assert.ok(hit.locatorStrategy, 'normalized field missing locator strategy');
      }
      metric('phase1', 'field_detected', ok, {
        detail: item.key,
        code: ok ? '' : 'F1',
      });
    }

    const honeypot = snap.fields.some((f) => /website|beecatcher/i.test(f.label));
    metric('phase1', 'hidden_filtered', !honeypot, { code: honeypot ? 'F1' : '' });
    assert.equal(honeypot, false, 'honeypot website field should not be discovered');

    metric('phase1', 'detection_accuracy', true, { rate: detected / EXPECTED.length, count: detected });
    metric('phase1', 'control_type_accuracy', true, { rate: typeOk / EXPECTED.length, count: typeOk });
    metric('phase1', 'labels_detected', true, { count: labels });
    metric('phase1', 'options_detected', true, { count: options });
    metric('phase1', 'required_detected', true, { count: required });
  });
});

test('fixture scanner associates labels with the correct controls', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, CONTROLS);
    const fields = await scanFixtureFields(page, { pageNumber: 1 });
    const email = findLabel(fields, 'email');
    const reactAuth = findLabel(fields, 'legally authorized');
    assert.ok(email);
    assert.match(email.elementType, /email|text/);
    assert.ok(reactAuth);
    assert.equal(reactAuth.elementType, 'radio');
    assert.ok(reactAuth.options.includes('Yes'));
    assert.ok(reactAuth.options.includes('No'));
    metric('phase1', 'label_association', true, { detail: 'email+work-auth' });
  });
});

test('labels still resolve after IDs, classes, nesting, and extra description change', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, ROBUST);
    const snap = await discoverPage(page, { pageNumber: 1 });
    const fixture = await scanFixtureFields(page, { pageNumber: 1 });
    const react = findLabel(snap.fields, 'experience with react') || findLabel(fixture, 'experience with react');
    const auth = findLabel(snap.fields, 'authorized to work') || findLabel(fixture, 'authorized to work');
    const reactOk = Boolean(react);
    const authOk = Boolean(auth);
    metric('phase1', 'robust_ids_classes', reactOk && authOk, {
      code: reactOk && authOk ? '' : 'F1',
      detail: `react=${reactOk} auth=${authOk} discovered=${snap.fields.length}`,
    });
    assert.ok(reactOk || authOk, 'neither robustness question was associated with a control');

    await page.getByLabel('Show optional question').check();
    const after = await scanFixtureFields(page, { pageNumber: 1 });
    const city = findLabel(after, 'city');
    metric('phase1', 'dynamic_optional_appear', Boolean(city), { code: city ? '' : 'F9' });
    assert.ok(city, 'optional City did not appear after toggle');
  });
});
