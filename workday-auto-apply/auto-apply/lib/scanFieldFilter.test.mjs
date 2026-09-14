import test from 'node:test';
import assert from 'node:assert/strict';

import { isMandatoryField, shouldIncludeInScan, isSkippableUnimportantLabel } from './scanFieldFilter.mjs';

const relocateLabel = 'Do you currently reside in Nebraska or Iowa, or are you willing to relocate to NE or IA at your own expense (no relocation assistance)?*';

test('required relocate / reside questions are not skipped', () => {
  assert.equal(isMandatoryField(relocateLabel, {}), true);
  assert.equal(shouldIncludeInScan(relocateLabel, { required: true }), true);
  assert.equal(isSkippableUnimportantLabel('Willing to Relocate'), true);
  assert.equal(shouldIncludeInScan(relocateLabel.replace(/\*$/, ''), { required: true, hasRequiredMarker: true }), true);
});

test('required wins over skip lists (skills, education, license, identity)', () => {
  const cases = [
    ['Type to add skills', { required: true }],
    ['Highest level of education completed', { required: true }],
    ['License number', { hasRequiredMarker: true }],
    ['GPA', { required: true }],
    ['Phone Number', { required: true }],
    ['City', { required: true }],
    ['Given Name', { required: true }],
    ['Add skills', { containerText: 'Add skills * Enter a skill below' }],
  ];
  for (const [label, field] of cases) {
    assert.equal(isMandatoryField(label, field), true, label);
    assert.equal(isSkippableUnimportantLabel(label, field), false, label);
    assert.equal(shouldIncludeInScan(label, field), true, label);
  }
});

test('optional skip-list labels stay skipped when Workday did not mark them required', () => {
  assert.equal(isSkippableUnimportantLabel('Preferred name'), true);
  assert.equal(shouldIncludeInScan('Preferred name', {}), false);
  assert.equal(isSkippableUnimportantLabel('Type to add skills'), true);
});

test('required hourly and essay questions stay in the scan', () => {
  const hourly = 'What is your minimum hourly wage requirement for this position?*';
  const essay = 'Please describe your experience in hospital revenue integrity, coding, or healthcare revenue cycle operations.*';
  assert.equal(isMandatoryField(hourly, { required: true }), true);
  assert.equal(shouldIncludeInScan(hourly, { required: true }), true);
  assert.equal(isMandatoryField(essay, { required: true }), true);
  assert.equal(shouldIncludeInScan(essay, { required: true }), true);
});
