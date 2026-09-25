import test from 'node:test';
import assert from 'node:assert/strict';

import { validateLlmFieldDecision } from './openRouterLlm.mjs';

test('accepts a grounded input answer with sufficient confidence', () => {
  const answer = validateLlmFieldDecision(
    '{"answer":"5","confidence":0.91,"grounded":true}',
    { fieldType: 'text' },
  );
  assert.equal(answer, '5');
});

test('rejects ungrounded or low-confidence answers', () => {
  assert.equal(validateLlmFieldDecision(
    '{"answer":"Yes","confidence":0.99,"grounded":false}',
    { fieldType: 'radio', options: ['Yes', 'No'] },
  ), null);
  assert.equal(validateLlmFieldDecision(
    '{"answer":"Yes","confidence":0.4,"grounded":true}',
    { fieldType: 'radio', options: ['Yes', 'No'] },
  ), null);
});

test('requires exact live DOM text for dropdowns and radios', () => {
  assert.equal(validateLlmFieldDecision(
    '{"answer":"Full Time","confidence":0.9,"grounded":true}',
    { fieldType: 'dropdown', options: ['Full Time', 'Part Time'] },
  ), 'Full Time');
  assert.equal(validateLlmFieldDecision(
    '{"answer":"Full-Time","confidence":0.9,"grounded":true}',
    { fieldType: 'dropdown', options: ['Full Time', 'Part Time'] },
  ), null);
});

test('returns validated multi-checkbox options as a comma-delimited answer', () => {
  const answer = validateLlmFieldDecision(
    '{"answer":["Remote","Hybrid"],"confidence":0.88,"grounded":true}',
    { fieldType: 'checkbox-group', options: ['On-site', 'Remote', 'Hybrid'] },
  );
  assert.equal(answer, 'Remote, Hybrid');
});

test('accepts an honest no-experience answer even when grounded is false', () => {
  assert.equal(validateLlmFieldDecision(
    '{"answer":"I have not used Smartsheet in a professional setting.","confidence":0.7,"grounded":false}',
    { fieldType: 'text' },
  ), 'I have not used Smartsheet in a professional setting.');
});

test('rejects a multi-checkbox response containing an unknown option', () => {
  const answer = validateLlmFieldDecision(
    '{"answer":["Remote","Flexible"],"confidence":0.88,"grounded":true}',
    { fieldType: 'checkbox-group', options: ['On-site', 'Remote', 'Hybrid'] },
  );
  assert.equal(answer, null);
});
