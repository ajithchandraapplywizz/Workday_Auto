import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignAnswerToWorkdayOptions,
  buildApplyWizzQaIndex,
  buildResumeAnswerEntries,
  mapApplyWizzToProfile,
  isCompanyEmail,
  resolveCompanyEmail,
} from './applyWizzClient.mjs';
import { normalizeAnswerKey } from './supabaseClient.mjs';

test('buildApplyWizzQaIndex without full_address does not throw', () => {
  const qa = buildApplyWizzQaIndex(
    { full_name: 'Jane Doe', personal_email: 'j@example.com' },
    { zip_or_country: 'United States', primary_phone: '+1-555-0100', state_of_residence: 'VA' },
  );
  assert.ok(qa.country);
  assert.equal(qa.phone, '+1-555-0100');
});

test('mapApplyWizzToProfile sets names from full_name', () => {
  const overlay = mapApplyWizzToProfile(
    { full_name: 'Ajith Chandra', personal_email: 'a@example.com' },
    { zip_or_country: 'India', primary_phone: '+91 9876543210' },
  );
  assert.equal(overlay.personal.first_name, 'Ajith');
  assert.equal(overlay.personal.last_name, 'Chandra');
  assert.match(overlay.personal.country_phone_code || '', /India|\+91/i);
});

test('mapApplyWizzToProfile prefers valid company_email for application contact', () => {
  const overlay = mapApplyWizzToProfile(
    { full_name: 'Jane Doe', personal_email: 'personal@gmail.com', company_email: 'jane.doe@applywizard.ai' },
    {},
  );
  assert.equal(overlay.personal.email, 'jane.doe@applywizard.ai');
  assert.equal(overlay.personal.company_email, 'jane.doe@applywizard.ai');
  assert.equal(overlay.personal.personal_email, 'personal@gmail.com');
});

test('resolveCompanyEmail rejects personal emails and derives official company email', () => {
  assert.equal(isCompanyEmail('akshay.joshi@applywizard.ai'), true);
  assert.equal(isCompanyEmail('user@applywizz.ai'), true);
  assert.equal(isCompanyEmail('someone@gmail.com'), false);
  assert.equal(isCompanyEmail('someone@yahoo.com'), false);

  // Derives from name when given personal email
  const derived = resolveCompanyEmail({
    full_name: 'Rahul Prasad',
    company_email: 'rahulprasad8320@gmail.com',
    personal_email: 'prasadrahul599@gmail.com',
  });
  assert.equal(derived, 'rahul.prasad@applywizard.ai');

  // Fixes typo in applywzard.ai
  const typoFixed = resolveCompanyEmail({
    full_name: 'Swathi A',
    company_email: 'swathi.a@applywzard.ai',
  });
  assert.equal(typoFixed, 'swathi.a@applywizard.ai');
});

test('education maps real school name and aligns Master of Science to MS', () => {
  const overlay = mapApplyWizzToProfile(
    { full_name: 'Jane Doe' },
    { university_name: 'University of North Texas', highest_education: 'Master of Science' },
  );
  assert.equal(overlay.education.university, 'University of North Texas');
  assert.equal(
    alignAnswerToWorkdayOptions('Master of Science', ["Bachelor's", 'MS', 'PhD'], 'degree'),
    'MS',
  );

  const fallback = mapApplyWizzToProfile(
    { full_name: 'Jane Doe' },
    { highest_education: 'Bachelor of Science' },
  );
  assert.equal(fallback.education.university, 'Other');
});

test('buildResumeAnswerEntries stores top work, education, current flag, and skills', () => {
  const rows = buildResumeAnswerEntries({
    experience: {
      current_title: 'AI Platform Engineer',
      current_company: 'CHS Inc via Vizcloud',
      location: 'Dallas, TX',
      from_date: 'Jul 2025',
      to_date: '',
      currently_working: true,
    },
    education: {
      degree: 'Master of Science',
      major: 'Advanced Data Analytics',
      university: 'University of North Texas',
      from_year: '2023',
      to_year: '2025',
      highest_level: 'Master of Science',
    },
    skills: ['Python', 'Python', 'SQL'],
  });
  const answers = Object.fromEntries(rows.map((row) => [row.questionNormalized, row.answer]));
  assert.equal(answers['resume work experience role'], 'AI Platform Engineer');
  assert.equal(answers['resume work experience company'], 'CHS Inc via Vizcloud');
  assert.equal(answers['resume work experience currently working'], 'Yes');
  assert.equal(answers['resume education degree'], 'Master of Science');
  assert.equal(answers['resume education university'], 'University of North Texas');
  assert.equal(answers['resume skills'], 'Python, SQL');
  assert.ok(rows.every((row) => row.source === 'resume'));
});

test('unknown questions get stable readable keys', () => {
  assert.equal(normalizeAnswerKey('Do you require visa sponsorship?'), 'visa_sponsorship');
  assert.equal(normalizeAnswerKey('Have you used Salesforce?'), 'used_salesforce');
});
