import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswerFromLiveOptions } from '../lib/workdayQuestionFill.mjs';

describe('Generic Dropdown Option-Based Classification & Close-Match (Tier 5)', () => {
  const mockProfile = {
    gender: 'Male',
    eeo: {
      gender: 'Male',
      race: 'Asian',
      hispanic: 'Not Hispanic or Latino',
      veteran_status: 'I am not a veteran',
      disability: 'No, I do not have a disability',
    },
    resolved_answers: [
      { question: 'Will you require sponsorship?', answer: 'No' },
      { question: 'Employment Type', answer: 'Full-time' },
      { question: 'Highest Level of Education Completed', answer: "Bachelor's Degree" },
    ],
    work_authorization: 'US Citizen',
  };

  it('classifies "Please select from the dropdown menu below.*" as Gender when options are Male/Female', () => {
    const liveOptions = ['Male', 'Female', 'I choose not to disclose'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'Male');
  });

  it('classifies "Please select from the dropdown menu below.*" as Gender for Female candidate', () => {
    const liveOptions = ['Male', 'Female', 'I choose not to disclose'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: { ...mockProfile, eeo: { ...mockProfile.eeo, gender: 'Female' } },
    });
    assert.equal(answer, 'Female');
  });

  it('classifies "Please select from the dropdown menu below.*" as Hispanic/Latino', () => {
    const liveOptions = ['Hispanic or Latino', 'Not Hispanic or Latino', 'Decline to self-identify'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'Not Hispanic or Latino');
  });

  it('classifies "Please select from the dropdown menu below.*" as Race/Ethnicity', () => {
    const liveOptions = [
      'American Indian or Alaska Native',
      'Asian (Not Hispanic or Latino)',
      'Black or African American',
      'White (Not Hispanic or Latino)',
      'Two or More Races',
    ];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'Asian (Not Hispanic or Latino)');
  });

  it('classifies "Please select from the dropdown menu below.*" as Veteran Status', () => {
    const liveOptions = [
      'I identify as one or more of the classifications of protected veteran',
      'I am not a protected veteran',
      'I choose not to disclose',
    ];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'I am not a protected veteran');
  });

  it('classifies "Please select from the dropdown menu below.*" as Disability Status', () => {
    const liveOptions = [
      'Yes, I have a disability, or have a history/record of having a disability',
      'No, I do not have a disability, or have a history/record of having a disability',
      'I do not wish to answer',
    ];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.ok(answer.includes('No, I do not have a disability'));
  });

  it('matches generic dropdown against profile resolved_answers (Tier 5 close match)', () => {
    const liveOptions = ['Full-time', 'Part-time', 'Temporary', 'Contractor'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select an option.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'Full-time');
  });

  it('matches generic dropdown with degree options against profile resolved_answers', () => {
    const liveOptions = ['High School Diploma', "Bachelor's", "Master's", 'Doctorate'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, "Bachelor's");
  });

  it('picks affirmative agreement option for unknown mandatory question at bottom of form', () => {
    const liveOptions = ['I Agree', 'I Disagree'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: {},
    });
    assert.equal(answer, 'I Agree');
  });

  it('picks consent/data-retention option for personal data retention questions', () => {
    const liveOptions = ['I consent', 'I do not consent'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Boston Dynamics would like to retain your personal data from this application for up to 2 years so we may consider you for future job opportunities. Please select from the dropdown menu below.*',
      profile: mockProfile,
    });
    assert.equal(answer, 'I consent');
  });

  it('strictly defaults to Asian for Race/Ethnicity when multiple race options are present', () => {
    const liveOptions = [
      'Asian (United States of America)',
      'Black or African American (United States of America)',
      'Hispanic or Latino (United States of America)',
      'White (United States of America)',
      'I do not wish to answer. (United States of America)',
    ];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: { eeo: { race: 'Asian' } },
    });
    assert.equal(answer, 'Asian (United States of America)');
  });

  it('falls back to safe non-empty option when completely unknown so form does not halt', () => {
    const liveOptions = ['Option Alpha', 'Option Beta', 'Option Gamma'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: {},
    });
    assert.equal(answer, 'Option Alpha');
  });

  it('matches options against candidate experience, skills, and resume text', () => {
    const profileWithDeepData = {
      experience: [
        { title: 'Senior Software Engineer', company: 'Google' },
      ],
      skills: ['Python', 'TypeScript', 'Kubernetes'],
      resumeText: 'Experienced in distributed cloud architectures and DevOps pipelines.',
    };
    const liveOptions = ['Data Analyst', 'DevOps', 'Sales Associate', 'Marketing Manager'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: profileWithDeepData,
    });
    assert.equal(answer, 'DevOps');
  });

  it('matches candidate referral source from profile', () => {
    const profileWithSource = {
      source: 'LinkedIn',
    };
    const liveOptions = ['Company Career Site', 'Indeed', 'LinkedIn', 'Job Fair', 'Employee Referral'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select an option.*',
      profile: profileWithSource,
    });
    assert.equal(answer, 'LinkedIn');
  });

  it('matches degree from candidate education array', () => {
    const profileWithEdu = {
      education: [
        { degree: 'Master of Science in Information Technology', school: 'MIT' },
      ],
    };
    const liveOptions = ['Associate Degree', "Bachelor's Degree", "Master's Degree", 'Doctorate'];
    const answer = resolveAnswerFromLiveOptions({
      liveOptions,
      labelText: 'Please select from the dropdown menu below.*',
      profile: profileWithEdu,
    });
    assert.equal(answer, "Master's Degree");
  });
});
