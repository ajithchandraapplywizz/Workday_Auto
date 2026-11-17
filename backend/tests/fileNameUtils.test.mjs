import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanJobRole,
  extractJobRoleFromPage,
  sanitizeForFileName,
  buildDocumentFileName,
} from '../lib/fileNameUtils.mjs';

test('cleanJobRole removes boilerplate prefixes correctly', () => {
  assert.equal(cleanJobRole('Job Application for Retirement'), 'Retirement');
  assert.equal(cleanJobRole('Apply for Software Engineer'), 'Software Engineer');
  assert.equal(cleanJobRole('Application for Data Analyst'), 'Data Analyst');
  assert.equal(cleanJobRole('apply to Cloud Engineer'), 'Cloud Engineer');
  assert.equal(cleanJobRole('Applying for Product Manager'), 'Product Manager');
  assert.equal(cleanJobRole('Software Engineer'), 'Software Engineer');
  assert.equal(cleanJobRole(''), '');
});

test('extractJobRoleFromPage extracts job roles across diverse ATS title formats', () => {
  // Format: "Job Title at Company | ATS"
  assert.equal(
    extractJobRoleFromPage('Software Engineer at Google | Greenhouse'),
    'Software Engineer'
  );

  // Format: "Job Title - Company - Platform"
  assert.equal(
    extractJobRoleFromPage('Senior Product Manager - Stripe - LinkedIn'),
    'Senior Product Manager'
  );

  // Format: "Platform | Job Title | ATS"
  assert.equal(
    extractJobRoleFromPage('Apply | Software Engineer | Workday'),
    'Software Engineer'
  );

  // ATS Suffix Stripping
  assert.equal(
    extractJobRoleFromPage('Staff Site Reliability Engineer | Lever'),
    'Staff Site Reliability Engineer'
  );
  assert.equal(
    extractJobRoleFromPage('Lead Security Architect | Ashby'),
    'Lead Security Architect'
  );

  // Workday Career site format
  assert.equal(
    extractJobRoleFromPage('Job Application for Senior DevOps Engineer - Wells Fargo'),
    'Senior DevOps Engineer'
  );
});

test('sanitizeForFileName creates clean, OS-safe file string tokens', () => {
  assert.equal(sanitizeForFileName('John Smith'), 'John_Smith');
  assert.equal(sanitizeForFileName('C++ / Python: Senior Dev?'), 'C_Python_Senior_Dev');
  assert.equal(sanitizeForFileName('---___Special___--'), 'Special');
  assert.equal(
    sanitizeForFileName('This is an extremely long job title that exceeds thirty characters by a lot', 30),
    'This_is_an_extremely_long_job'
  );
});

test('buildDocumentFileName generates clean professional resume and cover letter filenames', () => {
  const profile = {
    personal: {
      firstName: 'John',
      lastName: 'Smith',
    },
    experience: [
      { title: 'Full Stack Engineer' },
    ],
  };

  // Case 1: Page title present
  const res1 = buildDocumentFileName(
    profile,
    'AWL-1568.pdf',
    true,
    'Software Engineer at Google | Greenhouse'
  );
  assert.equal(res1, 'Resume_John_Smith_Software_Engineer.pdf');

  // Case 2: Word document extension (.docx) preserved
  const res2 = buildDocumentFileName(
    profile,
    'my_old_resume.docx',
    true,
    'Senior Product Manager - Stripe - LinkedIn'
  );
  assert.equal(res2, 'Resume_John_Smith_Senior_Product_Manager.docx');

  // Case 3: Cover letter mode
  const res3 = buildDocumentFileName(
    profile,
    'raw_letter.pdf',
    false,
    'Senior Product Manager - Stripe - LinkedIn'
  );
  assert.equal(res3, 'CoverLetter_John_Smith_Senior_Product_Manager.pdf');

  // Case 4: No page title -> fallback to profile experience[0].title
  const res4 = buildDocumentFileName(profile, 'AWL-1568.pdf', true, '');
  assert.equal(res4, 'Resume_John_Smith_Full_Stack_Engineer.pdf');

  // Case 5: No role found anywhere -> clean name only
  const res5 = buildDocumentFileName(
    { personal: { firstName: 'Jane', lastName: 'Doe' } },
    'cv.pdf',
    true,
    ''
  );
  assert.equal(res5, 'Resume_Jane_Doe.pdf');

  // Case 6: Empty profile -> fallback
  const res6 = buildDocumentFileName({}, 'test.pdf', true, '');
  assert.equal(res6, 'resume.pdf');
});

test('DEMO APPLICATION: End-to-end Workday candidate resume naming', () => {
  // Real candidate structure from database
  const candidateProfile = {
    _applyWizzId: 'AWL-38247',
    personal: {
      firstName: 'Ravi Teja',
      lastName: 'Vadla',
    },
    _roleTitle: 'Senior Lead Business Execution Consultant',
  };

  const storedDiskFile = 'data/client-resumes/AWL-38247.pdf';
  const liveWorkdayPageTitle = 'Apply | Senior Lead Business Execution Consultant | Workday';

  const generatedFileName = buildDocumentFileName(
    candidateProfile,
    storedDiskFile,
    true,
    liveWorkdayPageTitle
  );

  console.log(`\n  📄 [DEMO] Input Disk File: ${storedDiskFile}`);
  console.log(`  📄 [DEMO] Live Page Title: "${liveWorkdayPageTitle}"`);
  console.log(`  ✨ [DEMO] Generated Upload Name: "${generatedFileName}"\n`);

  assert.equal(
    generatedFileName,
    'Resume_Ravi_Teja_Vadla_Senior_Lead_Business_Execution.pdf'
  );
  assert.ok(generatedFileName.startsWith('Resume_Ravi_Teja_Vadla_'));
  assert.ok(generatedFileName.endsWith('.pdf'));
});
