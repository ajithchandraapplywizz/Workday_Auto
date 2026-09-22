import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWorkdayCompanyName, extractJobRoleFromDom } from './discovery.mjs';
import { recordClientApplication, hasPriorApplicationForCompany, hasPriorApplicationForTenant } from './applicationHistory.mjs';
import { hasClientAppliedToCompany, isSupabaseConfigured } from './supabaseClient.mjs';

test('extractWorkdayCompanyName extracts first segment before first dot as company name', () => {
  // Test 1: Motorola Solutions example
  assert.equal(
    extractWorkdayCompanyName('https://motorolasolutions.wd5.myworkdayjobs.com/en-US/Careers/job/Software-Engineer-Intern_R68829'),
    'motorolasolutions'
  );

  // Test 2: Workday example
  assert.equal(
    extractWorkdayCompanyName('https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Senior-Technical-Advisory-Consultant----Extend---Workday-Success-Plans_JR-0109443'),
    'workday'
  );

  // Test 3: NYUHS example
  assert.equal(
    extractWorkdayCompanyName('https://nyuhs.wd12.myworkdayjobs.com/nyuhscareers1/job/Remote-Johnson-City-NY-13790/Epic-Radiant-Analyst_R0000016305'),
    'nyuhs'
  );

  // Test 4: Without protocol
  assert.equal(
    extractWorkdayCompanyName('nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Senior-Software-Engineer'),
    'nvidia'
  );

  // Test 5: Empty/invalid input
  assert.equal(extractWorkdayCompanyName(''), '');
  assert.equal(extractWorkdayCompanyName(null), '');
});

test('extractJobRoleFromDom extracts role from fallback URL slug when DOM is not present', async () => {
  const role1 = await extractJobRoleFromDom(null, 'https://motorolasolutions.wd5.myworkdayjobs.com/en-US/Careers/job/Software-Engineer-Intern_R68829');
  assert.equal(role1, 'Software Engineer Intern');

  const role2 = await extractJobRoleFromDom(null, 'https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Senior-Technical-Advisory-Consultant----Extend---Workday-Success-Plans_JR-0109443');
  assert.equal(role2, 'Senior Technical Advisory Consultant Extend Workday Success Plans');

  const role3 = await extractJobRoleFromDom(null, 'https://nyuhs.wd12.myworkdayjobs.com/nyuhscareers1/job/Remote-Johnson-City-NY-13790/Epic-Radiant-Analyst_R0000016305');
  assert.equal(role3, 'Epic Radiant Analyst');
});

test('extractJobRoleFromDom extracts role from page DOM elements when available', async () => {
  const fakePage = {
    evaluate: async (fn) => {
      return 'Staff Software Engineer';
    },
    url: () => 'https://motorolasolutions.wd5.myworkdayjobs.com/en-US/Careers/job/Staff-Software-Engineer_R12345',
  };
  const role = await extractJobRoleFromDom(fakePage);
  assert.equal(role, 'Staff Software Engineer');
});

test('recordClientApplication extracts company and role automatically and updates profile', async () => {
  const profile = {
    _applyWizzId: 'TEST-AWL-99999',
    personal: { full_name: 'Test Candidate' },
  };
  const url = 'https://motorolasolutions.wd5.myworkdayjobs.com/en-US/Careers/job/Software-Engineer-Intern_R68829';
  const row = await recordClientApplication(profile, {
    url,
    status: 'started',
    jobTitle: 'Software Engineer Intern',
  });

  assert.equal(profile._company, 'motorolasolutions');
  assert.equal(profile._jobTitle, 'Software Engineer Intern');
  assert.equal(row.company, 'motorolasolutions');
  assert.equal(row.role_title, 'Software Engineer Intern');
});

test('hasPriorApplicationForCompany returns false for unknown client/company', async () => {
  const hasApp = await hasPriorApplicationForCompany('NON_EXISTENT_ID_XYZ', 'unknowncompany123');
  assert.equal(hasApp, false);
});
