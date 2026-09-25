import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBeforeFill } from './preFillValidator.mjs';
import { rememberVerified, contradictsVerified } from './memory.mjs';
import { runPageOrchestrator } from './pageLoop.mjs';
import { workdayAdapter } from './adapters/workdayAdapter.mjs';
import { STATUS } from './types.mjs';

const radioField = {
  questionId: 'q1',
  label: 'Are you legally authorized to work in the United States?',
  elementType: 'radio',
  fieldType: 'radio',
  required: true,
  options: ['Yes', 'No'],
  currentValue: null,
};

const yesDecision = {
  questionId: 'q1',
  intent: 'work_authorization',
  answer: 'Yes',
  confidence: 0.98,
  requiresReview: false,
  source: 'applywizz_profile',
  reasonCode: 'EXPLICIT_PROFILE_MATCH',
};

test('required identity and skills are fillable even when skip lists mention them', () => {
  assert.equal(workdayAdapter.shouldFill({
    label: 'Phone Number',
    required: true,
    elementType: 'tel',
    currentValue: '',
    _raw: { required: true, currentValue: '' },
  }, {}, 'My Information'), true);

  assert.equal(workdayAdapter.shouldFill({
    label: 'Given Name',
    required: true,
    elementType: 'text',
    currentValue: '',
    _raw: { required: true },
  }, {}, 'My Information'), true);

  assert.equal(workdayAdapter.shouldFill({
    label: 'Type to add skills',
    required: true,
    elementType: 'text',
    currentValue: '',
    _raw: { required: true },
  }, {}, 'My Experience'), true);

  assert.equal(workdayAdapter.shouldFill({
    label: 'Highest level of education completed',
    required: true,
    elementType: 'custom-dropdown',
    currentValue: '',
    _raw: { required: true },
  }, {}, 'My Experience'), true);

  assert.equal(workdayAdapter.shouldFill({
    label: 'Preferred name',
    required: false,
    elementType: 'text',
    currentValue: '',
  }, {}, 'My Information'), false);
});

test('pre-fill rejects missing id, missing answer, low confidence, and bad options', () => {
  assert.equal(validateBeforeFill({}, yesDecision).ok, false);
  assert.equal(validateBeforeFill(radioField, { ...yesDecision, answer: null, requiresReview: true }).reason, 'explicit_profile_match');
  assert.equal(validateBeforeFill(radioField, { ...yesDecision, answer: '', requiresReview: false }).ok, false);
  assert.equal(validateBeforeFill(radioField, { ...yesDecision, confidence: 0.4 }).reason, 'low_confidence');
  assert.equal(
    validateBeforeFill({ ...radioField, options: ['Decline', 'Not listed'] }, yesDecision).ok,
    false,
  );
});

test('pre-fill accepts a supported Yes on a live radio option', () => {
  const gate = validateBeforeFill(radioField, yesDecision, {});
  assert.equal(gate.ok, true);
  assert.equal(gate.answer, 'Yes');
});

test('verified memory contradiction blocks a later opposite answer', () => {
  const profile = {};
  rememberVerified(profile, {
    questionId: 'q1',
    intent: 'work_authorization',
    label: radioField.label,
    answer: 'Yes',
  });
  assert.equal(contradictsVerified(profile, 'work_authorization', 'No'), true);
  const gate = validateBeforeFill(radioField, { ...yesDecision, answer: 'No' }, profile);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'contradicts_verified_memory');
  rememberVerified(profile, { questionId: 'q-lic', intent: 'yes_no', label: "Do you have a driver's license?", answer: 'No' });
  assert.equal(contradictsVerified(profile, 'yes_no', 'Yes'), false);
});

test('required field uses profile fallback when the question engine asks for review', async () => {
  const store = { current: null };
  const phoneField = {
    questionId: 'q-phone',
    label: 'Phone Number',
    elementType: 'tel',
    required: true,
    options: [],
    currentValue: null,
  };
  const adapter = {
    name: 'fake',
    detectPage: async () => 'My Information',
    waitStable: async () => {},
    scan: async () => ({ fields: [{ ...phoneField, currentValue: store.current }] }),
    shouldFill: (field) => !store.current && field.questionId === 'q-phone',
    fill: async (_page, field, answer) => {
      store.current = answer;
      field.currentValue = answer;
      return { success: true, verifiedValue: answer };
    },
    readValue: async () => ({
      current: store.current,
      field: { ...phoneField, currentValue: store.current },
      all: [{ ...phoneField, currentValue: store.current }],
    }),
    valuesMatch: (requested, actual) => requested === actual,
    validatePage: async () => ({ ok: true, requiredRemaining: 0, errors: [] }),
  };

  const result = await runPageOrchestrator({
    page: {},
    profile: {
      qa_answers: {},
      _persistAnswers: false,
      _applyWizzHydrated: true,
      personal: { phone: '5550100' },
    },
    adapter,
    pageNumber: 1,
    answerFn: async () => ({
      answers: [{
        questionId: 'q-phone',
        intent: 'identity_phone',
        answer: null,
        confidence: 0,
        requiresReview: true,
        reasonCode: 'UNKNOWN_INFORMATION',
      }],
    }),
  });

  assert.equal(result.status, STATUS.PAGE_COMPLETE);
  assert.equal(store.current, '5550100');
});

