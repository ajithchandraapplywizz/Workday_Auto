import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { normalizeDiscoveredField } from '../lib/interaction/fieldSchema.mjs';
import { fillWorkdayCustomDropdown, matchDemographicOption } from '../lib/interaction/workdayCustomDropdown.mjs';
import { fillWorkdaySelectOneDropdown, fillVeteranStatusDropdown } from '../lib/workdayQuestionFill.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { REASON } from '../lib/questionEngine/answerRecord.mjs';
import { withLocalPage, openFixture } from './helpers/browser.mjs';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/voluntary-eeo.html');

const FAKE_PROFILE = {
  _applyWizzHydrated: true,
  _applyWizzQa: {
    'please select the ethnicity which most accurately describes how you identify yourself': 'Asian (United States of America)',
    'are you hispanic latino': 'No',
    'please select your gender': 'Female',
    'please select the veteran status which most accurately describes how you identify yourself': 'No, I am not a veteran',
  },
  eeo: {
    gender: 'Female',
    hispanic_latino: 'No',
    race: 'Asian (United States of America)',
    veteran_status: 'No, I am not a veteran',
  },
  personal: {},
  work_auth: {},
  education: {},
  experience: {},
  skills: [],
  qa_answers: {},
};

const EMPTY_EEO = {
  _applyWizzHydrated: true,
  _applyWizzQa: {},
  eeo: {},
  personal: {},
  work_auth: {},
  education: {},
  experience: {},
  skills: [],
  qa_answers: {},
};

function field(label, extras = {}) {
  return {
    questionId: extras.questionId || 'q',
    label,
    elementType: 'custom-dropdown',
    fieldType: 'dropdown',
    required: extras.required !== false,
    options: extras.options || [],
  };
}

test('A–D long-form EEO questions resolve from fake profile, never invent', () => {
  const ethnicity = resolveFieldWithoutLlm(
    field('Please select the ethnicity which most accurately describes how you identify yourself.'),
    FAKE_PROFILE,
  );
  assert.equal(ethnicity.answer, 'Asian (United States of America)');
  assert.equal(ethnicity.requiresReview, false);

  const hispanic = resolveFieldWithoutLlm(field('Are you Hispanic/Latino?'), FAKE_PROFILE);
  assert.equal(hispanic.answer, 'No');
  assert.equal(hispanic.requiresReview, false);

  const gender = resolveFieldWithoutLlm(field('Please select your gender.'), FAKE_PROFILE);
  assert.equal(gender.answer, 'Female');

  const veteran = resolveFieldWithoutLlm(
    field('Please select the veteran status which most accurately describes how you identify yourself.'),
    FAKE_PROFILE,
  );
  assert.equal(veteran.answer, 'No, I am not a veteran');
});

test('F missing profile EEO answer requires review — no guess', () => {
  const rec = resolveFieldWithoutLlm(
    field('Please select the ethnicity which most accurately describes how you identify yourself.'),
    EMPTY_EEO,
  );
  assert.equal(rec.requiresReview, true);
  assert.equal(rec.answer, null);
  assert.equal(rec.reasonCode, REASON.HIGH_RISK_MISSING_DATA);
});

test('G invalid demographic answer does not approximate a different option', () => {
  assert.equal(matchDemographicOption('Pacific Islander', [
    'Asian (United States of America)',
    'White (United States of America)',
  ]), null);
  assert.equal(matchDemographicOption('Asian', [
    'Asian (United States of America)',
    'White (United States of America)',
  ]), 'Asian (United States of America)');
  assert.equal(matchDemographicOption('Asian', [
    'Asian (United States of America)',
    'Asian or Pacific Islander',
  ]), null);
  assert.equal(matchDemographicOption('No, I am not a veteran', [
    'I identify as one or more of the classifications of a protected veteran',
    'I identify as a veteran, just not a protected veteran',
    'I am not a veteran',
    'I am not a protected veteran',
    'I choose not to disclose',
  ]), 'I am not a veteran');
  assert.equal(matchDemographicOption('I AM NOT A VETERAN', [
    'I am not a protected veteran',
    'I am not a veteran',
  ]), 'I am not a veteran');
});

test('normalized EEO dropdown includes widget metadata', () => {
  const fieldObj = normalizeDiscoveredField({
    label: 'Please select the ethnicity which most accurately describes how you identify yourself.*',
    fieldType: 'dropdown',
    required: true,
    currentValue: 'Select One',
    selectOneIndex: 0,
    options: [],
  });
  assert.equal(fieldObj.required, true);
  assert.equal(fieldObj.currentValue, null);
  assert.equal(fieldObj.widgetKind, 'workday-selectOne');
  assert.equal(fieldObj.optionsNeedOpen, true);
  assert.equal(fieldObj.triggerRole, 'button');
});

