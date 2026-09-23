import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuestionIntent, intentsAreCompatible } from '../lib/questionEngine/intents.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { mapToExactOption } from '../lib/questionEngine/optionMap.mjs';
import { REASON } from '../lib/questionEngine/answerRecord.mjs';
import { buildMockHydratedProfile } from './helpers/mockProfile.mjs';
import { metric } from './helpers/metrics.mjs';

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

const EQUIVALENT_REACT = [
  'Do you have experience with React?',
  'Have you worked with React.js?',
  'Are you familiar with React?',
];

test('equivalent React wording shares technology_experience intent', () => {
  const intents = EQUIVALENT_REACT.map((q) => classifyQuestionIntent(q));
  const same = intents.every((i) => i === 'technology_experience');
  metric('phase2', 'question_understood', same, { detail: intents.join(','), code: same ? '' : 'F4' });
  assert.deepEqual(intents, ['technology_experience', 'technology_experience', 'technology_experience']);
});

test('React yes/no is not the same question as React years', () => {
  const yn = classifyQuestionIntent('Do you have experience with React?');
  const years = classifyQuestionIntent('How many years of professional React experience do you have?');
  const distinct = yn !== years && !intentsAreCompatible(yn, years);
  metric('phase2', 'question_understood', distinct, {
    detail: `${yn} vs ${years}`,
    code: distinct ? '' : 'F4',
  });
  assert.equal(yn, 'technology_experience');
  assert.equal(years, 'technology_years_experience');
});

test('profile answering: explicit, semantic, memory, unknown, missing, ambiguous, high-risk, bad option, low confidence', () => {
  const profile = buildMockHydratedProfile({
    qa_answers: { 'are you legally authorized to work in the united states': 'Yes' },
  });

  const explicit = resolveFieldWithoutLlm(field('Email Address', { elementType: 'email', options: [] }), profile);
  metric('phase2', 'known_answered', explicit?.answer === 'test.user@applywizard.ai', { detail: 'explicit email' });
  assert.equal(explicit.answer, 'test.user@applywizard.ai');

  const semantic = resolveFieldWithoutLlm(field('Have you worked with React.js?'), profile);
  metric('phase2', 'known_answered', semantic?.answer === 'Yes', { detail: 'semantic react' });
  assert.equal(semantic.answer, 'Yes');
  assert.equal(semantic.requiresReview, false);

  const memory = resolveFieldWithoutLlm(field('Are you legally authorized to work in the United States?'), profile);
  metric('phase2', 'known_answered', memory?.answer === 'Yes', { detail: 'verified/existing work auth' });
  assert.equal(memory.answer, 'Yes');

  const unknown = resolveFieldWithoutLlm(field('Do you have experience with COBOL mainframes?'), profile);
  metric('phase2', 'unknown_analyzed', unknown?.requiresReview === true && unknown.answer == null, {
    detail: 'cobol',
    code: unknown?.answer ? 'F6' : '',
  });
  assert.equal(unknown.requiresReview, true);
  assert.equal(unknown.answer, null);

  const missingYears = resolveFieldWithoutLlm(
    field('How many years of professional React experience do you have?', {
      elementType: 'number',
      options: [],
    }),
    {
      ...profile,
      experience: { ...profile.experience, years: '' },
      _applyWizzQa: Object.fromEntries(Object.entries(profile._applyWizzQa || {}).filter(([k]) => !/experience|years/i.test(k))),
    },
  );
  metric('phase2', 'unsupported_flagged', missingYears?.requiresReview === true && missingYears.answer == null, {
    detail: 'react years',
    code: missingYears?.answer ? 'F6' : '',
  });
  assert.equal(missingYears.requiresReview, true);
  assert.equal(missingYears.answer, null);

  const highRisk = resolveFieldWithoutLlm(field('Do you currently hold an active security clearance?'), profile);
  metric('phase2', 'requires_review', highRisk?.requiresReview === true, { detail: 'clearance' });
  assert.equal(highRisk.requiresReview, true);

  const badOpt = mapToExactOption('Yes', ['Decline to self identify', 'Not listed'], 'radio');
  metric('phase2', 'option_mapping', badOpt.ok === false, { detail: 'no truthful option', code: badOpt.ok ? 'F7' : '' });
  assert.equal(badOpt.ok, false);
  assert.equal(badOpt.reasonCode, REASON.NO_VALID_OPTION);

  const low = resolveFieldWithoutLlm(field('Do you have experience with React?'), profile);
  metric('phase2', 'low_confidence', low?.confidence >= 0.7, { detail: 'react should be confident' });
  assert.ok(low.confidence >= 0.7);
});

test('option lists map to an exact live value', () => {
  const cases = [
    ['Yes', ['Yes', 'No'], 'radio'],
    ['Male', ['Male', 'Female', 'Prefer not to say'], 'radio'],
    ['Remote', ['Remote', 'Hybrid', 'On-site'], 'custom-dropdown'],
    ['2', ['None', 'Less than 1 year', '1-3 years', '3-5 years'], 'custom-dropdown'],
  ];
  for (const [answer, options, type] of cases) {
    const mapped = mapToExactOption(answer, options, type);
    const exact = mapped.ok && options.includes(mapped.answer);
    metric('phase2', 'option_mapping', exact, {
      detail: `${answer} -> ${mapped.answer || mapped.reasonCode}`,
      code: exact ? '' : 'F7',
    });
    if (answer === '2') {
      // Honest: a bare "2" may not map onto a year bucket. Do not invent a bucket.
      if (!mapped.ok) {
        assert.equal(mapped.reasonCode, REASON.NO_VALID_OPTION);
      } else {
        assert.ok(options.includes(mapped.answer));
      }
    } else {
      assert.equal(mapped.ok, true, `${answer} failed to map`);
      assert.ok(options.includes(mapped.answer));
    }
  }
});
