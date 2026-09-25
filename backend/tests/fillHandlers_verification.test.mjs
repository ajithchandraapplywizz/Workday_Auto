import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

import { detectControlType } from '../lib/scanner.mjs';
import { findBestOptionMatch, tokenSetRatio } from '../lib/fields.mjs';
import { validateResolvedValue } from '../lib/planner.mjs';
import { formatToMMDDYYYY } from '../lib/fillHandlers.mjs';
import { appendManualReviewRecord } from '../lib/qaStore.mjs';
import { writeFieldTraceLine } from '../lib/reporter.mjs';

describe('Control-Type Detection (scanner.mjs)', () => {
  it('detects native-select correctly', () => {
    assert.equal(detectControlType({ tagName: 'select' }), 'native-select');
    assert.equal(detectControlType({ type: 'select-one' }), 'native-select');
  });

  it('detects custom-dropdown for combobox, listbox, and selectWidget', () => {
    assert.equal(detectControlType({ role: 'combobox' }), 'custom-dropdown');
    assert.equal(detectControlType({ ariaHasPopup: 'listbox' }), 'custom-dropdown');
    assert.equal(detectControlType({ automationId: 'select-widget' }), 'custom-dropdown');
    assert.equal(detectControlType({ automationId: 'selectOne' }), 'custom-dropdown');
    assert.equal(detectControlType({ automationId: 'promptOption' }), 'custom-dropdown');
  });

  it('detects checkbox-group', () => {
    assert.equal(detectControlType({ role: 'checkbox' }), 'checkbox-group');
    assert.equal(detectControlType({ type: 'checkbox' }), 'checkbox-group');
    assert.equal(detectControlType({ type: 'checkbox-group' }), 'checkbox-group');
  });

  it('detects radio-group', () => {
    assert.equal(detectControlType({ role: 'radio' }), 'radio-group');
    assert.equal(detectControlType({ type: 'radio' }), 'radio-group');
    assert.equal(detectControlType({ role: 'radiogroup' }), 'radio-group');
  });

  it('detects date-picker from type, placeholder, or date automationId', () => {
    assert.equal(detectControlType({ type: 'date' }), 'date-picker');
    assert.equal(detectControlType({ placeholder: 'MM/DD/YYYY' }), 'date-picker');
    assert.equal(detectControlType({ placeholder: 'DD/MM/YYYY' }), 'date-picker');
    assert.equal(detectControlType({ automationId: 'dateSectionMonth-input' }), 'date-picker');
    assert.equal(detectControlType({ automationId: 'startDateInput' }), 'date-picker');
  });

  it('falls back to free-text for inputs and textareas', () => {
    assert.equal(detectControlType({ type: 'text' }), 'free-text');
    assert.equal(detectControlType({ type: 'tel' }), 'free-text');
    assert.equal(detectControlType({ type: 'email' }), 'free-text');
    assert.equal(detectControlType({ tagName: 'textarea' }), 'free-text');
  });
});

describe('Option Matching & Formatting (fields.mjs & fillHandlers.mjs)', () => {
  it('findBestOptionMatch matches option >= 85 and rejects mismatches', () => {
    const options = [
      { text: 'Full Time', value: 'FT' },
      { text: 'Part Time', value: 'PT' },
      { text: 'Internship / Co-op', value: 'INT' },
    ];

    const hit = findBestOptionMatch('Full-Time', options, 85);
    assert.equal(hit.matched, true);
    assert.equal(hit.bestMatch, 'Full Time');

    const miss = findBestOptionMatch('Freelance Contractor', options, 85);
    assert.equal(miss.matched, false);

    const degHit = findBestOptionMatch(
      'Master of Science in Computer Science Java Python',
      ['High School Diploma', "Bachelor's Degree", "Master's Degree", 'Doctorate', 'None of the Above'],
      85,
    );
    assert.equal(degHit.matched, true);
    assert.equal(degHit.bestMatch, "Master's Degree");
  });

  it('formatToMMDDYYYY normalizes diverse date formats', () => {
    assert.equal(formatToMMDDYYYY('2026-09-22'), '09/22/2026');
    assert.equal(formatToMMDDYYYY('9/5/2026'), '09/05/2026');
    assert.equal(formatToMMDDYYYY('09/22/2026'), '09/22/2026');
    assert.equal(formatToMMDDYYYY(new Date(2026, 8, 22)), '09/22/2026');
  });
});

