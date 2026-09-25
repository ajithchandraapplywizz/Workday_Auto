import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMinimumAgeQuestion,
  parseAgeThreshold,
  ageFromDob,
  resolveMinimumAgeAnswer,
} from './minimumAge.mjs';
import { peekClientAnswer, acceptClientValue } from './clientAnswer.mjs';
import { shouldIncludeInScan, isSkippableUnimportantLabel } from './scanFieldFilter.mjs';

test('classifies 16+ / 18+ working-age questions', () => {
  assert.equal(isMinimumAgeQuestion('Are you 16 years old or over?'), true);
  assert.equal(isMinimumAgeQuestion('Are you 16 years of age or older?'), true);
  assert.equal(isMinimumAgeQuestion('Are you over the age of 18?'), true);
  assert.equal(isMinimumAgeQuestion('Are you at least 18 years of age?'), true);
  assert.equal(isMinimumAgeQuestion('Have you ever volunteered at this organisation?'), false);
  assert.equal(parseAgeThreshold('Are you 16 years old or over?'), 16);
  assert.equal(parseAgeThreshold('Are you over the age of 18?'), 18);
});

test('age from DOB and default Yes for job apps', () => {
  const now = new Date(2026, 8, 13);
  assert.equal(ageFromDob('1999-01-15', now), 27);
  assert.equal(ageFromDob('01/15/1999', now), 27);
  assert.equal(resolveMinimumAgeAnswer('Are you 16 years old or over?', {
    personal: { date_of_birth: '1999-01-15' },
  }), 'Yes');
  assert.equal(resolveMinimumAgeAnswer('Are you over the age of 18?', {}), 'Yes');
});

test('cached YAML No cannot win on age questions', () => {
  const profile = {
    _applyWizzHydrated: true,
    _applyWizzQa: { 'are you 16 years old or over': 'No' },
    personal: { date_of_birth: '1998-06-01' },
    qa_answers: { 'are you 16 years old or over': 'No', 'are you over the age of 18': 'No' },
    work_auth: {},
    experience: {},
    education: {},
    eeo: {},
  };
  assert.equal(
    peekClientAnswer('Are you 16 years old or over?', profile, { fieldType: 'dropdown', options: ['Yes', 'No'] }),
    'Yes',
  );
  assert.equal(
    peekClientAnswer('Are you over the age of 18?', profile, { fieldType: 'dropdown', options: ['Yes', 'No'] }),
    'Yes',
  );
  assert.equal(
    acceptClientValue('Are you 16 years old or over?', 'No', { fieldType: 'dropdown', options: ['Yes', 'No'] }),
    null,
  );
});

test('long voluntary-page age questions stay in the scan', () => {
  const long = 'This is a voluntary questionnaire used for recordkeeping. '
    + 'The information will not affect your employment opportunities. '
    + 'Are you 16 years old or over?*';
  assert.equal(isSkippableUnimportantLabel(long), false);
  assert.equal(shouldIncludeInScan(long, { required: true }), true);
  assert.equal(shouldIncludeInScan('Are you over the age of 18?', {}), true);
  assert.equal(isSkippableUnimportantLabel('Volunteer Name'), true);
});
