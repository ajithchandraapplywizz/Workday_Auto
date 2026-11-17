/**
 * judgeLlm.test.mjs — Unit tests for Ultra-Low Token Judge LLM
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeAndResolveHardQuestion } from '../lib/judgeLlm.mjs';

test('1. Judge DB Hit returns in-memory cached answer with 0 LLM tokens', async () => {
  const resolvedMap = new Map();
  resolvedMap.set('are you willing to work overtime', { answer: 'Yes', rawQ: 'Are you willing to work overtime?' });

  const profile = {
    _applyWizzId: 'AWL-TEST-JUDGE',
    _resolvedAnswersMap: resolvedMap,
  };

  const res = await judgeAndResolveHardQuestion({
    question: 'Are you willing to work overtime?',
    options: ['Yes', 'No'],
    profile,
  });

  assert.ok(res, 'Should return a result');
  assert.equal(res.answer, 'Yes');
  assert.equal(res.source, 'in_memory_cache');
  assert.equal(res.confidence, 1.0);
});

test('2. Judge returns proposed answer as defensive fallback if LLM is unreachable or no API key', async () => {
  const profile = {
    _applyWizzId: 'AWL-TEST-JUDGE-FALLBACK',
    _resolvedAnswersMap: new Map(),
    personal: { work_authorization: 'Authorized' },
  };

  const res = await judgeAndResolveHardQuestion({
    question: 'Will you now or in the future require sponsorship?',
    options: ['Yes', 'No'],
    proposedAnswer: 'No',
    profile,
  });

  assert.ok(res, 'Should return a result');
  assert.equal(res.answer, 'No');
  assert.ok(res.confidence > 0);
});
