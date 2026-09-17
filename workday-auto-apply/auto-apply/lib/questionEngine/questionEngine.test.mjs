import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyQuestionIntent, intentsAreCompatible } from './intents.mjs';
import { mapToExactOption } from './optionMap.mjs';
import { resolveFieldWithoutLlm, resolveDynamicAnswer, answerPageQuestions } from './pageAnswerEngine.mjs';
import { REASON } from './answerRecord.mjs';
import { buildLlmDateContext } from '../date-utils.mjs';

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
    compensation: 'compensation' in over ? over.compensation : '90000',
    compensation_hourly: 'compensation_hourly' in over ? over.compensation_hourly : '50',
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

test('18+ age questions always Yes even when Apply Wizz or YAML cached No', () => {
  const prof = profile({
    qa: { 'are you over the age of 18': 'No' },
    qa_answers: { 'are you currently 18 years or older': 'No' },
    personal: { date_of_birth: '1999-01-15' },
  });
  const rec = resolveFieldWithoutLlm(field('Are you over the age of 18?*'), prof);
  assert.equal(rec.answer, 'Yes');
  assert.equal(rec.intent, 'minimum_age');
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

test('availability timing questions defer date-to-option mapping to the LLM path', () => {
  assert.equal(
    classifyQuestionIntent('How soon can you start?', { fieldType: 'dropdown' }),
    'availability',
  );
  const rec = resolveFieldWithoutLlm(
    {
      questionId: 'q-start-timing',
      label: 'How soon can you start?',
      elementType: 'dropdown',
      fieldType: 'dropdown',
      options: ['Immediately', '1 week', '2 weeks'],
      required: true,
    },
    profile({ qa: { 'how soon can you start': '09/01/2026' } }),
  );
  assert.equal(rec, null);
});

test('Playwright-shaped availability dropdown resolves to an exact option', async () => {
  const hit = await resolveDynamicAnswer(
    {
      questionId: 'q-start-timing-live',
      label: 'How soon can you start?',
      elementType: 'dropdown',
      fieldType: 'dropdown',
      options: ['Immediately', '1 week', '2 weeks', 'More than 4 weeks'],
      required: true,
    },
    profile({
      _desiredStartDate: '08/17/2026',
      qa: { 'how soon can you start': '08/17/2026' },
    }),
    { allowLlm: true },
  );
  assert.ok(hit);
  assert.ok(['Immediately', 'More than 4 weeks'].includes(hit.answer));
});

test('LLM date context compares past and future dates from the runtime date', () => {
  const referenceDate = new Date('2026-09-14T08:00:00Z');
  const context = buildLlmDateContext('UTC', referenceDate);
  assert.match(context, /Today's date is 09\/14\/2026 \(2026-09-14\)/);
  assert.match(context, /date before today means "Immediately"/);
  assert.match(context, /21\/09\/2026 from 14\/09\/2026 is "1 week"/);
});

test('Date Available to Work resolves to today not Flexible text', () => {
  const rec = resolveFieldWithoutLlm(
    field('Date Available to Work:', {
      elementType: 'date',
      fieldType: 'date',
      options: [],
      required: true,
    }),
    profile(),
  );
  assert.ok(rec);
  assert.match(rec.answer, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.notEqual(rec.answer, 'Flexible');
});

test('availability checkbox group remaps Supabase Yes to live shift labels', () => {
  const rec = resolveFieldWithoutLlm(
    field('Are you available to work:', {
      elementType: 'multi-checkbox',
      fieldType: 'checkbox-group',
      options: ['Days', 'Evenings', 'Weekends'],
      required: true,
    }),
    profile({ qa: { 'are you available to work': 'Yes' } }),
  );
  assert.ok(rec);
  assert.match(rec.answer, /Days/i);
  assert.equal(rec.requiresReview, false);
});

test('essential job functions question resolves Yes', () => {
  const rec = resolveFieldWithoutLlm(
    field('After reviewing the job description, can you perform the essential functions of the job, with or without a reasonable accommodation?', {
      elementType: 'radio',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      required: true,
    }),
    profile(),
  );
  assert.ok(rec);
  assert.equal(rec.answer, 'Yes');
});

test('shift question picks appropriate shift option from dropdown', () => {
  const rec = resolveFieldWithoutLlm(
    field('Which shift would you accept?', {
      elementType: 'dropdown',
      fieldType: 'dropdown',
      options: ['1st Shift', '2nd Shift', '3rd Shift', 'Any / All Shifts', 'Rotating'],
    }),
    profile(),
  );
  assert.ok(rec);
  assert.equal(rec.answer, 'Any / All Shifts');
  assert.equal(rec.requiresReview, false);
});

test('hourly compensation is derived from annual target compensation when hourly is unstated', () => {
  const p = profile({ compensation: '110000', compensation_hourly: null });
  const rec = resolveFieldWithoutLlm(
    field('What compensation are you targeting for this next career move (Hourly)?', {
      elementType: 'text',
      fieldType: 'text',
      options: [],
    }),
    p,
  );
  assert.ok(rec);
  assert.equal(rec.answer, '53');
  assert.equal(rec.requiresReview, false);
});

test('specific manager or location question resolves to N/A for text input and no preference for options', () => {
  const textRec = resolveFieldWithoutLlm(
    field('Is there a specific location or manager you would like your application to be considered with?', {
      elementType: 'text',
      fieldType: 'text',
      options: [],
    }),
    profile(),
  );
  assert.ok(textRec);
  assert.equal(textRec.answer, 'N/A');
  assert.equal(textRec.requiresReview, false);

  const optRec = resolveFieldWithoutLlm(
    field('Is there a specific location or manager you would like your application to be considered with?', {
      elementType: 'dropdown',
      fieldType: 'dropdown',
      options: ['Dallas, TX', 'Austin, TX', 'No Preference'],
    }),
    profile(),
  );
  assert.ok(optRec);
  assert.equal(optRec.answer, 'No Preference');
  assert.equal(optRec.requiresReview, false);
});

test('long electronic signature disclaimer resolves to full applicant name', () => {
  const disclaimer = 'Please read the following carefully and sign to acknowledge your understanding: '
    + 'I understand that my employment depends upon receiving a favorable investigative consumer report, '
    + 'consisting of at least a social security number verification, employment references and/or personal '
    + 'references, criminal history record check, Nurse Aide Registry Verification (if applicable), and '
    + 'passing the post job offer physical examination and drug test. Please sign (type name) and enter the date:';
  const rec = resolveFieldWithoutLlm(
    field(disclaimer, {
      elementType: 'text',
      fieldType: 'text',
      options: [],
    }),
    profile({ personal: { first_name: 'Naveen Kumar', last_name: 'Kondapalli' } }),
  );
  assert.ok(rec);
  assert.equal(rec.answer, 'Naveen Kumar Kondapalli');
  assert.equal(rec.requiresReview, false);
});

test('answerPageQuestions routes new required questions not answered by Tiers 1-3 to LLM path', async () => {
  const newQuestion = field('Are you comfortable working in a hybrid office environment 3 days per week?', {
    questionId: 'q-hybrid',
    elementType: 'dropdown',
    fieldType: 'dropdown',
    options: ['Yes', 'No'],
    required: true,
  });
  // Clean profile without pre-existing QA for this hybrid question
  const p = profile({ qa: {} });
  const pack = await answerPageQuestions([newQuestion], p);
  assert.ok(pack);
  assert.equal(pack.answers.length, 1);
  const ans = pack.answers[0];
  assert.equal(ans.questionId, 'q-hybrid');
  // It must be processed and either answered or reviewed with LLM source (Tier 4)
  assert.ok(['Yes', 'No'].includes(ans.answer) || ans.source === 'llm');
});
