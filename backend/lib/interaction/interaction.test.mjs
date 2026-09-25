import test from 'node:test';
import assert from 'node:assert/strict';

import { mapElementType, normalizeDiscoveredField } from './fieldSchema.mjs';
import { validateAnswer } from './answerValidator.mjs';
import { fieldOperationLog } from './observe.mjs';

test('maps Workday widgets to interaction element types', () => {
  assert.equal(mapElementType('dropdown'), 'custom-dropdown');
  assert.equal(mapElementType('combobox'), 'custom-combobox');
  assert.equal(mapElementType('checkbox-group'), 'multi-checkbox');
  assert.equal(mapElementType('radio'), 'radio');
  assert.equal(mapElementType('textarea'), 'textarea');
  assert.equal(mapElementType('date'), 'date');
  assert.equal(mapElementType('select', { nativeSelect: true }), 'select');
});

test('normalized field keeps label, options, and raw locator ids', () => {
  const field = normalizeDiscoveredField({
    label: 'Are you legally authorized to work in the United States?',
    fieldType: 'radio',
    required: true,
    options: ['Yes', 'No'],
    currentValue: null,
    wdQId: 'wdq-abc',
  }, { pageNumber: 2, stepName: 'Application Questions' });

  assert.equal(field.questionId, 'wdq-abc');
  assert.equal(field.elementType, 'radio');
  assert.equal(field.required, true);
  assert.deepEqual(field.options, ['Yes', 'No']);
  assert.equal(field.pageNumber, 2);
  assert.equal(field.locatorStrategy.preferred, 'data-wd-q-id');
  assert.equal(field._raw.wdQId, 'wdq-abc');
});

test('validator never invents an option or accepts a null answer', () => {
  const field = {
    questionId: 'q123',
    label: 'Are you legally authorized to work in the United States?',
    elementType: 'radio',
    options: ['Yes', 'No'],
  };

  assert.equal(validateAnswer(field, null).status, 'requires_review');
  assert.equal(validateAnswer(field, { answer: null }).reason, 'unsafe_answer');
  assert.equal(validateAnswer(field, { answer: 'Maybe' }).ok, false);
  assert.equal(validateAnswer(field, { answer: 'Yes', confidence: 0.1 }).ok, false);
  assert.deepEqual(validateAnswer(field, { answer: 'Yes' }), {
    ok: true,
    answer: 'Yes',
    questionId: 'q123',
  });
});

test('operation log records requested vs actual', () => {
  const rec = fieldOperationLog({
    page: 2,
    questionId: 'q123',
    elementType: 'combobox',
    action: 'select',
    requestedValue: 'Yes',
    actualValue: 'Yes',
    verified: true,
    attempts: 1,
  });
  assert.equal(rec.verified, true);
  assert.equal(rec.requestedValue, 'Yes');
  assert.ok(rec.timestamp);
});
