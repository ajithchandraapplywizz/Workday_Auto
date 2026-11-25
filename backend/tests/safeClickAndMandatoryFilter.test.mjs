/**
 * safeClickAndMandatoryFilter.test.mjs
 * Comprehensive verification for:
 * 1. Disarming and blocking unwanted buttons (Add Another, Add More, bare Add, junk chrome)
 * 2. Strict filtering of non-required / optional fields
 * 3. Prevention of mis-clicks during form automation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRiskyMisclickButton,
  normalizeButtonName,
} from '../lib/safeClick.mjs';
import {
  hasRequiredSignal,
  isMandatoryField,
  isSkippableUnimportantLabel,
} from '../lib/scanFieldFilter.mjs';

test('isRiskyMisclickButton: strictly blocks all "Add Another" and unwanted variations', () => {
  const forbiddenButtons = [
    'Add Another',
    'Add another',
    '+ Add Another',
    '+ Add another',
    'Add another work experience',
    'Add another education',
    'Add Another Education',
    'Add More',
    '+ Add More',
    'Add additional',
    'Add extra',
    'Add a new',
    'Add row',
    '+ Add row',
    'Add',
    '+',
    '+ Add',
    'Add Certificate',
    'Add Language',
    'Add Skill',
    'Add Website',
    'Help',
    'Support',
    'Share',
    'Print',
    'Save for later',
    'Withdraw',
  ];

  for (const btn of forbiddenButtons) {
    assert.equal(
      isRiskyMisclickButton(btn),
      true,
      `Expected "${btn}" to be identified as risky misclick button`
    );
  }
});

test('isRiskyMisclickButton: allows wizard navigation controls', () => {
  const allowedNav = [
    'Save and Continue',
    'Save & Continue',
    'Next',
    'Continue',
    'Submit',
    'Submit Application',
    'Review and Submit',
    'Sign In',
  ];

  for (const btn of allowedNav) {
    assert.equal(
      isRiskyMisclickButton(btn),
      false,
      `Expected navigation button "${btn}" NOT to be blocked`
    );
  }
});

test('isRiskyMisclickButton: section add allowed ONLY when explicit and NEVER with "another"', () => {
  // When allowSectionAdd: true, only initial row expansion is allowed
  assert.equal(isRiskyMisclickButton('Add Work Experience', { allowSectionAdd: true }), false);
  assert.equal(isRiskyMisclickButton('+ Add Work Experience', { allowSectionAdd: true }), false);
  assert.equal(isRiskyMisclickButton('Add Education', { allowSectionAdd: true }), false);

  // Even with allowSectionAdd: true, "Add Another" MUST BE BLOCKED
  assert.equal(isRiskyMisclickButton('Add Another Work Experience', { allowSectionAdd: true }), true);
  assert.equal(isRiskyMisclickButton('Add another education', { allowSectionAdd: true }), true);
  assert.equal(isRiskyMisclickButton('Add Another', { allowSectionAdd: true }), true);
  assert.equal(isRiskyMisclickButton('+ Add More', { allowSectionAdd: true }), true);
});

test('hasRequiredSignal & isMandatoryField: ignores non-required and optional fields', () => {
  const optionalFields = [
    { label: 'Cover Letter (Optional)', field: { required: false } },
    { label: 'Additional Comments (not required)', field: { required: false } },
    { label: 'Middle Name', field: { required: false } },
    { label: 'Nickname', field: { required: false } },
    { label: 'Preferred Name', field: { required: false } },
    { label: 'LinkedIn URL (Optional)', field: { required: false } },
    { label: 'Portfolio Website', field: { required: false } },
    { label: 'Additional Information', field: { required: false } },
  ];

  for (const item of optionalFields) {
    assert.equal(
      hasRequiredSignal(item.label, item.field),
      false,
      `Expected "${item.label}" NOT to have required signal`
    );
    assert.equal(
      isMandatoryField(item.label, item.field),
      false,
      `Expected "${item.label}" NOT to be mandatory`
    );
    assert.equal(
      isSkippableUnimportantLabel(item.label, item.field),
      true,
      `Expected "${item.label}" to be skippable as unimportant`
    );
  }
});

test('hasRequiredSignal & isMandatoryField: strictly honors required signals', () => {
  const requiredFields = [
    { label: 'First Name *', field: { required: true, ariaRequired: true } },
    { label: 'Last Name', field: { ariaRequired: true } },
    { label: 'Are you authorized to work in the US? *', field: { required: true } },
  ];

  for (const item of requiredFields) {
    assert.equal(
      hasRequiredSignal(item.label, item.field),
      true,
      `Expected "${item.label}" to have required signal`
    );
    assert.equal(
      isMandatoryField(item.label, item.field),
      true,
      `Expected "${item.label}" to be mandatory`
    );
  }
});
