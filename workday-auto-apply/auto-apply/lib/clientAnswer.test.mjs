import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptClientValue, peekClientAnswer } from './clientAnswer.mjs';
import { lookupDefaultAnswer } from './workdayDefaults.mjs';
import { isDescribeExperienceQuestion, isProceedQuestion, isYearsQuantityQuestion } from './experienceAnswer.mjs';

test('sensitive government / agreement questions resolve to No', () => {
  const empty = {
    _applyWizzHydrated: true,
    _applyWizzQa: {},
    personal: {},
    work_auth: {},
    experience: {},
    education: {},
    eeo: {},
  };
  assert.equal(
    peekClientAnswer('5. U.S. Federal Government EmploymentVarious federal laws restrict the hiring of former employees.', empty),
    'No',
  );
  assert.equal(
    peekClientAnswer('Have you entered into any agreement in connection with a prior employer?', empty),
    'No',
  );
  assert.equal(
    peekClientAnswer('Will your acceptance of employment from Booz Allen Hamilton violate any restriction?', empty),
    'No',
  );
});

test('Yes/No questions reject a degree or other invented fact', () => {
  assert.equal(
    acceptClientValue('Have you ever been a volunteer at Valley Health System?', "Bachelor's Degree", {
      fieldType: 'dropdown',
    }),
    null,
  );
  assert.equal(
    acceptClientValue('Have you ever been a volunteer at Valley Health System?', 'No', {
      fieldType: 'dropdown',
    }),
    'No',
  );
});

test('peek uses Apply Wizz facts, not hardcoded defaults', () => {
  const profile = {
    _applyWizzHydrated: true,
    _applyWizzQa: {
      'authorized to work': 'Yes',
      'what is your desired compensation': '120000',
    },
    personal: { first_name: 'Ajith', last_name: 'Test', email: 'a@example.com' },
    work_auth: { authorized_us: 'Yes' },
    experience: {},
    education: {},
    eeo: {},
  };

  assert.equal(
    peekClientAnswer('Are you legally authorized to work in the United States?', profile),
    'Yes',
  );
  assert.equal(peekClientAnswer('First Name', profile), 'Ajith');

  // Defaults still exist in workdayDefaults — peek must not use them.
  const invented = lookupDefaultAnswer('What schedule can you work?');
  assert.ok(invented, 'lookupDefaultAnswer still has a canned schedule');
  assert.equal(peekClientAnswer('What schedule can you work?', profile), null);
});

test('years, describe, and proceed questions are classified for LLM', () => {
  assert.equal(isYearsQuantityQuestion('How many years of experience do you have managing projects?'), true);
  assert.equal(isYearsQuantityQuestion('How many years of experience do you have leading information systems projects?'), true);
  assert.equal(isDescribeExperienceQuestion('Briefly describe a complex, enterprise-wide (medium or large scale) project that you independently led.'), true);
  assert.equal(isDescribeExperienceQuestion('Briefly describe your experience and level of expertise using Smartsheet.'), true);
  assert.equal(isDescribeExperienceQuestion('Do you have health plan project management experience? If so, briefly describe your experience with projects in clams and billing.'), true);
  assert.equal(isDescribeExperienceQuestion('Please describe your experience in hospital revenue integrity, coding, or healthcare revenue cycle operations.'), true);
  assert.equal(isDescribeExperienceQuestion('Tell us about a time you identified a recurring coding, charge capture, billing, claims, or reimbursement issue.'), true);
  assert.equal(isDescribeExperienceQuestion('Why are you looking for new position?'), true);
  assert.equal(isDescribeExperienceQuestion('Which of the following areas do you have direct working experience with? Please indicate all that apply and briefly describe your experience.'), true);
  assert.equal(isProceedQuestion('This is a temporary, 9 months, full-time Monday - Friday position (with benefits) working 3 days from the Portland downtown corporate office. Would you like to proceed?'), true);
});

test('hourly wage uses compensation_hourly, not yearly salary', () => {
  const profile = {
    _applyWizzHydrated: true,
    _applyWizzQa: { 'minimum hourly wage': '50', 'what is your desired compensation': '90000' },
    compensation: '90000',
    compensation_hourly: '50',
    personal: {},
    work_auth: {},
    experience: {},
    education: {},
    eeo: {},
  };
  assert.equal(
    peekClientAnswer('What is your minimum hourly wage requirement for this position?', profile, { fieldType: 'text' }),
    '50',
  );
});

test('relocate / reside Yes-No uses profile fact and extracts Yes from LLM prose', () => {
  const profile = {
    _applyWizzHydrated: true,
    _applyWizzQa: { 'willing to relocate': 'Yes' },
    personal: { state: 'Texas' },
    work_auth: { willing_to_relocate: 'Yes' },
    experience: {},
    education: {},
    eeo: {},
  };
  const label = 'Do you currently reside in Nebraska or Iowa, or are you willing to relocate to NE or IA at your own expense (no relocation assistance)?';
  assert.equal(peekClientAnswer(label, profile, { fieldType: 'dropdown', options: ['Yes', 'No'] }), 'Yes');
  assert.equal(
    acceptClientValue(label, 'I live in Texas but I am willing to relocate at my own expense. Yes', {
      fieldType: 'dropdown',
      options: ['Yes', 'No'],
    }),
    'Yes',
  );
});

test('peek does not invent Full Time or all shifts', () => {
  const empty = { _applyWizzHydrated: true, _applyWizzQa: {}, personal: {}, experience: {}, education: {}, eeo: {}, work_auth: {} };
  assert.equal(peekClientAnswer('What shifts can you work?', empty), null);
  assert.equal(peekClientAnswer('What schedule can you work?', empty), null);
  assert.equal(peekClientAnswer('Have you ever volunteered at this organisation?', empty), 'No');
});
