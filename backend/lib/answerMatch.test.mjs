import test from 'node:test';
import assert from 'node:assert/strict';

import { leadingYesNo, selectionMatchesAnswer } from './workdayDefaults.mjs';

test('leadingYesNo reads the answer word, not letters inside other words', () => {
  assert.equal(leadingYesNo('No'), 'no');
  assert.equal(leadingYesNo('No, I have never volunteered'), 'no');
  assert.equal(leadingYesNo('Yes'), 'yes');
  assert.equal(leadingYesNo('Yes, I have been notified'), 'yes');
  assert.equal(leadingYesNo('I am not a protected veteran'), 'no');
  assert.equal(leadingYesNo('Asian'), null);
});

test('an opposite Yes/No selection is never accepted', () => {
  // "Yes, I have been notified" contains "no" — the old substring test passed this.
  assert.equal(selectionMatchesAnswer('Yes, I have been notified', 'No'), false);
  assert.equal(selectionMatchesAnswer('Yes', 'No'), false);
  assert.equal(selectionMatchesAnswer('No', 'Yes'), false);
  assert.equal(selectionMatchesAnswer('No, I do not volunteer', 'Yes'), false);
});

test('a matching Yes/No selection is accepted in its long form', () => {
  assert.equal(selectionMatchesAnswer('No, I have never volunteered', 'No'), true);
  assert.equal(selectionMatchesAnswer('Yes, I have been notified', 'Yes'), true);
  assert.equal(selectionMatchesAnswer('No', 'No'), true);
});

test('negative EEO option text still satisfies a stored "No"', () => {
  assert.equal(selectionMatchesAnswer('Not Hispanic or Latino', 'No'), true);
  assert.equal(selectionMatchesAnswer('I am not a protected veteran', 'No'), true);
  // …and must not satisfy the affirmative option.
  assert.equal(selectionMatchesAnswer('Not Hispanic or Latino', 'Hispanic or Latino'), false);
});

test('non Yes/No values still match on substring', () => {
  assert.equal(selectionMatchesAnswer('Asian (United States of America)', 'Asian'), true);
  assert.equal(selectionMatchesAnswer('Full Time', 'Full Time'), true);
  assert.equal(selectionMatchesAnswer('Part Time', 'Full Time'), false);
});

test('an empty or missing selection never counts as answered', () => {
  assert.equal(selectionMatchesAnswer('', 'No'), false);
  assert.equal(selectionMatchesAnswer('No', ''), false);
});
