import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyProvenance, ALLOWED_SOURCES } from '../lib/provenanceGate.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { lookupResolvedAnswerFromProfile } from '../lib/clientAnswer.mjs';

test('Provenance Gate allows job_distributions_resolved_answers and pre_resolved sources', () => {
  assert.ok(ALLOWED_SOURCES.has('job_distributions_resolved_answers'));
  assert.ok(ALLOWED_SOURCES.has('resolved_answers'));

  const gateResult = verifyProvenance(
    { label: 'Are you legally authorized to work in the United States?', required: true },
    {
      questionId: 'q1',
      answer: 'Yes',
      confidence: 1.0,
      source: 'job_distributions_resolved_answers',
    }
  );

  assert.equal(gateResult.ok, true, 'job_distributions_resolved_answers must pass provenance gate');
  assert.equal(gateResult.blocked, false);
});

test('resolveFieldWithoutLlm prioritizes Tier 0 pre-resolved answers from profile', () => {
  const profile = {
    _resolvedAnswersJson: [
      {
        question: 'Are you willing to relocate?',
        answer: 'Yes',
        fieldType: 'radio',
      },
      {
        question: 'Years of Experience in Software Engineering',
        answer: '5',
        fieldType: 'text',
      },
    ],
  };

  const field1 = {
    label: 'Are you willing to relocate?',
    fieldType: 'radio',
    options: ['Yes', 'No'],
    required: true,
  };

  const res1 = resolveFieldWithoutLlm(field1, profile);
  assert.ok(res1, 'Should resolve field1');
  assert.equal(res1.answer, 'Yes');
  assert.equal(res1.source, 'job_distributions_resolved_answers');
  assert.equal(res1.confidence, 1.0);

  const field2 = {
    label: 'Years of Experience in Software Engineering',
    fieldType: 'text',
    required: true,
  };

  const res2 = resolveFieldWithoutLlm(field2, profile);
  assert.ok(res2, 'Should resolve field2');
  assert.equal(res2.answer, '5');
  assert.equal(res2.source, 'job_distributions_resolved_answers');
});

test('lookupResolvedAnswerFromProfile matches fuzzy/normalized labels', () => {
  const profile = {
    _resolvedAnswersJson: [
      {
        question: 'How did you hear about us?*',
        answer: 'LinkedIn',
      },
    ],
  };

  const hit = lookupResolvedAnswerFromProfile('How Did You Hear About Us', profile, {
    options: ['LinkedIn', 'Indeed', 'Career Site'],
    fieldType: 'dropdown',
  });

  assert.ok(hit, 'Should find normalized match');
  assert.equal(hit.answer, 'LinkedIn');
  assert.equal(hit.source, 'job_distributions_resolved_answers');
  assert.equal(hit.tier, 0);
});