test('orchestrator fills, verifies, and reports page_complete via a fake ATS adapter', async () => {
  const store = { current: null, extra: [] };
  const adapter = {
    name: 'fake',
    detectPage: async () => 'Application Questions',
    waitStable: async () => {},
    scan: async () => ({ fields: [{ ...radioField, currentValue: store.current }] }),
    shouldFill: (field) => !store.current && field.questionId === 'q1',
    fill: async (_page, field, answer) => {
      store.current = answer;
      field.currentValue = answer;
      return { success: true, verifiedValue: answer };
    },
    readValue: async () => ({
      current: store.current,
      field: { ...radioField, currentValue: store.current },
      all: [
        { ...radioField, currentValue: store.current },
        ...store.extra,
      ],
    }),
    valuesMatch: (requested, actual) => requested === actual,
    validatePage: async () => ({ ok: true, requiredRemaining: 0, errors: [] }),
  };

  const result = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter,
    stepName: 'Application Questions',
    pageNumber: 1,
    answerFn: async () => ({
      pageNumber: 1,
      answers: [yesDecision],
    }),
  });

  assert.equal(result.status, STATUS.PAGE_COMPLETE);
  assert.equal(result.filled, 1);
  assert.equal(result.verified, 1);
  assert.equal(store.current, 'Yes');
});

test('orchestrator returns structured blocked for high-risk review', async () => {
  const adapter = {
    name: 'fake',
    detectPage: async () => 'Application Questions',
    waitStable: async () => {},
    scan: async () => ({
      fields: [{
        questionId: 'q44',
        label: 'Do you currently hold an active security clearance?',
        elementType: 'radio',
        required: true,
        options: ['Yes', 'No'],
      }],
    }),
    shouldFill: () => true,
    fill: async () => ({ success: false }),
    readValue: async () => ({ current: '', field: null, all: [] }),
    valuesMatch: () => false,
    validatePage: async () => ({ ok: false, requiredRemaining: 1, errors: [] }),
  };

  const result = await runPageOrchestrator({
    page: {},
    profile: {},
    adapter,
    pageNumber: 3,
    answerFn: async () => ({
      pageNumber: 3,
      answers: [{
        questionId: 'q44',
        intent: 'clearance',
        answer: null,
        confidence: 0,
        requiresReview: true,
        reasonCode: 'AMBIGUOUS_QUESTION',
      }],
    }),
  });

  assert.equal(result.status, STATUS.BLOCKED);
  assert.equal(result.page, 3);
  assert.equal(result.questionId, 'q44');
  assert.equal(result.requiresReview, true);
});

test('verification mismatch is not treated as success', async () => {
  const adapter = {
    name: 'fake',
    detectPage: async () => 'Application Questions',
    waitStable: async () => {},
    scan: async () => ({ fields: [radioField] }),
    shouldFill: () => true,
    fill: async () => ({ success: true, verifiedValue: 'Yes' }),
    readValue: async () => ({ current: 'No', field: { ...radioField, currentValue: 'No' }, all: [radioField] }),
    valuesMatch: (requested, actual) => requested === actual,
    validatePage: async () => ({ ok: false, requiredRemaining: 1, errors: [], reason: 'required empty' }),
  };

  const result = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter,
    answerFn: async () => ({ pageNumber: 1, answers: [yesDecision] }),
  });

  assert.equal(result.status, STATUS.BLOCKED);
  assert.equal(result.reason, 'verification_failed');
  assert.equal(result.failed[0].reason, 'verification_failed');
});

test('orchestrator enforces guard cap of 2 attempts and refuses 3rd attempt on loop', async () => {
  let fillAttempts = 0;
  const testField = {
    questionId: 'q-loop-test',
    label: 'Do you have any relatives who work for our company?',
    elementType: 'radio',
    fieldType: 'radio',
    required: false,
    options: ['Yes', 'No'],
    currentValue: null,
  };

  const adapter = {
    name: 'fake',
    detectPage: async () => 'Application Questions',
    waitStable: async () => {},
    scan: async () => ({ fields: [testField] }),
    shouldFill: () => true,
    fill: async () => {
      fillAttempts += 1;
      return { success: true, verifiedValue: 'No' };
    },
    // Simulate verification failing to reflect target value
    readValue: async () => ({ current: '', field: { ...testField, currentValue: '' }, all: [testField] }),
    valuesMatch: () => false,
    validatePage: async () => ({ ok: false, requiredRemaining: 0, errors: [] }),
  };

  const decision = {
    questionId: 'q-loop-test',
    intent: 'prior_association',
    answer: 'No',
    confidence: 0.95,
    requiresReview: false,
    source: 'applywizz_profile',
    reasonCode: 'EXPLICIT_PROFILE_MATCH',
  };

  const result = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter,
    maxCycles: 5,
    answerFn: async () => ({ pageNumber: 1, answers: [decision] }),
  });

  // Verification that fillAttempts stopped at exactly 2 (MAX_FIELD_RETRIES = 2)
  assert.equal(fillAttempts, 2, `Total fill attempts must be capped at 2, got: ${fillAttempts}`);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'verification_failed');
});
