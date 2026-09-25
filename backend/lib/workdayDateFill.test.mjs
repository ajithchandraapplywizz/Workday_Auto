import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import {
  classifyDateHint,
  isRequiredLabelText,
  parseDateFillValue,
  fillWorkdayDateField,
  strictDateMatch,
} from './workdayDateFill.mjs';

test('classifyDateHint reads Workday month/year automation ids', () => {
  assert.equal(classifyDateHint('dateSectionMonth-input'), 'month');
  assert.equal(classifyDateHint('dateSectionYear-input'), 'year');
  assert.equal(classifyDateHint('Month MM'), 'month');
  assert.equal(classifyDateHint('Year YYYY'), 'year');
  assert.equal(classifyDateHint('dateIcon'), '');
});

test('isRequiredLabelText treats a star as required', () => {
  assert.equal(isRequiredLabelText('From *'), true);
  assert.equal(isRequiredLabelText('To (Actual or Expected)*'), true);
  assert.equal(isRequiredLabelText('From'), false);
});

test('strictDateMatch rejects a leftover year with the wrong month', () => {
  assert.equal(strictDateMatch({ month: '2', year: '2025', text: '2/2025' }, { month: '06', year: '2025' }), false);
  assert.equal(strictDateMatch({ month: '06', year: '2025', text: '06/2025' }, { month: '06', year: '2025' }), true);
  assert.equal(strictDateMatch({ month: 'MM', year: 'YYYY', text: 'MM/YYYY' }, { month: '06', year: '2025' }), false);
});

test('parseDateFillValue accepts MM/YYYY, year-only, and month names like Aug 2024', () => {
  assert.deepEqual(parseDateFillValue('05/2025'), { month: '05', year: '2025', padded: '05/2025' });
  assert.deepEqual(parseDateFillValue('5/2025'), { month: '05', year: '2025', padded: '05/2025' });
  assert.deepEqual(parseDateFillValue('2020', 'year'), { month: '01', year: '2020', padded: '01/2020' });
  assert.deepEqual(parseDateFillValue('Aug 2024'), { month: '08', year: '2024', padded: '08/2024' });
  assert.deepEqual(parseDateFillValue('August 2024'), { month: '08', year: '2024', padded: '08/2024' });
  assert.equal(parseDateFillValue('not-a-date'), null);
});

const WORKDAY_DATE_FIXTURE = `<!doctype html>
<html><body>
  <section data-automation-id="workExperienceSection">
    <h2>Work Experience</h2>
    <div data-automation-id="formField-startDate">
      <label>From <span data-automation-id="formLabelRequired">*</span></label>
      <div data-automation-id="dateInputWrapper">
        <div data-automation-id="dateSectionMonth-input">
          <input role="spinbutton" aria-label="Month" />
        </div>
        <div data-automation-id="dateSectionYear-input">
          <input role="spinbutton" aria-label="Year" />
        </div>
        <button data-automation-id="dateIcon">cal</button>
      </div>
    </div>
    <div data-automation-id="formField-endDate">
      <label>To <span data-automation-id="formLabelRequired">*</span></label>
      <div data-automation-id="dateInputWrapper">
        <input data-automation-id="dateSectionMonth-input" aria-label="Month" />
        <input data-automation-id="dateSectionYear-input" aria-label="Year" />
      </div>
    </div>
  </section>
  <section data-automation-id="educationSection">
    <h2>Education</h2>
    <div data-automation-id="formField-eduFrom">
      <label>From *</label>
      <input role="spinbutton" aria-label="Year" />
    </div>
  </section>
</body></html>`;

test('fills required Work From/To and Education year on a Workday-shaped page', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(WORKDAY_DATE_FIXTURE);
    const from = await fillWorkdayDateField(page, {
      labelPattern: '^From\\b',
      sectionType: 'work',
      value: '05/2025',
      mode: 'monthyear',
    });
    assert.equal(from.ok, true, from.attempts.join('; '));

    const to = await fillWorkdayDateField(page, {
      labelPattern: '^To\\b(?!\\s*year)',
      sectionType: 'work',
      value: '06/2026',
      mode: 'monthyear',
    });
    assert.equal(to.ok, true, to.attempts.join('; '));

    const edu = await fillWorkdayDateField(page, {
      labelPattern: '^From\\b',
      sectionType: 'education',
      value: '2020',
      mode: 'year',
    });
    assert.equal(edu.ok, true, edu.attempts.join('; '));

    const values = await page.evaluate(() => {
      const work = document.querySelector('[data-automation-id="workExperienceSection"]');
      const workSpins = work.querySelectorAll('input');
      const edu = document.querySelector('[data-automation-id="educationSection"] input');
      return {
        fromMonth: workSpins[0].value,
        fromYear: workSpins[1].value,
        toMonth: workSpins[2].value,
        toYear: workSpins[3].value,
        eduYear: edu.value,
      };
    });
    assert.equal(String(Number(values.fromMonth)), '5');
    assert.equal(values.fromYear, '2025');
    assert.equal(String(Number(values.toMonth)), '6');
    assert.equal(values.toYear, '2026');
    assert.equal(values.eduYear, '2020');
  } finally {
    await browser.close();
  }
});

test('month maxlength 2 still gets 06/2025 not 2/2025', async () => {
  const html = `<!doctype html><html><body>
    <section data-automation-id="workExperienceSection">
      <h2>Work Experience</h2>
      <div data-automation-id="formField-startDate">
        <label>From *</label>
        <div data-automation-id="dateInputWrapper">
          <input role="spinbutton" aria-label="Month" maxlength="2" />
          <input role="spinbutton" aria-label="Year" maxlength="4" />
        </div>
      </div>
    </section>
  </body></html>`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const from = await fillWorkdayDateField(page, {
      labelPattern: '^From\\b',
      sectionType: 'work',
      value: '06/2025',
      mode: 'monthyear',
    });
    assert.equal(from.ok, true, from.attempts.join('; '));
    const values = await page.evaluate(() => {
      const spins = document.querySelectorAll('input');
      return { month: spins[0].value, year: spins[1].value };
    });
    assert.equal(String(Number(values.month)), '6');
    assert.equal(values.year, '2025');
  } finally {
    await browser.close();
  }
});
