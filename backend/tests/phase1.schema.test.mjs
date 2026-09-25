import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiscoveredField, mapElementType } from '../lib/interaction/fieldSchema.mjs';
import { metric } from './helpers/metrics.mjs';

const REQUIRED_KEYS = [
  'questionId', 'label', 'description', 'elementType', 'controlType',
  'required', 'options', 'currentValue', 'disabled', 'visible',
  'pageNumber', 'locatorStrategy',
];

const CASES = [
  { name: 'text', raw: { label: 'First Name', fieldType: 'text', required: true } },
  { name: 'email', raw: { label: 'Email Address', fieldType: 'email', required: true } },
  { name: 'telephone', raw: { label: 'Phone Number', fieldType: 'tel' } },
  { name: 'number', raw: { label: 'Years of experience', fieldType: 'number' } },
  { name: 'textarea', raw: { label: 'Additional comments', fieldType: 'textarea', description: 'Optional notes' } },
  { name: 'date', raw: { label: 'Available start date', fieldType: 'date' } },
  { name: 'native select', raw: { label: 'Country', fieldType: 'select', nativeSelect: true, options: ['United States of America', 'Canada'], required: true } },
  { name: 'custom dropdown', raw: { label: 'Degree', fieldType: 'dropdown', options: ['Bachelor\'s', 'Master\'s'] } },
  { name: 'combobox', raw: { label: 'University', fieldType: 'combobox', options: ['Test University'] } },
  { name: 'custom combobox', raw: { label: 'Preferred work location', fieldType: 'typeahead', options: ['Remote', 'Hybrid', 'On-site'] } },
  { name: 'radio group', raw: { questionId: 'q1', label: 'Do you have experience with React?', fieldType: 'radio', required: true, options: ['Yes', 'No'] } },
  { name: 'checkbox', raw: { label: 'I agree to the terms', fieldType: 'checkbox' } },
  { name: 'multi-checkbox', raw: { label: 'Skills', fieldType: 'checkbox-group', options: ['React', 'Python'] } },
  { name: 'file upload', raw: { label: 'Resume', fieldType: 'file' } },
  { name: 'required field', raw: { label: 'City *', fieldType: 'text', required: true } },
  { name: 'optional field', raw: { label: 'Preferred name', fieldType: 'text', required: false } },
  { name: 'disabled field', raw: { label: 'Applicant ID', fieldType: 'text', disabled: true, currentValue: 'LOCKED' } },
  { name: 'hidden field', raw: { label: 'Hidden trap', fieldType: 'text', visible: false } },
  { name: 'dynamically appearing field', raw: { label: "Driver's license number", fieldType: 'text', required: true, visible: true } },
  { name: 'Workday-style custom control', raw: { label: 'Workday-style custom control', fieldType: 'select-one', wdQId: 'wdq-test', options: ['Option A', 'Option B'] } },
];

test('normalized fields include the interaction contract for every control type', () => {
  let ok = 0;
  for (const item of CASES) {
    const field = normalizeDiscoveredField(item.raw, { pageNumber: 1, stepName: 'Controls' });
    const missing = REQUIRED_KEYS.filter((k) => !(k in field));
    const typeOk = Boolean(field.elementType && field.controlType);
    const pass = missing.length === 0 && typeOk && Boolean(field.label);
    if (pass) ok += 1;
    metric('phase1', 'schema_field', pass, {
      detail: pass ? item.name : `${item.name} missing ${missing.join(',')}`,
      code: pass ? '' : 'F2',
    });
    assert.equal(missing.length, 0, `${item.name} missing ${missing.join(',')}`);
    assert.ok(field.locatorStrategy?.preferred);
    assert.ok(field.locatorStrategy?.fallbacks?.length);
  }
  metric('phase1', 'schema_suite', ok === CASES.length, { detail: `${ok}/${CASES.length}` });
});

test('example React radio normalizes to the documented shape', () => {
  const field = normalizeDiscoveredField({
    questionId: 'q1',
    label: 'Do you have experience with React?',
    fieldType: 'radio',
    required: true,
    options: ['Yes', 'No'],
  });
  assert.equal(field.questionId, 'q1');
  assert.equal(field.label, 'Do you have experience with React?');
  assert.equal(field.controlType, 'radio');
  assert.equal(field.required, true);
  assert.deepEqual(field.options, ['Yes', 'No']);
  metric('phase1', 'example_object', true);
});

test('mapElementType covers the supported widget families', () => {
  const pairs = [
    ['text', 'text'],
    ['email', 'email'],
    ['tel', 'tel'],
    ['number', 'number'],
    ['textarea', 'textarea'],
    ['date', 'date'],
    ['radio', 'radio'],
    ['checkbox', 'checkbox'],
    ['checkbox-group', 'multi-checkbox'],
    ['file', 'file'],
    ['dropdown', 'custom-dropdown'],
    ['combobox', 'custom-combobox'],
  ];
  for (const [from, to] of pairs) {
    const got = mapElementType(from, from === 'select' ? { nativeSelect: true } : {});
    const pass = got === to;
    metric('phase1', 'control_type', pass, { detail: `${from}->${got}`, code: pass ? '' : 'F2' });
    assert.equal(got, to);
  }
  assert.equal(mapElementType('select', { nativeSelect: true }), 'select');
  metric('phase1', 'control_type', true, { detail: 'native-select' });
});

test('required marker in the label is preserved', () => {
  const field = normalizeDiscoveredField({ label: 'City *', fieldType: 'text' });
  assert.equal(field.required, true);
  metric('phase1', 'required_detected', true);
});
