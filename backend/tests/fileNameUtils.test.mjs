import test from 'node:test';
import assert from 'node:assert/strict';
import {
<<<<<<< HEAD
  cleanJobRole,
  extractJobRoleFromPage,
=======
  extractJobRoleFromPage,
  cleanJobRole,
>>>>>>> 8c2712e (all listed issues resolved)
  sanitizeForFileName,
  buildDocumentFileName,
} from '../lib/fileNameUtils.mjs';

test('cleanJobRole removes boilerplate prefixes correctly', () => {
  assert.equal(cleanJobRole('Job Application for Retirement'), 'Retirement');
  assert.equal(cleanJobRole('Apply for Software Engineer'), 'Software Engineer');
  assert.equal(cleanJobRole('Application for Data Analyst'), 'Data Analyst');
<<<<<<< HEAD
  assert.equal(cleanJobRole('apply to Cloud Engineer'), 'Cloud Engineer');
  assert.equal(cleanJobRole('Applying for Product Manager'), 'Product Manager');
  assert.equal(cleanJobRole('Software Engineer'), 'Software Engineer');
  assert.equal(cleanJobRole(''), '');
});

test('extractJobRoleFromPage extracts job roles across diverse ATS title formats', () => {
  // Format: "Job Title at Company | ATS"
=======
  assert.equal(cleanJobRole('Applying for Cloud Architect'), 'Cloud Architect');
  assert.equal(cleanJobRole('Software Engineer'), 'Software Engineer');
});

test('extractJobRoleFromPage extracts job roles across diverse ATS title formats', () => {
>>>>>>> 8c2712e (all listed issues resolved)
  assert.equal(
    extractJobRoleFromPage('Software Engineer at Google | Greenhouse'),
    'Software Engineer'
  );
<<<<<<< HEAD

  // Format: "Job Title - Company - Platform"
=======
>>>>>>> 8c2712e (all listed issues resolved)
  assert.equal(
    extractJobRoleFromPage('Senior Product Manager - Stripe - LinkedIn'),
    'Senior Product Manager'
  );
<<<<<<< HEAD

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
=======
  assert.equal(
    extractJobRoleFromPage('Apply | Senior Lead Business Execution Consultant | Workday'),
    'Senior Lead Business Execution Consultant'
  );
  assert.equal(
    extractJobRoleFromPage('Workday | Lead Software Engineer | Meta'),
    'Lead Software Engineer'
>>>>>>> 8c2712e (all listed issues resolved)
  );
});

test('sanitizeForFileName creates clean, OS-safe file string tokens', () => {
<<<<<<< HEAD
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
=======
  assert.equal(sanitizeForFileName('John Doe'), 'John_Doe');
  assert.equal(sanitizeForFileName('Sr. Product Manager (Remote)'), 'Sr_Product_Manager_Remote');
  assert.equal(sanitizeForFileName('C++ / Python Developer [Backend]'), 'C_Python_Developer_Backend');
  assert.equal(sanitizeForFileName('___Hello___World___'), 'Hello_World');
});

test('buildDocumentFileName generates clean professional resume and cover letter filenames', () => {
  const profile1 = {
>>>>>>> 8c2712e (all listed issues resolved)
    personal: {
      firstName: 'John',
      lastName: 'Smith',
    },
    experience: [
<<<<<<< HEAD
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
=======
      { title: 'Software Engineer' },
    ],
  };

  assert.equal(
    buildDocumentFileName(profile1, 'old_resume.pdf', true, 'Software Engineer at Google | Greenhouse'),
    'Resume_John_Smith_Software_Engineer.pdf'
  );

  assert.equal(
    buildDocumentFileName(profile1, 'cover.docx', false, 'Senior Product Manager - Stripe - LinkedIn'),
    'CoverLetter_John_Smith_Senior_Product_Manager.docx'
  );

  const profile2 = {
    personal: {
      first_name: 'Jane',
      last_name: 'Doe',
    },
    work_experience: [
      { job_title: 'Senior Product Manager' },
    ],
  };

  // When no page title provided, falls back to profile's most recent experience
  assert.equal(
    buildDocumentFileName(profile2, 'resume.pdf', true),
    'Resume_Jane_Doe_Senior_Product_Manager.pdf'
  );

  // When no job role found at all, formats with names only
  assert.equal(
    buildDocumentFileName({ personal: { firstName: 'Alice', lastName: 'Wonderland' } }, 'test.pdf', true),
    'Resume_Alice_Wonderland.pdf'
  );

  // When profile is empty
  assert.equal(
    buildDocumentFileName({}, 'document.pdf', true),
    'resume.pdf'
  );
  assert.equal(
    buildDocumentFileName({}, 'document.pdf', false),
    'cover_letter.pdf'
  );
});

test('DEMO APPLICATION: End-to-end Workday candidate resume naming', () => {
  const candidate = {
>>>>>>> 8c2712e (all listed issues resolved)
    personal: {
      firstName: 'Ravi Teja',
      lastName: 'Vadla',
    },
<<<<<<< HEAD
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
=======
  };
  const workdayPageTitle = 'Apply | Senior Lead Business Execution Consultant | Workday';
  const diskFile = 'data/client-resumes/AWL-38247.pdf';

  const outputName = buildDocumentFileName(candidate, diskFile, true, workdayPageTitle);
  console.log(`  📄 [DEMO] Input Disk File: ${diskFile}`);
  console.log(`  📄 [DEMO] Live Page Title: "${workdayPageTitle}"`);
  console.log(`  ✨ [DEMO] Generated Upload Name: "${outputName}"`);

  assert.equal(outputName, 'Resume_Ravi_Teja_Vadla_Senior_Lead_Business_Execution.pdf');
>>>>>>> 8c2712e (all listed issues resolved)
});
