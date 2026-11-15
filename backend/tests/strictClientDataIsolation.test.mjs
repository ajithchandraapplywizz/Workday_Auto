import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUniversalLeadQuestion } from '../lib/resolvingWorkerPool.mjs';
import { preResolveClientAnswersMap } from '../lib/jobFormCache.mjs';

test('isAllowedUniversalLeadQuestion allows only universal questions and rejects all personal/experience/education data', () => {
  // Allowed universal questions
  assert.equal(isAllowedUniversalLeadQuestion('How did you hear about us?'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Source'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Where did you hear about this opportunity?'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Race / Ethnicity'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Ethnic Background'), true);
  assert.equal(isAllowedUniversalLeadQuestion('I agree to the terms and conditions'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Do you certify that the information provided is accurate?'), true);
  assert.equal(isAllowedUniversalLeadQuestion('Privacy Policy Acknowledgment'), true);

  // Strictly rejected personal identity & contact
  assert.equal(isAllowedUniversalLeadQuestion('First Name'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Last Name'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Legal Name'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Email Address'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Phone Number'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Address Line 1'), false);
  assert.equal(isAllowedUniversalLeadQuestion('City'), false);
  assert.equal(isAllowedUniversalLeadQuestion('State / Province'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Postal Code'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Zip Code'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Signature'), false);

  // Strictly rejected Work Experience
  assert.equal(isAllowedUniversalLeadQuestion('Company'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Company Name'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Job Title'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Role Description'), false);
  assert.equal(isAllowedUniversalLeadQuestion('From Date'), false);
  assert.equal(isAllowedUniversalLeadQuestion('To Date'), false);
  assert.equal(isAllowedUniversalLeadQuestion('From'), false);
  assert.equal(isAllowedUniversalLeadQuestion('To'), false);
  assert.equal(isAllowedUniversalLeadQuestion('I currently work here'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Location'), false);

  // Strictly rejected Education
  assert.equal(isAllowedUniversalLeadQuestion('School or University'), false);
  assert.equal(isAllowedUniversalLeadQuestion('University Name'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Degree'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Field of Study'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Major'), false);
  assert.equal(isAllowedUniversalLeadQuestion('GPA'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Graduation Year'), false);

  // Strictly rejected demographics & sensitive data
  assert.equal(isAllowedUniversalLeadQuestion('Gender'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Sex'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Disability Status'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Veteran Status'), false);
  assert.equal(isAllowedUniversalLeadQuestion('Date of Birth'), false);
});

test('preResolveClientAnswersMap NEVER injects fake static fallback addresses or phone numbers', async () => {
  const schema = {
    tenant: 'test_tenant',
    company: 'Test Company',
    fields_schema: [
      { label: 'Address Line 1', normalized_label: 'address line 1', is_required: true },
      { label: 'City', normalized_label: 'city', is_required: true },
      { label: 'State', normalized_label: 'state', is_required: true },
      { label: 'Postal Code', normalized_label: 'postal code', is_required: true },
      { label: 'Phone Number', normalized_label: 'phone number', is_required: true },
      { label: 'Company', normalized_label: 'company', is_required: true },
    ],
  };

  // Profile has personal name but no address, phone, or experience
  const profileWithMissingData = {
    personal: {
      first_name: 'Test',
      last_name: 'User',
      email: 'test@example.com',
    },
    experience: {},
    education: {},
    _supabaseQa: {},
  };

  const resolved = await preResolveClientAnswersMap({
    jobUrl: 'https://test.wd5.myworkdayjobs.com/Careers/job/Test_JR1',
    schema,
    profile: profileWithMissingData,
  });

  // Verify that fake strings like 'Hartford', '06085', '88 South Main Street', '2035550199' are NEVER present
  assert.notEqual(resolved['address line 1'], '88 South Main Street');
  assert.notEqual(resolved['city'], 'Hartford');
  assert.notEqual(resolved['state'], 'Connecticut');
  assert.notEqual(resolved['postal code'], '06085');
  assert.notEqual(resolved['phone number'], '2035550199');
  assert.notEqual(resolved['company'], 'Client: Mizuho Securities');

  // Verify missing fields remain undefined / un-resolved
  assert.equal(resolved['address line 1'], undefined);
  assert.equal(resolved['city'], undefined);
  assert.equal(resolved['state'], undefined);
  assert.equal(resolved['postal code'], undefined);
  assert.equal(resolved['phone number'], undefined);
  assert.equal(resolved['company'], undefined);
});

test('Lead distribution filtering strictly strips personal and experience data for sibling candidates', () => {
  const leadCandidateId = 'AWL-LEAD';
  const siblingCandidateId = 'AWL-SIBLING';

  const leadAnswers = [
    { question: 'First Name', answer: 'Alice', is_answered: true },
    { question: 'Last Name', answer: 'Smith', is_answered: true },
    { question: 'Email Address', answer: 'alice@example.com', is_answered: true },
    { question: 'Address Line 1', answer: '123 Main St', is_answered: true },
    { question: 'Company', answer: 'Client: Mizuho Securities', is_answered: true },
    { question: 'Job Title', answer: 'Sr. Data Engineer', is_answered: true },
    { question: 'Gender', answer: 'Female', is_answered: true },
    { question: 'How did you hear about us?', answer: 'LinkedIn', is_answered: true },
    { question: 'I agree to terms and conditions', answer: 'Yes', is_answered: true },
    { question: 'Race / Ethnicity', answer: 'Asian', is_answered: true },
  ];

  // Sibling candidate receives ONLY universal questions from lead
  const filteredForSibling = leadAnswers.filter((a) => isAllowedUniversalLeadQuestion(a.question));

  const siblingQuestions = filteredForSibling.map((a) => a.question);
  assert.ok(siblingQuestions.includes('How did you hear about us?'));
  assert.ok(siblingQuestions.includes('I agree to terms and conditions'));
  assert.ok(siblingQuestions.includes('Race / Ethnicity'));

  // Personal and experience data MUST NOT be present
  assert.ok(!siblingQuestions.includes('First Name'));
  assert.ok(!siblingQuestions.includes('Last Name'));
  assert.ok(!siblingQuestions.includes('Email Address'));
  assert.ok(!siblingQuestions.includes('Address Line 1'));
  assert.ok(!siblingQuestions.includes('Company'));
  assert.ok(!siblingQuestions.includes('Job Title'));
  assert.ok(!siblingQuestions.includes('Gender'));
});

test('Work Experience and EEO profile facts take precedence over contaminated resolved_answers in Stage 3', async () => {
  const { resolveAnswer } = await import('../lib/workdayExperience.mjs');

  const candidateProfile = {
    experience: {
      current_company: 'Genuine Company LLC',
      current_title: 'Genuine Data Engineer',
      location: 'New York, NY',
      from_date: '06/2023',
      currently_working: true,
      description: 'Built data pipelines in Python and SQL.',
    },
    education: {
      university: 'State University',
      degree: 'Bachelor of Science',
      major: 'Computer Science',
    },
    eeo: {
      gender: 'Male',
      race: 'Asian',
      veteran_status: 'I am not a protected veteran',
    },
  };

  // Even if a contaminated resolved_answers has another client's details:
  const staleAnswersMap = new Map([
    ['company', 'Client: Mizuho Securities'],
    ['job title', 'Sr. Data Engineer'],
    ['school or university', 'Old School'],
  ]);

  // Candidate experience facts take precedence
  const resolvedCompany = await resolveAnswer(
    'Company',
    'experience.current_company',
    'Company',
    candidateProfile,
    staleAnswersMap,
    'https://example.com',
    'text'
  );
  assert.equal(resolvedCompany, 'Genuine Company LLC');
  assert.notEqual(resolvedCompany, 'Client: Mizuho Securities');

  const resolvedTitle = await resolveAnswer(
    'Job Title',
    'experience.current_title',
    'Job Title',
    candidateProfile,
    staleAnswersMap,
    'https://example.com',
    'text'
  );
  assert.equal(resolvedTitle, 'Genuine Data Engineer');
  assert.notEqual(resolvedTitle, 'Sr. Data Engineer');
});

test('Stage 1 Scraping strictly filters optional fields and keeps only required/mandatory questions', async () => {
  const { isSkippableUnimportantLabel, hasRequiredSignal } = await import('../lib/scanFieldFilter.mjs');

  const sampleFields = [
    { label: 'First Name*', required: true },
    { label: 'Last Name*', required: true },
    { label: 'Middle Name', required: false },
    { label: 'Email*', required: true },
    { label: 'Phone Number', required: false }, // Phone is always mandatory
    { label: 'Address Line 2', required: false },
    { label: 'Cover Letter', required: false },
    { label: 'Certifications', required: false },
    { label: 'GPA', required: false },
    { label: 'LinkedIn URL', required: false },
    { label: 'Twitter', required: false },
    { label: 'How did you hear about us?*', required: true },
    { label: 'Gender*', required: true },
  ];

  const scraped = sampleFields.filter(f => !isSkippableUnimportantLabel(f.label, f));
  const scrapedLabels = scraped.map(f => f.label);

  // Required and essential fields MUST be scraped
  assert.ok(scrapedLabels.includes('First Name*'));
  assert.ok(scrapedLabels.includes('Last Name*'));
  assert.ok(scrapedLabels.includes('Email*'));
  assert.ok(scrapedLabels.includes('Phone Number'));
  assert.ok(scrapedLabels.includes('How did you hear about us?*'));
  assert.ok(scrapedLabels.includes('Gender*'));

  // Optional junk MUST NOT be scraped
  assert.ok(!scrapedLabels.includes('Middle Name'));
  assert.ok(!scrapedLabels.includes('Address Line 2'));
  assert.ok(!scrapedLabels.includes('Cover Letter'));
  assert.ok(!scrapedLabels.includes('Certifications'));
  assert.ok(!scrapedLabels.includes('GPA'));
  assert.ok(!scrapedLabels.includes('LinkedIn URL'));
  assert.ok(!scrapedLabels.includes('Twitter'));
});

test('Stage 2 5-tier resolution resolves all candidate facts from DB and marks status as ready_for_review', async () => {
  const { preResolveClientAnswersDetailed } = await import('../lib/jobFormCache.mjs');

  const schema = {
    tenant: 'cambium',
    company: 'Cambium Learning Group',
    fields_schema: [
      { label: 'First Name', normalized_label: 'first name', is_required: true },
      { label: 'Last Name', normalized_label: 'last name', is_required: true },
      { label: 'Email', normalized_label: 'email', is_required: true },
      { label: 'Phone', normalized_label: 'phone', is_required: true },
      { label: 'Company', normalized_label: 'company', is_required: true },
      { label: 'Job Title', normalized_label: 'job title', is_required: true },
      { label: 'University', normalized_label: 'university', is_required: true },
      { label: 'Degree', normalized_label: 'degree', is_required: true },
      { label: 'Major', normalized_label: 'major', is_required: true },
      { label: 'City', normalized_label: 'city', is_required: true },
      { label: 'State', normalized_label: 'state', is_required: true },
      { label: 'Postal Code', normalized_label: 'postal code', is_required: true },
    ],
  };

  const clientProfile = {
    personal: {
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane.doe@example.com',
      phone: '4155551234',
      city: 'San Francisco',
      state: 'California',
      postal_code: '94105',
      address_line1: '100 Market St',
    },
    experience: {
      current_company: 'Genuine Tech Corp',
      current_title: 'Full Stack Engineer',
      location: 'San Francisco, CA',
      currently_working: true,
      from_date: '03/2022',
    },
    education: {
      university: 'University of California, Berkeley',
      degree: "Bachelor's",
      major: 'Computer Science',
      to_year: '2022',
    },
    _supabaseQa: {},
  };

  const result = await preResolveClientAnswersDetailed({
    jobUrl: 'https://cambiumlearning.wd1.myworkdayjobs.com/camb/job/Remote/Data-Analyst',
    schema,
    profile: clientProfile,
    options: { blockUniversalYaml: true, stage: 'stage2' },
  });

  // Verify that all 12 fields are 100% resolved from candidate facts
  assert.equal(result.isFullyAnswered, true);
  assert.equal(result.unansweredCount, 0);
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.answersMap['first name'], 'Jane');
  assert.equal(result.answersMap['last name'], 'Doe');
  assert.equal(result.answersMap['email'], 'jane.doe@example.com');
  assert.equal(result.answersMap['phone'], '4155551234');
  assert.equal(result.answersMap['company'], 'Genuine Tech Corp');
  assert.equal(result.answersMap['job title'], 'Full Stack Engineer');
  assert.equal(result.answersMap['university'], 'University of California, Berkeley');
  assert.equal(result.answersMap['degree'], "Bachelor's");
  assert.equal(result.answersMap['major'], 'Computer Science');
});

test('Referral Source strictly rejects Company Website and Company Mail, prioritizing external platforms', async () => {
  const { isForbiddenSourceOption } = await import('../lib/workdaySource.mjs');
  const { resolveAnswerFromLiveOptions } = await import('../lib/workdayQuestionFill.mjs');

  // Verify forbidden options are blocked
  assert.equal(isForbiddenSourceOption('Company Website'), true);
  assert.equal(isForbiddenSourceOption('Company website'), true);
  assert.equal(isForbiddenSourceOption('Company Mail'), true);
  assert.equal(isForbiddenSourceOption('Employee Referral'), true);
  assert.equal(isForbiddenSourceOption('Internal Referral'), true);
  assert.equal(isForbiddenSourceOption('Referral from company'), true);

  // Verify external options are NOT forbidden
  assert.equal(isForbiddenSourceOption('LinkedIn'), false);
  assert.equal(isForbiddenSourceOption('Indeed'), false);
  assert.equal(isForbiddenSourceOption('Glassdoor'), false);
  assert.equal(isForbiddenSourceOption('Job Boards'), false);
  assert.equal(isForbiddenSourceOption('Other'), false);

  // Test live option resolution when company website is among the options
  const mixedOptions = [
    'Company Website',
    'Employee Referral',
    'LinkedIn',
    'Indeed',
    'Glassdoor',
    'Other'
  ];

  const resolved = resolveAnswerFromLiveOptions({
    liveOptions: mixedOptions,
    labelText: 'How Did You Hear About Us?*',
    profile: {},
  });

  // Must pick LinkedIn and NEVER Company Website or Employee Referral
  assert.equal(resolved, 'LinkedIn');
  assert.notEqual(resolved, 'Company Website');
  assert.notEqual(resolved, 'Employee Referral');
});

test('Postal Code validation strictly detects State-Zip mismatch and recovers valid postal code via LLM/context', async () => {
  const { isPostalMatchingState, resolvePostalCodeWithContext, getUsStateDefaultZip } = await import('../lib/clientContact.mjs');

  // 1. Verify zip matching state
  assert.equal(isPostalMatchingState('55401', 'Massachusetts'), false);
  assert.equal(isPostalMatchingState('55401', 'Minnesota'), true);
  assert.equal(isPostalMatchingState('02108', 'Massachusetts'), true);
  assert.equal(isPostalMatchingState('94105', 'California'), true);
  assert.equal(isPostalMatchingState('94105', 'Texas'), false);

  // 2. Default zip fallbacks
  assert.equal(getUsStateDefaultZip('Massachusetts'), '02108');
  assert.equal(getUsStateDefaultZip('California'), '94203');
  assert.equal(getUsStateDefaultZip('Minnesota'), '55102');

  // 3. Recovery when candidate profile has contaminated postal code (55401 for MA)
  const profileWithMismatch = {
    personal: {
      country: 'United States',
      state: 'Massachusetts',
      city: 'Boston',
      postal_code: '55401', // mismatched Minnesota zip
    },
    qa_answers: {
      'postal code': '55401',
    },
    _supabaseQa: {
      'postal code': '55401',
    },
  };

  const recovered = await resolvePostalCodeWithContext({
    country: 'United States',
    state: 'Massachusetts',
    city: 'Boston',
    profile: profileWithMismatch,
    forceLlm: true,
    invalidPostal: '55401',
  });

  // Must recover valid Massachusetts zip and reject 55401
  assert.notEqual(recovered, '55401');
  assert.equal(isPostalMatchingState(recovered, 'Massachusetts'), true);
  assert.equal(profileWithMismatch.personal.postal_code, recovered);
});


