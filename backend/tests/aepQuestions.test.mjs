import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientAnswer } from '../lib/clientAnswer.mjs';
import { matchDemographicOption } from '../lib/interaction/workdayCustomDropdown.mjs';
import { lookupSensitiveSafeAnswer, isPriorAssociationQuestion } from '../lib/workdayDefaults.mjs';

test('AEP / Workday sponsorship category and conditional questions resolution', async () => {
  const profileF1 = {
    work_auth: {
      authorized_us: 'Yes',
      sponsorship_needed: 'Yes',
      visa_type: 'F-1 OPT',
    },
    experience: {
      current_company: 'Acme Corp',
    },
    personal: {
      has_relatives: false,
    },
    eeo: {
      veteran_status: 'I am not a veteran',
    },
  };

  const profileH1B = {
    work_auth: {
      authorized_us: 'Yes',
      sponsorship_needed: 'Yes',
      visa_type: 'H1B',
    },
    experience: {
      current_company: 'Google',
    },
    personal: {},
    eeo: {
      veteran_status: 'I am not a veteran',
    },
  };

  // 1. Sponsorship Category must return visa_type, NOT "Yes"
  const catAnswerF1 = await resolveClientAnswer(
    { label: 'For which category would you require sponsorship?*', fieldType: 'dropdown' },
    profileF1
  );
  assert.equal(catAnswerF1?.answer, 'F-1 OPT');

  const catAnswerH1B = await resolveClientAnswer(
    { label: 'For which category would you require sponsorship?*', fieldType: 'dropdown' },
    profileH1B
  );
  assert.equal(catAnswerH1B?.answer, 'H1B');

  // 2. OPT / STEM OPT follow-up
  const optAnswerF1 = await resolveClientAnswer(
    { label: 'Will you be using Optional Practical Training (OPT) or STEM OPT to begin employment at AEP?*', fieldType: 'dropdown' },
    profileF1
  );
  assert.equal(optAnswerF1?.answer, 'Yes');

  const optAnswerH1B = await resolveClientAnswer(
    { label: 'Will you be using Optional Practical Training (OPT) or STEM OPT to begin employment at AEP?*', fieldType: 'dropdown' },
    profileH1B
  );
  assert.equal(optAnswerH1B?.answer, 'No');

  // 3. Relatives employed
  const relAnswer = await resolveClientAnswer(
    { label: 'Do you have relatives employed by American Electric Power?', fieldType: 'dropdown' },
    profileF1
  );
  assert.equal(relAnswer?.answer, 'No');

  // 4. Contractor question
  const contractorAnswer = await resolveClientAnswer(
    { label: 'Are you now or have you ever been a contractor at AEP?*', fieldType: 'dropdown' },
    profileF1
  );
  assert.equal(contractorAnswer?.answer, 'No');

  // 5. Military training question
  const milAnswer = await resolveClientAnswer(
    { label: 'Do you have military training or a military certification related to this position?', fieldType: 'dropdown' },
    profileF1
  );
  assert.equal(milAnswer?.answer, 'No');
});

test('matchDemographicOption matches Workday visa options correctly', () => {
  const options = [
    'Select One',
    'F-1 Foreign Student with CPT',
    'F-1 Foreign Student with OPT',
    'F-1 Foreign Student with OPT STEM Extension',
    'H1B',
    'H1B1',
  ];

  assert.equal(matchDemographicOption('F-1 OPT', options), 'F-1 Foreign Student with OPT');
  assert.equal(matchDemographicOption('OPT', options), 'F-1 Foreign Student with OPT');
  assert.equal(matchDemographicOption('STEM OPT', options), 'F-1 Foreign Student with OPT STEM Extension');
  assert.equal(matchDemographicOption('CPT', options), 'F-1 Foreign Student with CPT');
  assert.equal(matchDemographicOption('H-1B', options), 'H1B');
  assert.equal(matchDemographicOption('H1B', options), 'H1B');
  assert.equal(matchDemographicOption('H1B1', options), 'H1B1');
});

test('resolvePostalCodeWithContext recovers and formats postal codes using location context', async () => {
  const { resolvePostalCodeWithContext } = await import('../lib/clientContact.mjs');

  const testProfile = {
    personal: {
      country: 'United States',
      state: 'Ohio',
      city: 'Columbus',
      postal_code: 'INVALID_ZIP',
    },
    qa_answers: {},
    _supabaseQa: {
      'postal code': '43215',
    },
  };

  const recovered = await resolvePostalCodeWithContext({
    country: 'United States',
    state: 'Ohio',
    city: 'Columbus',
    profile: testProfile,
  });

  assert.equal(recovered, '43215');
});

test('repairRequiredFieldsFromErrors handles postal code errors cleanly', async () => {
  const { repairRequiredFieldsFromErrors } = await import('../lib/workdayErrorRepair.mjs');

  const testProfile = {
    personal: {
      country: 'United States',
      state: 'Ohio',
      city: 'Columbus',
      postal_code: '75201',
    },
    qa_answers: {},
    _supabaseQa: {
      'postal code': '43215',
    },
  };

  // Mock page object
  const mockPage = {
    locator: () => ({
      or: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
      }),
    }),
    evaluate: async () => [],
    url: () => 'https://example.myworkdayjobs.com/en-US/careers',
  };

  const filled = await repairRequiredFieldsFromErrors(
    mockPage,
    testProfile,
    'My Information',
    ['75201 is not a valid postal code for Ohio']
  );

  assert.equal(testProfile.personal.postal_code, '43215');
  assert.equal(typeof filled, 'number');
});

