import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoRecordVerifiedFieldAnswer,
  recordSupabaseAnswerInMemory,
  lookupSupabaseAnswerSync,
} from '../lib/supabaseClient.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { validateBeforeFill } from '../lib/orchestrator/preFillValidator.mjs';

function makeProfile(overrides = {}) {
  return {
    _applyWizzId: 'AWL-TEST-12345',
    _applyWizzHydrated: true,
    _supabaseQa: { ...(overrides.supabaseQa || {}) },
    qa_answers: {},
    personal: {
      first_name: 'Test',
      last_name: 'Candidate',
      email: 'test@example.com',
      date_of_birth: '2000-01-01',
      ...(overrides.personal || {}),
    },
    ...(overrides || {}),
  };
}

function makeField(label, extras = {}) {
  return {
    questionId: extras.questionId || 'q-test-1',
    label,
    elementType: extras.elementType || 'dropdown',
    controlType: extras.controlType || extras.elementType || 'dropdown',
    fieldType: extras.fieldType || extras.elementType || 'dropdown',
    options: extras.options || ['Yes', 'No'],
    required: extras.required !== false,
  };
}

test('autoRecordVerifiedFieldAnswer stores answer in-memory and de-duplicates', async () => {
  const prof = makeProfile();
  const field = makeField('Do you have experience leading agile development teams?*', {
    elementType: 'dropdown',
    options: ['Yes', 'No'],
  });

  // 1. Initial record
  const recorded = await autoRecordVerifiedFieldAnswer(prof, field, 'Yes', { source: 'verified' });
  assert.equal(recorded, true);

  // In-memory cache should be updated immediately
  const normKey = 'do you have experience leading agile development teams';
  assert.equal(prof._supabaseQa[normKey], 'Yes');

  // 2. Duplicate record attempt: should detect duplicate and return true without error
  const duplicate = await autoRecordVerifiedFieldAnswer(prof, field, 'Yes', { source: 'verified' });
  assert.equal(duplicate, true);
});

test('autoRecordVerifiedFieldAnswer ignores transient signature dates', async () => {
  const prof = makeProfile();
  const dateField = makeField('Please enter today\'s date (MM/DD/YYYY)*', {
    elementType: 'date',
  });

  const recorded = await autoRecordVerifiedFieldAnswer(prof, dateField, '09/24/2026', { source: 'deterministic' });
  assert.equal(recorded, false, 'Transient signature dates must never be saved as static client answers');
  assert.equal(Object.keys(prof._supabaseQa).length, 0);
});

test('resolveFieldWithoutLlm instantly resolves recorded questions from Supabase cache', () => {
  const prof = makeProfile({
    supabaseQa: {
      'how many days per week are you willing to work in office': '3 days',
      'have you ever worked for our company before': 'No',
    },
  });

  const officeField = makeField('How many days per week are you willing to work in office?*', {
    questionId: 'q-office-days',
    elementType: 'custom-dropdown',
    controlType: 'custom-dropdown',
    options: ['1 day', '2 days', '3 days', '5 days'],
  });

  const decision = resolveFieldWithoutLlm(officeField, prof);
  assert.ok(decision, 'Expected question to resolve immediately from cached answer');
  assert.equal(decision.answer, '3 days');
  assert.equal(decision.source, 'supabase');
  assert.equal(decision.requiresReview, false);
  assert.ok(decision.confidence >= 0.95);

  const preFill = validateBeforeFill(officeField, decision, prof);
  assert.equal(preFill.ok, true, `preFillValidator should pass: ${JSON.stringify(preFill)}`);
  assert.equal(preFill.answer, '3 days');
});

test('resolveFieldWithoutLlm matches dropdown options via fuzzy/tokenSet matching', () => {
  const prof = makeProfile({
    supabaseQa: {
      'please select your gender': 'Male',
    },
  });

  const genderField = makeField('Gender*', {
    questionId: 'q-gender',
    elementType: 'radio',
    controlType: 'radio-group',
    options: ['Male', 'Female', 'I choose not to self-identify'],
  });

  const decision = resolveFieldWithoutLlm(genderField, prof);
  assert.ok(decision, 'Expected gender question to resolve from cache');
  assert.equal(decision.answer, 'Male');
  assert.equal(decision.requiresReview, false);

  const preFill = validateBeforeFill(genderField, decision, prof);
  assert.equal(preFill.ok, true);
  assert.equal(preFill.answer, 'Male');
});
