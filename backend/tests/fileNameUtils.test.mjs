import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJobRoleFromPage,
  cleanJobRole,
  sanitizeForFileName,
  buildDocumentFileName,
} from '../lib/fileNameUtils.mjs';

test('cleanJobRole removes boilerplate prefixes correctly', () => {
  assert.equal(cleanJobRole('Job Application for Retirement'), 'Retirement');
  assert.equal(cleanJobRole('Apply for Software Engineer'), 'Software Engineer');
  assert.equal(cleanJobRole('Application for Data Analyst'), 'Data Analyst');
  assert.equal(cleanJobRole('Applying for Cloud Architect'), 'Cloud Architect');
  assert.equal(cleanJobRole('Software Engineer'), 'Software Engineer');
});

test('extractJobRoleFromPage extracts job roles across diverse ATS title formats', () => {
  assert.equal(
    extractJobRoleFromPage('Software Engineer at Google | Greenhouse'),
    'Software Engineer'
  );
  assert.equal(
    extractJobRoleFromPage('Senior Product Manager - Stripe - LinkedIn'),
    'Senior Product Manager'
  );
  assert.equal(
    extractJobRoleFromPage('Apply | Senior Lead Business Execution Consultant | Workday'),
    'Senior Lead Business Execution Consultant'
  );
  assert.equal(
    extractJobRoleFromPage('Workday | Lead Software Engineer | Meta'),
    'Lead Software Engineer'
  );
});

test('sanitizeForFileName creates clean, OS-safe file string tokens', () => {
  assert.equal(sanitizeForFileName('John Doe'), 'John_Doe');
  assert.equal(sanitizeForFileName('Sr. Product Manager (Remote)'), 'Sr_Product_Manager_Remote');
  assert.equal(sanitizeForFileName('C++ / Python Developer [Backend]'), 'C_Python_Developer_Backend');
  assert.equal(sanitizeForFileName('___Hello___World___'), 'Hello_World');
});

test('buildDocumentFileName generates clean professional resume and cover letter filenames', () => {
  const profile1 = {
    personal: {
      firstName: 'John',
      lastName: 'Smith',
    },
    experience: [
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
    personal: {
      firstName: 'Ravi Teja',
      lastName: 'Vadla',
    },
  };
  const workdayPageTitle = 'Apply | Senior Lead Business Execution Consultant | Workday';
  const diskFile = 'data/client-resumes/AWL-38247.pdf';

  const outputName = buildDocumentFileName(candidate, diskFile, true, workdayPageTitle);
  console.log(`  📄 [DEMO] Input Disk File: ${diskFile}`);
  console.log(`  📄 [DEMO] Live Page Title: "${workdayPageTitle}"`);
  console.log(`  ✨ [DEMO] Generated Upload Name: "${outputName}"`);

  assert.equal(outputName, 'Resume_Ravi_Teja_Vadla_Senior_Lead_Business_Execution.pdf');
});
