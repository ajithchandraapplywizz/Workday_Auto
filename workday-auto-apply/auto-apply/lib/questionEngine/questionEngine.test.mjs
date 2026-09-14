import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyQuestionIntent, intentsAreCompatible } from './intents.mjs';
import { mapToExactOption } from './optionMap.mjs';
import { resolveFieldWithoutLlm, resolveDynamicAnswer } from './pageAnswerEngine.mjs';
import { REASON } from './answerRecord.mjs';

function field(label, extras = {}) {
  return {
    questionId: extras.questionId || 'q1',
    label,
    elementType: extras.elementType || 'radio',
    fieldType: extras.fieldType || extras.elementType || 'radio',
    options: extras.options || ['Yes', 'No'],
    required: extras.required !== false,
  };
}

function profile(over = {}) {
  return {
    _applyWizzHydrated: true,
    _applyWizzQa: over.qa || {},
    personal: { first_name: 'Ajith', last_name: 'Test', email: 'a@example.com', city: 'Hyderabad', ...(over.personal || {}) },
    work_auth: { authorized_us: 'Yes', sponsorship_needed: 'Yes', ...(over.work_auth || {}) },
    experience: { years: '5', current_title: 'AI/ML Engineer', current_company: 'Student spot', ...(over.experience || {}) },
    education: { degree: "Bachelor's", university: 'Other', major: 'Computer Science', ...(over.education || {}) },
    eeo: {},
    skills: over.skills || ['Python', 'React', 'Node.js'],
    compensation: over.compensation ?? '90000',
    compensation_hourly: over.compensation_hourly ?? '50',
    qa_answers: over.qa_answers || {},
  };
}

test('equivalent work-auth wording shares intent; sponsorship stays distinct', () => {
  assert.equal(
    classifyQuestionIntent('Are you legally authorized to work in the United States?'),
    'work_authorization',
  );
  assert.equal(
    classifyQuestionIntent('Do you currently have authorization to work in the U.S.?'),
    'work_authorization',
  );
  assert.equal(
    classifyQuestionIntent('Will you now or in the future require sponsorship?'),
    'sponsorship',
  );
  assert.equal(
    classifyQuestionIntent('Do you require employer sponsorship to obtain or maintain work authorization?'),
    'sponsorship',
  );
  assert.equal(
    intentsAreCompatible('work_authorization', 'sponsorship'),
    false,
  );
});

test('React yes/no and React years are different intents', () => {
  assert.equal(classifyQuestionIntent('Do you have experience with React?'), 'technology_experience');
  assert.equal(classifyQuestionIntent('How many years have you worked with React?'), 'technology_years_experience');
  assert.equal(intentsAreCompatible('technology_experience', 'technology_years_experience'), false);
});

test('explicit profile work-auth maps to the live Yes option', () => {
  const rec = resolveFieldWithoutLlm(
    field('Are you legally authorized to work in the United States?', { options: ['Yes', 'No'] }),
    profile(),
  );
  assert.equal(rec.answer, 'Yes');
  assert.equal(rec.requiresReview, false);
  assert.equal(rec.source, 'applywizz_profile');
  assert.equal(rec.reasonCode, REASON.EXPLICIT_PROFILE_MATCH);
  assert.ok(rec.confidence >= 0.95);
});

test('differently worded equivalent work-auth still uses the profile Yes', () => {
  const rec = resolveFieldWithoutLlm(
    field('Do you currently have authorization to work in the U.S.?'),
    profile(),
  );
  assert.equal(rec.answer, 'Yes');
  assert.equal(rec.requiresReview, false);
});

test('unknown technology without profile mention requires review — no invented Yes', () => {
  const rec = resolveFieldWithoutLlm(
    field('Do you have experience with COBOL mainframes?'),
    profile({ skills: ['Python'] }),
  );
  assert.equal(rec.requiresReview, true);
  assert.equal(rec.answer, null);
  assert.equal(rec.reasonCode, REASON.UNKNOWN_INFORMATION);
});

test('ambiguous / missing high-risk sponsorship without a stored fact requires review', () => {
  const rec = resolveFieldWithoutLlm(
    field('Do you require employer sponsorship to obtain or maintain work authorization?'),
    profile({ work_auth: { authorized_us: 'Yes', sponsorship_needed: '' } }),
  );
  assert.equal(rec.requiresReview, true);
  assert.equal(rec.reasonCode, REASON.HIGH_RISK_MISSING_DATA);
});

