import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateAwlIds } from '../lib/candidateParser.mjs';

test('parseCandidateAwlIds handles JSON string arrays', () => {
  const jsonStr = '["AWL-1568","AWL-26832","AWL-27321"]';
  const result = parseCandidateAwlIds(jsonStr);
  assert.deepEqual(result, ['AWL-1568', 'AWL-26832', 'AWL-27321']);
});

test('parseCandidateAwlIds handles escaped JSON string arrays', () => {
  const escapedStr = '[\"AWL-1568\",\"AWL-26832\"]';
  const result = parseCandidateAwlIds(escapedStr);
  assert.deepEqual(result, ['AWL-1568', 'AWL-26832']);
});

test('parseCandidateAwlIds handles comma-separated strings', () => {
  const csvStr = 'AWL-1568, AWL-26832, AWL-27321';
  const result = parseCandidateAwlIds(csvStr);
  assert.deepEqual(result, ['AWL-1568', 'AWL-26832', 'AWL-27321']);
});

test('parseCandidateAwlIds handles single string and trims/uppercases', () => {
  assert.deepEqual(parseCandidateAwlIds('  awl-1568  '), ['AWL-1568']);
  assert.deepEqual(parseCandidateAwlIds('"AWL-1568"'), ['AWL-1568']);
});

test('parseCandidateAwlIds handles native arrays with mixed elements', () => {
  const arr = ['AWL-100', '["AWL-200", "AWL-300"]', 'AWL-400, AWL-500'];
  const result = parseCandidateAwlIds(arr);
  assert.deepEqual(result, ['AWL-100', 'AWL-200', 'AWL-300', 'AWL-400', 'AWL-500']);
});

test('parseCandidateAwlIds handles empty, null or undefined input', () => {
  assert.deepEqual(parseCandidateAwlIds(''), []);
  assert.deepEqual(parseCandidateAwlIds(null), []);
  assert.deepEqual(parseCandidateAwlIds(undefined), []);
  assert.deepEqual(parseCandidateAwlIds([]), []);
});
