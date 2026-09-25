import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeWorkdayDefaultExperienceEducation,
  WORKDAY_DEFAULT_EXPERIENCE,
  WORKDAY_DEFAULT_EDUCATION,
} from './workdayExperience.mjs';
import { mapApplyWizzToProfile, buildApplyWizzQaIndex } from './applyWizzClient.mjs';

test('mapApplyWizzToProfile populates experience and university from Supabase/API data', () => {
  const client = {
    full_name: 'John Doe',
    company_email: 'john@example.com',
  };
  const info = {
    university_name: 'Stanford University',
    highest_education: "Master's",
    main_subject: 'Computer Science',
    graduation_year: '2024',
    latest_company: 'Acme Corp',
    location: 'San Francisco, CA',
    from_date: '01/2022',
    to_date: '05/2024',
    currently_working: false,
    experience: '3',
    role: 'Software Engineer',
  };

  const overlay = mapApplyWizzToProfile(client, info);

  assert.equal(overlay.education.university, 'Stanford University');
  assert.equal(overlay.education.degree, "Master's");
  assert.equal(overlay.education.major, 'Computer Science');
  assert.equal(overlay.education.to_year, '2024');

  assert.equal(overlay.experience.current_company, 'Acme Corp');
  assert.equal(overlay.experience.current_title, 'Software Engineer');
  assert.equal(overlay.experience.location, 'San Francisco, CA');
  assert.equal(overlay.experience.from_date, '01/2022');
  assert.equal(overlay.experience.to_date, '05/2024');
  assert.equal(overlay.experience.currently_working, false);

  const qa = buildApplyWizzQaIndex(client, info);
  assert.equal(qa['school or university'], 'Stanford University');
  assert.equal(qa['company'], 'Acme Corp');
  assert.equal(qa['current company'], 'Acme Corp');
  assert.equal(qa['work from'], '01/2022');
  assert.equal(qa['work to'], '05/2024');
});

test('mergeWorkdayDefaultExperienceEducation preserves real university and experience without wiping', () => {
  const profile = {
    education: {
      university: 'MIT',
      degree: "Bachelor's",
      major: 'Artificial Intelligence',
    },
    experience: {
      current_company: 'OpenAI',
      current_title: 'Research Engineer',
      from_date: '06/2023',
    },
  };

  const merged = mergeWorkdayDefaultExperienceEducation(profile);
  assert.equal(merged.education.university, 'MIT');
  assert.equal(merged.education.degree, "Bachelor's");
  assert.equal(merged.experience.current_company, 'OpenAI');
  assert.equal(merged.experience.current_title, 'Research Engineer');
  assert.equal(merged.experience.from_date, '06/2023');
});

test('mergeWorkdayDefaultExperienceEducation falls back to defaults when fields are empty', () => {
  const emptyProfile = {};
  const merged = mergeWorkdayDefaultExperienceEducation(emptyProfile);
  assert.equal(merged.education.university, 'Other');
  assert.equal(merged.education.degree, "Bachelor's");
  assert.equal(merged.experience.current_company, WORKDAY_DEFAULT_EXPERIENCE.current_company);
});

test('mapApplyWizzToProfile correctly maps candidate AWL-31213 profile with Walmart, current role, and Masters', () => {
  const client = {
    full_name: 'Naveen Kumar Kondapalli',
    company_email: 'naveen.kumar@applywizz.ai',
  };
  const info = {
    role: 'Software Developer',
    latest_company: 'Walmart',
    location: 'USA',
    from_date: 'Aug 2024',
    to_date: null,
    currently_working: true,
    university_name: 'University of Memphis',
    highest_education: 'Master of Science/Masters/MS',
    main_subject: 'May 2023', // Date string should be sanitized away
    graduation_year: '2023',
    cumulative_gpa: '3.8',
  };

  const overlay = mapApplyWizzToProfile(client, info);

  assert.equal(overlay.experience.current_title, 'Software Developer');
  assert.equal(overlay.experience.current_company, 'Walmart');
  assert.equal(overlay.experience.location, 'USA');
  assert.equal(overlay.experience.from_date, 'Aug 2024');
  assert.equal(overlay.experience.currently_working, true);

  assert.equal(overlay.education.university, 'University of Memphis');
  assert.equal(overlay.education.degree, 'Master of Science/Masters/MS');
  assert.equal(overlay.education.major, ''); // sanitized: was a date string "May 2023"
  assert.equal(overlay.education.to_year, '2023');
  assert.equal(overlay.education.gpa, '3.8');

  // Verify merged profile defaults preserve candidate's real data
  const merged = mergeWorkdayDefaultExperienceEducation(overlay);
  assert.equal(merged.experience.current_title, 'Software Developer');
  assert.equal(merged.experience.current_company, 'Walmart');
  assert.equal(merged.education.university, 'University of Memphis');
  assert.equal(merged.education.degree, 'Master of Science/Masters/MS');
  assert.equal(merged.education.major, 'Computer Science'); // fills default since May 2023 was sanitized
});