test('A B C D E H I J fixture: SVG custom dropdowns open, select exact fake values, and clear errors', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, FIXTURE);
    const cases = [
      ['Please select the ethnicity which most accurately describes how you identify yourself.', 'Asian (United States of America)'],
      ['Are you Hispanic/Latino?', 'No'],
      ['Please select your gender.', 'Female'],
      ['Please select the veteran status which most accurately describes how you identify yourself.', 'No, I am not a veteran'],
    ];

    for (const [label, answer] of cases) {
      const result = await fillWorkdayCustomDropdown(page, { label, fieldType: 'dropdown' }, answer);
      assert.equal(result.success, true, `${label} → ${result.reason} options=${(result.options || []).join('|')}`);
      const expectedShown = label.includes('veteran') ? 'I am not a veteran' : answer;
      assert.equal(result.verifiedValue, expectedShown);
      assert.ok(result.options.length > 0, `${label} opened with no options`);
    }

    const ethnicityError = await page.locator('[data-test-error]').isVisible();
    assert.equal(ethnicityError, false);

    const displayed = await page.locator('[data-automation-id="selectedItem"]').allTextContents();
    assert.ok(displayed.every((t) => !/^select(\s+one)?/i.test(t.trim())));
  });
});

test('shared ancestor + portal: gender click does not open ethnicity', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, FIXTURE);
    const ok = await fillWorkdaySelectOneDropdown(page, 'Please select your gender.', 'Female');
    assert.equal(ok, true);
    const gender = await page.locator('[data-test-widget="gender"] [data-automation-id="selectedItem"]').innerText();
    const ethnicity = await page.locator('[data-test-widget="ethnicity"] [data-automation-id="selectedItem"]').innerText();
    assert.equal(gender.trim(), 'Female');
    assert.match(ethnicity, /select one/i);
  });
});

test('E required dropdown succeeds; F missing answer does not click an option', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, FIXTURE);
    const missing = await fillWorkdayCustomDropdown(page, {
      label: 'Please select the ethnicity which most accurately describes how you identify yourself.',
      fieldType: 'dropdown',
    }, '');
    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'missing_answer');

    const before = await page.locator('[data-test-widget="ethnicity"] [data-automation-id="selectedItem"]').innerText();
    assert.match(before, /select one/i);

    const ok = await fillWorkdayCustomDropdown(page, {
      label: 'Please select the ethnicity which most accurately describes how you identify yourself.',
      fieldType: 'dropdown',
    }, 'White (United States of America)');
    assert.equal(ok.success, true);
    assert.equal(ok.verifiedValue, 'White (United States of America)');
  });
});

test('Voluntary Disclosures veteran dropdown clicks I am not a veteran', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, FIXTURE);
    const ok = await fillVeteranStatusDropdown(page, 'No, I am not a veteran', FAKE_PROFILE);
    assert.equal(ok, true);
    const shown = await page.locator('[data-test-widget="veteran"] [data-automation-id="selectedItem"]').innerText();
    assert.equal(shown.trim(), 'I am not a veteran');
  });
});

test('combined legal blob does not fill ethnicity when asking for veteran', async () => {
  const liveFixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/voluntary-eeo-live.html');
  await withLocalPage(async (page) => {
    await openFixture(page, liveFixture);
    const ok = await fillVeteranStatusDropdown(page, 'No, I am not a veteran', FAKE_PROFILE);
    assert.equal(ok, true);
    const veteran = await page.locator('[data-test-widget="veteran"] [data-automation-id="selectedItem"]').innerText();
    const ethnicity = await page.locator('[data-test-widget="ethnicity"] [data-automation-id="selectedItem"]').innerText();
    assert.equal(veteran.trim(), 'I am not a veteran');
    assert.match(ethnicity, /select one/i);
  });
});

test('G option not in list leaves Select One in place', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, FIXTURE);
    const result = await fillWorkdayCustomDropdown(page, {
      label: 'Please select your gender.',
      fieldType: 'dropdown',
    }, 'Declined-Unknown-Test');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'option_not_in_list');
    const shown = await page.locator('[data-test-widget="gender"] [data-automation-id="selectedItem"]').innerText();
    assert.match(shown, /select one/i);
  });
});