describe('Pre-Fill Validity Check (planner.mjs)', () => {
  it('rejects dropdown values not present in visible options', () => {
    const field = {
      controlType: 'custom-dropdown',
      label: 'Will you work overtime?',
      options: [
        { text: 'Yes, regularly' },
        { text: 'Yes, occasionally' },
        { text: 'No overtime' },
      ],
    };

    const validCheck = validateResolvedValue(field, 'Yes, occasionally');
    assert.equal(validCheck.valid, true);

    const invalidCheck = validateResolvedValue(field, 'Maybe next year');
    assert.equal(invalidCheck.valid, false);
    assert.equal(invalidCheck.reason, 'option_not_in_visible_options');
  });

  it('rejects invalid dates for date-picker', () => {
    const field = { controlType: 'date-picker', label: 'Availability / Start Date' };
    assert.equal(validateResolvedValue(field, '09/22/2026').valid, true);
    assert.equal(validateResolvedValue(field, '2026-10-01').valid, true);

    const invalid = validateResolvedValue(field, 'Immediate / ASAP');
    assert.equal(invalid.valid, false);
    assert.equal(invalid.reason, 'invalid_date_format');
  });

  it('catches and rejects implausible salary values like "43"', () => {
    const annualField = { controlType: 'free-text', label: 'What is your desired annual salary?' };

    // "43" is not a plausible annual salary
    const badSalary = validateResolvedValue(annualField, '43');
    assert.equal(badSalary.valid, false);
    assert.equal(badSalary.reason, 'implausible_salary_magnitude');

    // Plausible annual salary
    const goodSalary = validateResolvedValue(annualField, '125,000');
    assert.equal(goodSalary.valid, true);

    const numericSalary = validateResolvedValue(annualField, '95000');
    assert.equal(numericSalary.valid, true);
  });

  it('validates hourly wage magnitude and percentage', () => {
    const hourlyField = { controlType: 'free-text', label: 'Desired hourly pay rate' };
    assert.equal(validateResolvedValue(hourlyField, '45').valid, true);
    assert.equal(validateResolvedValue(hourlyField, '100000').valid, false); // $100,000/hr is implausible

    const pctField = { controlType: 'free-text', label: 'What percentage of time can you travel?' };
    assert.equal(validateResolvedValue(pctField, '25%').valid, true);
    assert.equal(validateResolvedValue(pctField, '150%').valid, false);
  });
});

describe('Manual-Review Escalation & Trace Logging', () => {
  const testQueueFile = resolve(process.cwd(), 'data', 'test-manual-review.json');

  it('appendManualReviewRecord records full details and deduplicates', async () => {
    if (existsSync(testQueueFile)) await unlink(testQueueFile);

    const rec1 = await appendManualReviewRecord({
      candidateId: 'AWL-26828',
      tenant: 'salesforce',
      questionLabel: 'Will you work overtime?',
      controlType: 'custom-dropdown',
      visibleOptions: ['Yes', 'No'],
      tierAttempted: 'tier4_llm',
      attemptedValue: 'Maybe',
      reason: 'option_not_in_visible_options',
      step: 'Application Questions',
      filePath: testQueueFile,
    });

    assert.equal(rec1.candidate_id, 'AWL-26828');
    assert.equal(rec1.workday_tenant, 'salesforce');

    const fileContent = JSON.parse(await readFile(testQueueFile, 'utf8'));
    assert.equal(fileContent.length, 1);
    assert.equal(fileContent[0].question_label, 'Will you work overtime?');
    assert.deepEqual(fileContent[0].visible_options, ['Yes', 'No']);

    // Duplicate attempt updates existing record
    await appendManualReviewRecord({
      candidateId: 'AWL-26828',
      tenant: 'salesforce',
      questionLabel: 'Will you work overtime?',
      controlType: 'custom-dropdown',
      visibleOptions: ['Yes', 'No'],
      tierAttempted: 'tier4_llm',
      attemptedValue: 'No',
      reason: 'verification_failed',
      step: 'Application Questions',
      filePath: testQueueFile,
    });

    const updated = JSON.parse(await readFile(testQueueFile, 'utf8'));
    assert.equal(updated.length, 1);
    assert.equal(updated[0].attempted_value, 'No');

    // Clean up
    if (existsSync(testQueueFile)) await unlink(testQueueFile);
  });

  it('writeFieldTraceLine formats structured line exactly as required', async () => {
    const line = await writeFieldTraceLine({
      automationId: 'travelPercent-input',
      label: 'What percentage of time can you travel?',
      controlType: 'free-text',
      tier: 'tier1_supabase',
      valueAttempted: '25%',
      verified: true,
    });

    assert.equal(
      line,
      'travelPercent-input | What percentage of time can you travel? | free-text | tier1_supabase | 25% | verified pass'
    );

    const failLine = await writeFieldTraceLine({
      automationId: 'overtime-select',
      label: 'Will you work overtime?',
      controlType: 'custom-dropdown',
      tier: 'tier4_llm',
      valueAttempted: 'none',
      verified: false,
    });

    assert.equal(
      failLine,
      'overtime-select | Will you work overtime? | custom-dropdown | tier4_llm | none | verified fail'
    );
  });
});