test('clearance is high-risk and is not guessed', () => {
  const rec = resolveFieldWithoutLlm(field('Do you currently hold an active security clearance?'), profile());
  assert.equal(rec.requiresReview, true);
  assert.equal(rec.reasonCode, REASON.HIGH_RISK_MISSING_DATA);
});

test('required government employment and prior-agreement selects resolve to No', () => {
  const gov = resolveFieldWithoutLlm(
    field('5. U.S. Federal Government EmploymentVarious federal laws restrict hiring.', {
      elementType: 'custom-dropdown',
      options: ['Yes', 'No'],
    }),
    profile(),
  );
  assert.equal(gov.answer, 'No');
  assert.equal(gov.requiresReview, false);

  const agreement = resolveFieldWithoutLlm(
    field('Have you entered into any agreement in connection with a prior employer?', {
      elementType: 'custom-dropdown',
      options: ['Yes', 'No'],
    }),
    profile(),
  );
  assert.equal(agreement.answer, 'No');
});

test('dropdown option mapping uses the exact live option', () => {
  const rec = resolveFieldWithoutLlm(
    field('Are you legally authorized to work in the United States?', {
      elementType: 'custom-dropdown',
      options: ['Yes', 'No'],
    }),
    profile(),
  );
  assert.equal(rec.answer, 'Yes');
  assert.equal(rec.answerType, 'dropdown');
});

test('radio option mapping', () => {
  const mapped = mapToExactOption('Yes', ['Yes', 'No'], 'radio');
  assert.equal(mapped.ok, true);
  assert.equal(mapped.answer, 'Yes');
});

test('checkbox / yes-no maps to the live option text', () => {
  const mapped = mapToExactOption('Yes', ['Yes, I agree', 'No'], 'checkbox');
  assert.equal(mapped.ok, true);
  assert.equal(mapped.answer, 'Yes, I agree');
});

test('text identity uses explicit profile email', () => {
  const rec = resolveFieldWithoutLlm(
    { questionId: 'q-email', label: 'Email Address', elementType: 'email', fieldType: 'text', options: [], required: true },
    profile(),
  );
  assert.equal(rec.answer, 'a@example.com');
  assert.equal(rec.requiresReview, false);
});

test('number years of total experience uses explicit profile years', () => {
  const rec = resolveFieldWithoutLlm(
    {
      questionId: 'q-years',
      label: 'How many years of professional work experience do you have?',
      elementType: 'number',
      fieldType: 'text',
      options: [],
      required: true,
    },
    profile(),
  );
  assert.equal(rec.answer, '5');
  assert.equal(rec.intent, 'years_experience');
  assert.equal(rec.requiresReview, false);
});

test('has React experience but no years number → review, do not invent years', () => {
  const rec = resolveFieldWithoutLlm(
    {
      questionId: 'q-react-years',
      label: 'How many years have you worked with React?',
      elementType: 'number',
      fieldType: 'text',
      options: [],
      required: true,
    },
    profile({ experience: { years: '', current_title: 'Engineer' }, skills: ['React'] }),
  );
  assert.equal(rec.intent, 'technology_years_experience');
  assert.equal(rec.requiresReview, true);
  assert.equal(rec.answer, null);
});

test('no truthful option on the list → review', () => {
  const mapped = mapToExactOption('Yes', ['Decline to self identify', 'Not listed'], 'radio');
  assert.equal(mapped.ok, false);
  assert.equal(mapped.reasonCode, REASON.NO_VALID_OPTION);
});

test('React yes/no can be answered when the profile lists React', () => {
  const rec = resolveFieldWithoutLlm(
    field('Do you have experience with React?'),
    profile({ skills: ['React', 'Python'] }),
  );
  assert.equal(rec.answer, 'Yes');
  assert.equal(rec.requiresReview, false);
  assert.equal(rec.reasonCode, REASON.SEMANTIC_PROFILE_MATCH);
});

test('resolveDynamicAnswer uses intent + validation for DOM-shaped dropdowns', async () => {
  const hit = await resolveDynamicAnswer(
    {
      label: 'Have you entered into any agreement in connection with a prior employer?',
      fieldType: 'dropdown',
      options: [{ text: 'Yes' }, { text: 'No' }],
      required: true,
    },
    profile(),
    { allowLlm: false },
  );
  assert.ok(hit);
  assert.equal(hit.answer, 'No');
  assert.equal(hit.intent, 'yes_no');
});
