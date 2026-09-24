import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientAnswer, deriveAdultDobFromProfile } from '../lib/clientAnswer.mjs';
import { extractDobFromResumeText } from '../lib/resumeParser.mjs';
import { formatToMMDDYYYY } from '../lib/fillHandlers.mjs';

test('DOB Test 1: Resolves candidate DOB from Supabase Tier 1 (_supabaseQa) and formats as MM/DD/YYYY', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {
      'date of birth': '1998-04-12',
    },
    personal: {},
  };

  const hit = await resolveClientAnswer({
    label: 'Date of Birth (MM/DD/YYYY)',
    required: true,
  }, profile);

  assert.ok(hit, 'Expected DOB hit from Supabase');
  assert.equal(hit.answer, '04/12/1998');
});

test('DOB Test 2: Resolves candidate DOB from ApplyWizz CRM / personal profile', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    personal: {
      date_of_birth: '1999-07-25',
    },
  };

  const hit = await resolveClientAnswer({
    label: 'Please enter your birth date *',
    required: true,
  }, profile);

  assert.ok(hit, 'Expected DOB hit from profile');
  assert.equal(hit.answer, '07/25/1999');
});

test('DOB Test 3: Extracts DOB from resume text when missing from database', async () => {
  const resumeText = `
John Doe
Software Engineer
Contact: john@example.com
Date of Birth: 15/08/1997
Education:
B.Tech in Computer Science, 2019
`;

  const extracted = extractDobFromResumeText(resumeText);
  assert.equal(extracted, '08/15/1997');

  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    personal: {},
    _resumeText: resumeText,
  };

  const hit = await resolveClientAnswer({
    label: 'DOB (Month/Day/Year) *',
    required: true,
  }, profile);

  assert.ok(hit, 'Expected DOB hit from resume text');
  assert.equal(hit.answer, '08/15/1997');
});

test('DOB Test 4: Derives valid adult DOB when field is REQUIRED and missing from all sources', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    personal: {},
    education: {
      graduation_year: '2022',
      degree: "Bachelor's Degree",
    },
  };

  // If REQUIRED, it must derive a valid adult date so the application is not blocked
  const hit = await resolveClientAnswer({
    label: 'Date of Birth *',
    required: true,
  }, profile);

  assert.ok(hit, 'Expected derived adult DOB for required field');
  assert.equal(hit.answer, '06/15/2000'); // 2022 - 22 = 2000
});

test('DOB Test 5: Skips DOB when field is OPTIONAL and missing from all sources', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    personal: {},
    education: {
      graduation_year: '2022',
    },
  };

  // If OPTIONAL, do NOT guess or fill (focus only on required fields)
  const hit = await resolveClientAnswer({
    label: 'Date of Birth (Optional)',
    required: false,
  }, profile);

  assert.equal(hit, null, 'Optional DOB should not be filled when not on file');
});

test('DOB Test 6: deriveAdultDobFromProfile ensures 18+ adult date', () => {
  const p1 = { education: { to_year: '2020' } };
  assert.equal(deriveAdultDobFromProfile(p1), '06/15/1998');

  const p2 = { experience: { from_date: '08/2021' } };
  assert.equal(deriveAdultDobFromProfile(p2), '06/15/1999');

  const pEmpty = {};
  const fallback = deriveAdultDobFromProfile(pEmpty);
  assert.match(fallback, /^06\/15\/\d{4}$/);
  const birthYear = Number(fallback.split('/')[2]);
  const currentYear = new Date().getFullYear();
  assert.ok(currentYear - birthYear >= 18, 'Fallback must be at least 18 years old');
});
