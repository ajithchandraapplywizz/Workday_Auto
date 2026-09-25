import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { withLocalPage, openFixture } from '../helpers/browser.mjs';
import { discoverFormFieldQuestions } from '../../lib/workdayDom.mjs';

test('Allied Solutions fixture asserts exact full labels without sentence splitting', async () => {
  await withLocalPage(async (page) => {
    const fixturePath = resolve(process.cwd(), 'tests/fixtures/allied_solutions.html');
    await openFixture(page, fixturePath);

    const questions = await discoverFormFieldQuestions(page);
    const labels = questions.map((q) => q.label);

    // 1. Sponsorship — contains "e.g." abbreviation dot; must NOT split at "e"
    const sponsorship = labels.find((l) => /sponsorship/i.test(l));
    assert.equal(
      sponsorship,
      'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?'
    );

    // 2. Diploma — contains "G.E.D." abbreviation dots; must NOT split at "G"
    const diploma = labels.find((l) => /diploma/i.test(l));
    assert.equal(
      diploma,
      'Do you possess a high school diploma, G.E.D. or equivalent from an accredited institution?'
    );

    // 3. Relatives — no abbreviation dots; simple sanity check
    const relatives = labels.find((l) => /relatives/i.test(l));
    assert.equal(
      relatives,
      'Do you have relatives who work for our company?'
    );

    // 4. Start Date — trailing * must be preserved (required-field marker)
    //    and spinbuttons Month/Day/Year must read back full MM/DD/YYYY, not just single segment
    const startDate = questions.find((q) => /start date/i.test(q.label));
    assert.equal(
      startDate?.label,
      'Availability/Start Date:*'
    );
    assert.equal(
      startDate?.currentValue,
      '09/20/2026',
      `Date spinbutton readback must be full MM/DD/YYYY (09/20/2026), got: ${startDate?.currentValue}`
    );

    // 5. Salary — trailing )* after the question mark; full text must be kept
    const salary = labels.find((l) => /salary/i.test(l));
    assert.equal(
      salary,
      'What is your desired salary range for the position you are applying to? (Please state either annual or hourly range)*'
    );

    // 6. PROOF LABEL — unseen label combining both e.g. and G.E.D. in the same
    //    sentence. This proves the fix is general and not special-cased for the
    //    5 known fields above.
    const proofLabel = labels.find((l) => /qualifying credential/i.test(l));
    assert.equal(
      proofLabel,
      'Do you hold a qualifying credential (e.g., a high school diploma, G.E.D. or equivalent) recognized in your country?'
    );
  });
});

test('Item 4: Date spinbutton readback returns full MM/DD/YYYY (12/15/2026) rather than just 12', async () => {
  await withLocalPage(async (page) => {
    const fixturePath = resolve(process.cwd(), 'tests/fixtures/allied_solutions.html');
    await openFixture(page, fixturePath);

    // Set Month=12, Day=15, Year=2026 dynamically
    await page.evaluate(() => {
      const m = document.querySelector('[data-automation-id="dateSectionMonth-input"]');
      const d = document.querySelector('[data-automation-id="dateSectionDay-input"]');
      const y = document.querySelector('[data-automation-id="dateSectionYear-input"]');
      if (m) m.value = '12';
      if (d) d.value = '15';
      if (y) y.value = '2026';
    });

    const { workdayAdapter } = await import('../../lib/orchestrator/adapters/workdayAdapter.mjs');
    const questions = await discoverFormFieldQuestions(page);
    const startDateField = questions.find((q) => /start date/i.test(q.label));
    assert.ok(startDateField, 'Start date field should be discovered');

    const read = await workdayAdapter.readValue(page, {
      questionId: startDateField.wdQId,
      label: startDateField.label,
    });

    assert.equal(
      read.current,
      '12/15/2026',
      `Date spinbutton readback must be full MM/DD/YYYY (12/15/2026), got: ${read.current}`
    );
    assert.notEqual(read.current, '12', 'Must not return just the first spinbutton value (12)');
  });
});

