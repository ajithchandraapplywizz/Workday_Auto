import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJobRoleFromPage,
  cleanJobRole,
  abbreviateJobRole,
  sanitizeForFileName,
  buildDocumentFileName,
  getExactResumeFileName,
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

test('abbreviateJobRole merges the first letter of every word in uppercase', () => {
  assert.equal(abbreviateJobRole('Software Engineer'), 'SE');
  assert.equal(abbreviateJobRole('Data Analyst'), 'DA');
  assert.equal(abbreviateJobRole('Senior Product Manager'), 'SPM');
  assert.equal(abbreviateJobRole('Senior Lead Business Execution Consultant'), 'SLBEC');
  assert.equal(abbreviateJobRole('Apply for Full Stack Developer'), 'FSD');
  assert.equal(abbreviateJobRole(''), '');
});

test('buildDocumentFileName generates strict Resume_<Name_of_Client>_<ShortRole> filenames', () => {
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
    'Resume_John_Smith_SE.pdf'
  );

  assert.equal(
    buildDocumentFileName(profile1, 'cover.docx', false, 'Senior Product Manager - Stripe - LinkedIn'),
    'CoverLetter_John_Smith_SPM.docx'
  );

  const profile2 = {
    personal: {
      first_name: 'Jane',
      last_name: 'Doe',
    },
    work_experience: [
      { job_title: 'Data Analyst' },
    ],
  };

  // When no page title provided, falls back to profile's most recent experience
  assert.equal(
    buildDocumentFileName(profile2, 'resume.pdf', true),
    'Resume_Jane_Doe_DA.pdf'
  );

  // Explicit _roleTitle and flat client name fallback
  assert.equal(
    buildDocumentFileName({ name: 'Manisha Medasani', _roleTitle: 'Data Analyst' }, 'AWL-35049.pdf', true),
    'Resume_Manisha_Medasani_DA.pdf'
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

  assert.equal(outputName, 'Resume_Ravi_Teja_Vadla_SLBEC.pdf');
});

test('getExactResumeFileName: preserves the exact authentic resume filename for Stage 3 submissions', () => {
  // 1. From CRM S3 URL in raw_profile_json
  const profileWithCrm = {
    applywizz_id: 'AWL-35049',
    _dbClient: {
      raw_profile_json: {
        additional_information: {
          resume_url: 'https://applywizz-prod-v2.s3.us-east-2.amazonaws.com/CRM/AWL-35049-17112026-1514-resume_manisha-medasani_fa.pdf',
        },
      },
    },
  };
  assert.equal(
    getExactResumeFileName(profileWithCrm, 'data/client-resumes/AWL-35049.pdf'),
    'AWL-35049-17112026-1514-resume_manisha-medasani_fa.pdf'
  );

  // 2. From direct client resume_url
  const profileWithDirectUrl = {
    applywizz_id: 'AWL-46680',
    resume_url: 'https://applywizz-prod-v2.s3.us-east-2.amazonaws.com/CRM/AWL-46680-17112026-1024-resume_vyshnavi-n_se-1-2-.pdf',
  };
  assert.equal(
    getExactResumeFileName(profileWithDirectUrl, 'resumes/AWL-46680.pdf'),
    'AWL-46680-17112026-1024-resume_vyshnavi-n_se-1-2-.pdf'
  );

  // 3. Explicit resume_filename override
  const profileWithExplicit = {
    resume_filename: 'Exact_Candidate_Resume_V2.pdf',
  };
  assert.equal(
    getExactResumeFileName(profileWithExplicit, 'resumes/any.pdf'),
    'Exact_Candidate_Resume_V2.pdf'
  );

  // 4. Fallback to disk file basename
  assert.equal(
    getExactResumeFileName({}, 'data/client-resumes/AWL-38247.pdf'),
    'AWL-38247.pdf'
  );
});

test('cachePathForClient saves resumes strictly in Resume_<Name_of_Client>_<ShortRole>.pdf format', async () => {
  const { cachePathForClient } = await import('../lib/applyWizzResume.mjs');
  const path = await import('path');

  const p1 = cachePathForClient({
    _applyWizzId: 'AWL-35049',
    personal: { firstName: 'Manisha', lastName: 'Medasani' },
    _roleTitle: 'Data Analyst',
  });
  assert.equal(path.basename(p1), 'Resume_Manisha_Medasani_DA.pdf');
  assert.ok(p1.toUpperCase().includes('AWL-35049'));

  const p2 = cachePathForClient({
    _applyWizzId: 'AWL-46680',
    name: 'John Smith',
    experience: [{ title: 'Software Engineer' }],
  });
  assert.equal(path.basename(p2), 'Resume_John_Smith_SE.pdf');
  assert.ok(p2.toUpperCase().includes('AWL-46680'));
});
