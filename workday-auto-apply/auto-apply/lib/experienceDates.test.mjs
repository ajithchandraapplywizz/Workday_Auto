import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMonthYear,
  parseYear,
  resolveWorkDateRange,
  resolveEducationYearRange,
} from './experienceDates.mjs';

const NOW = new Date(2026, 8, 13); // September 2026

test('parseMonthYear accepts the formats a profile may hold', () => {
  assert.equal(parseMonthYear('06/2025').text, '06/2025');
  assert.equal(parseMonthYear('6/2025').text, '06/2025');
  assert.equal(parseMonthYear('2025-06').text, '06/2025');
  assert.equal(parseMonthYear('2025-06-01').text, '06/2025');
  assert.equal(parseMonthYear('06/15/2025').text, '06/2025');
  assert.equal(parseMonthYear('June 2025').text, '06/2025');
});

test('parseMonthYear rejects impossible months and junk', () => {
  assert.equal(parseMonthYear('13/2025'), null);
  assert.equal(parseMonthYear('00/2025'), null);
  assert.equal(parseMonthYear('2025'), null);
  assert.equal(parseMonthYear(''), null);
});

test('parseYear reads a year from several shapes', () => {
  assert.equal(parseYear('2022'), 2022);
  assert.equal(parseYear('06/2025'), 2025);
  assert.equal(parseYear('Expected 2026'), 2026);
  assert.equal(parseYear('not a year'), null);
});

test('work range keeps valid configured dates untouched', () => {
  const range = resolveWorkDateRange(
    { from_date: '06/2025', to_date: '08/2025' },
    { now: NOW },
  );
  assert.equal(range.from, '06/2025');
  assert.equal(range.to, '08/2025');
  assert.deepEqual(range.notes, []);
});

test('work range swaps a reversed From/To pair', () => {
  const range = resolveWorkDateRange(
    { from_date: '08/2025', to_date: '06/2025' },
    { now: NOW },
  );
  assert.equal(range.from, '06/2025');
  assert.equal(range.to, '08/2025');
  assert.match(range.notes[0], /swapped/);
});

test('work range clamps a future To date to the current month', () => {
  const range = resolveWorkDateRange(
    { from_date: '05/2025', to_date: '06/2027' },
    { now: NOW },
  );
  assert.equal(range.from, '05/2025');
  assert.equal(range.to, '09/2026');
  assert.match(range.notes[0], /future/);
});

test('work range reports an unparseable date instead of filling it', () => {
  const range = resolveWorkDateRange(
    { from_date: 'summer 2025', to_date: '08/2025' },
    { now: NOW },
  );
  assert.equal(range.from, null);
  assert.equal(range.to, '08/2025');
  assert.match(range.notes[0], /not a valid MM\/YYYY/);
});

test('education range keeps a future expected graduation year', () => {
  const range = resolveEducationYearRange({ from_year: '2022', to_year: '2028' }, { now: NOW });
  assert.equal(range.from, '2022');
  assert.equal(range.to, '2028');
  assert.deepEqual(range.notes, []);
});

test('education range falls back to graduation_year and fixes order', () => {
  assert.equal(resolveEducationYearRange({ from_year: '2022', graduation_year: '2026' }).to, '2026');

  const reversed = resolveEducationYearRange({ from_year: '2026', to_year: '2022' });
  assert.equal(reversed.from, '2022');
  assert.equal(reversed.to, '2026');
  assert.match(reversed.notes[0], /swapped/);
});
