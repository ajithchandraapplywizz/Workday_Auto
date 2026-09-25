import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { classifyQuestionIntent } from '../lib/questionEngine/intents.mjs';
import { metric } from './helpers/metrics.mjs';

const EMPTY = {
  _applyWizzHydrated: true,
  _applyWizzQa: {},
  personal: {},
  work_auth: {},
  education: {},
  experience: {},
  eeo: {},
  skills: [],
  qa_answers: {},
};

function field(label, extras = {}) {
  return {
    questionId: extras.id || 'q',
    label,
    elementType: extras.elementType || 'radio',
    fieldType: extras.elementType || 'radio',
    options: extras.options || ['Yes', 'No'],
    required: true,
  };
}

function mustNotInvent(label, extras = {}) {
  const rec = resolveFieldWithoutLlm(field(label, extras), EMPTY);
  const invented = Boolean(rec && rec.requiresReview !== true && rec.answer);
  const flagged = rec == null || rec.requiresReview === true || rec.answer == null;
  metric('phase2', 'fabricated_answer', !invented, {
    detail: label,
    code: invented ? 'F6' : '',
  });
  metric('phase2', 'requires_review', flagged, { detail: label });
  assert.equal(invented, false, `invented "${rec?.answer}" for ${label}`);
  return rec;
}

test('engine refuses to fabricate high-risk or missing personal facts', () => {
  mustNotInvent('Are you legally authorized to work in the United States?');
  mustNotInvent('What is your current visa status?');
  mustNotInvent('Will you now or in the future require sponsorship?');
  mustNotInvent('How many years of professional React experience do you have?', { elementType: 'number', options: [] });
  mustNotInvent('Do you hold a PMP certification?');
  mustNotInvent('Do you currently hold an active security clearance?');
  mustNotInvent('What is your desired salary?', { elementType: 'text', options: [] });
  mustNotInvent('Have you ever been convicted of a felony?');
  mustNotInvent('Are you licensed as a Professional Engineer?');
  mustNotInvent('What is your most recent employer?', { elementType: 'text', options: [] });
  mustNotInvent('What university did you attend?', { elementType: 'text', options: [] });
  mustNotInvent('What is your graduation date?', { elementType: 'date', options: [] });
});

test('unknown question path never guesses a submit-ready answer', () => {
  const rec = resolveFieldWithoutLlm(
    field('Have you used the internal AcmeDeploy toolchain?'),
    { ...EMPTY, skills: ['React'] },
  );
  const safe = rec == null || (rec.requiresReview === true && rec.answer == null);
  metric('phase2', 'unknown_no_guess', safe, { code: safe ? '' : 'F6' });
  assert.ok(safe);
  assert.notEqual(classifyQuestionIntent('Have you used the internal AcmeDeploy toolchain?'), 'work_authorization');
});
