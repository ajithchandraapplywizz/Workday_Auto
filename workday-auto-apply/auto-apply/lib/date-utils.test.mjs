import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getTodayMMDDYYYY,
  getTodayISODate,
  isAvailabilityStartDateLabel,
  isCurrentDateQuestionLabel,
  buildCurrentDateAction,
  validateMMDDYYYY,
  validateISODate,
} from './date-utils.mjs';

test('getTodayMMDDYYYY returns MM/DD/YYYY', () => {
  const ref = new Date('2026-09-06T12:30:00+05:30');
  assert.equal(getTodayMMDDYYYY('Asia/Kolkata', ref), '09/06/2026');
});

test('getTodayMMDDYYYY pads month and day to two digits', () => {
  const ref = new Date('2026-03-04T12:00:00+05:30');
  assert.equal(getTodayMMDDYYYY('Asia/Kolkata', ref), '03/04/2026');
});

test('getTodayMMDDYYYY keeps four-digit year', () => {
  const ref = new Date('2026-07-09T09:00:00+05:30');
  assert.equal(getTodayMMDDYYYY('Asia/Kolkata', ref), '07/09/2026');
});

test('getTodayMMDDYYYY respects timezone', () => {
  const ref = new Date('2026-09-06T00:30:00Z');
  assert.equal(getTodayMMDDYYYY('UTC', ref), '09/06/2026');
  assert.equal(getTodayMMDDYYYY('America/New_York', ref), '09/05/2026');
});

test('getTodayISODate returns YYYY-MM-DD for native date inputs', () => {
  const ref = new Date('2026-09-06T12:30:00+05:30');
  assert.equal(getTodayISODate('Asia/Kolkata', ref), '2026-09-06');
});

test('isCurrentDateQuestionLabel detects current-date prompts', () => {
  assert.equal(isCurrentDateQuestionLabel("Please enter today's date:"), true);
  assert.equal(isCurrentDateQuestionLabel('Please enter today’s date:'), true);
  assert.equal(isCurrentDateQuestionLabel('Current date'), true);
  assert.equal(isCurrentDateQuestionLabel('Date of application'), true);
  assert.equal(isCurrentDateQuestionLabel('Submission date'), true);
  assert.equal(isCurrentDateQuestionLabel('MM/DD/YYYY'), false);
  assert.equal(
    isCurrentDateQuestionLabel('Please enter today\'s date:', { placeholder: 'MM/DD/YYYY' }),
    true
  );
  assert.equal(isCurrentDateQuestionLabel('Date', {
    placeholder: 'MM/DD/YYYY',
    containerText: 'Voluntary Self-Identification of Disability Date current value is MM/DD/YYYY',
  }), true);
});

test('date classification rejects non-current date fields', () => {
  assert.equal(isCurrentDateQuestionLabel('Date of birth'), false);
  assert.equal(isCurrentDateQuestionLabel('Employment start date'), false);
  assert.equal(isCurrentDateQuestionLabel('Graduation date'), false);
  assert.equal(isCurrentDateQuestionLabel('Visa expiration date'), false);
  assert.equal(isCurrentDateQuestionLabel('Availability date'), false);
});

test('isAvailabilityStartDateLabel detects availability start questions', () => {
  assert.equal(isAvailabilityStartDateLabel('When are you available to start?'), true);
  assert.equal(isAvailabilityStartDateLabel('What is your desired start date?'), true);
  assert.equal(isAvailabilityStartDateLabel('When can you start?'), true);
  assert.equal(isAvailabilityStartDateLabel('From'), false);
  assert.equal(isAvailabilityStartDateLabel('Date of birth'), false);
});

test('buildCurrentDateAction fills availability start with today', () => {
  const ref = new Date('2026-09-11T12:00:00+05:30');
  const action = buildCurrentDateAction('When are you available to start?', { timeZone: 'Asia/Kolkata' }, ref);
  assert.equal(action?.value, '09/11/2026');
  assert.equal(action?.payload?.date?.source, 'availability_start_today');
});

test('buildCurrentDateAction creates the required field action', () => {
  const ref = new Date('2026-09-06T12:30:00+05:30');
  const action = buildCurrentDateAction("Please enter today's date:", { timeZone: 'Asia/Kolkata' }, ref);
  assert.deepEqual(action, {
    action: 'fill_dynamic_date',
    format: 'MM/DD/YYYY',
    timeZone: 'Asia/Kolkata',
    value: '09/06/2026',
    payload: {
      date: {
        normalized_label: "please enter today's date:",
        raw_label: "Please enter today's date:",
        answer: '09/06/2026',
        source: 'auto_generated',
        compliance_sensitive: false,
      },
    },
  });
});

test('isCurrentDateQuestionLabel detects CC-305 Self Identify date field', () => {
  assert.equal(isCurrentDateQuestionLabel('Date', {
    containerText: 'Voluntary Self-Identification of Disability CC-305 current value is MM/DD/YYYY',
  }), true);
});

test('validateMMDDYYYY and validateISODate enforce the expected formats', () => {
  assert.equal(validateMMDDYYYY('09/06/2026'), true);
  assert.equal(validateMMDDYYYY('2026-09-06'), false);
  assert.equal(validateISODate('2026-09-06'), true);
  assert.equal(validateISODate('09/06/2026'), false);
});
