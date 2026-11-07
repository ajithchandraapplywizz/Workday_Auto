import test from 'node:test';
import assert from 'node:assert/strict';
import { isMandatoryField, shouldIncludeInScan } from '../lib/scanFieldFilter.mjs';
import { parseCandidateAwlIds } from '../lib/candidateParser.mjs';

test('1. Question Scraping: Application questions without asterisks are scraped as mandatory', () => {
  const customQuestions = [
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require employment visa sponsorship?',
    'Have you previously been employed by this company or any of its subsidiaries?',
    'What is your expected annual compensation?',
    'How many years of Python or Node.js experience do you have?',
    'Please select your highest level of completed education',
  ];

  for (const q of customQuestions) {
    assert.equal(isMandatoryField(q, {}, 'Application Questions'), true, `Expected "${q}" to be mandatory on Application Questions`);
    assert.equal(shouldIncludeInScan(q, {}, 'Application Questions'), true, `Expected "${q}" to be included in scan on Application Questions`);
  }
});

test('2. Question Scraping: Choice fields and question patterns on generic steps are included in scan', () => {
  // Referral source
  assert.equal(isMandatoryField('How Did You Hear About Us?', { fieldType: 'dropdown' }), true);
  assert.equal(shouldIncludeInScan('How Did You Hear About Us?', { fieldType: 'dropdown' }), true);

  // CC-305 Disability Self-Identify
  const cc305 = { stepName: 'Self Identify', containerText: 'CC-305 OMB Control Number 1250-0005' };
  assert.equal(isMandatoryField('Language', cc305, 'Self Identify'), true);
  assert.equal(shouldIncludeInScan('Language', cc305, 'Self Identify'), true);
  assert.equal(isMandatoryField('Date', cc305, 'Self Identify'), true);

  // EEO compliance fields
  assert.equal(isMandatoryField('Race / Ethnicity', {}), true);
  assert.equal(isMandatoryField('Gender', {}), true);
  assert.equal(isMandatoryField('Veteran Status', {}), true);

  // Question patterns with ? or question verbs
  assert.equal(isMandatoryField('Are you willing to undergo a pre-employment background check?'), true);
  assert.equal(isMandatoryField('Please confirm you have read the above statement:'), true);
});

test('3. Candidate Parsing: JSON string arrays in batch_job_queue are cleanly expanded', () => {
  const rawQueueValue = '["AWL-1568","AWL-26832","AWL-27321","AWL-29927"]';
  const parsed = parseCandidateAwlIds(rawQueueValue);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed, ['AWL-1568', 'AWL-26832', 'AWL-27321', 'AWL-29927']);
  // Assert no leading or trailing brackets or quotes
  for (const id of parsed) {
    assert.match(id, /^AWL-\d+$/);
    assert.equal(id.includes('['), false);
    assert.equal(id.includes(']'), false);
    assert.equal(id.includes('"'), false);
  }
});

test('4. Candidate Distribution: Unique link expands sibling candidate IDs for distribution', () => {
  const queueTasks = [
    {
      id: 'task-1',
      job_url: 'https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
      applywizz_id: '["AWL-1568","AWL-26832"]',
      company: 'Test Company',
      role_title: 'Software Engineer',
    },
    {
      id: 'task-2',
      job_url: 'https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
      applywizz_id: 'AWL-27321, AWL-29927',
      company: 'Test Company',
      role_title: 'Software Engineer',
    },
  ];

  const uniqueCandidateTasksMap = new Map();
  for (const t of queueTasks) {
    const ids = parseCandidateAwlIds(t.applywizz_id || t.client_ids);
    for (const singleId of ids) {
      if (singleId && !uniqueCandidateTasksMap.has(singleId)) {
        uniqueCandidateTasksMap.set(singleId, {
          ...t,
          id: `${singleId}:::${t.job_url}`,
          applywizz_id: singleId,
          applywizzId: singleId,
        });
      }
    }
  }

  const distributed = Array.from(uniqueCandidateTasksMap.values());
  assert.equal(distributed.length, 4);
  assert.deepEqual(
    distributed.map(d => d.applywizz_id),
    ['AWL-1568', 'AWL-26832', 'AWL-27321', 'AWL-29927']
  );
  assert.deepEqual(
    distributed.map(d => d.id),
    [
      'AWL-1568:::https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
      'AWL-26832:::https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
      'AWL-27321:::https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
      'AWL-29927:::https://company.wd1.myworkdayjobs.com/job/Engineer_R101',
    ]
  );
});

test('5. Review Step Question Harvest Fallback: Review page pairs populate questions', () => {
  const scrapedReviewMap = {
    'Country': 'United States of America',
    'Legal First Name': 'John',
    'Legal Last Name': 'Doe',
    'How Did You Hear About Us?': 'LinkedIn',
    'Are you legally authorized to work in the US?': 'Yes',
    'Will you require visa sponsorship?': 'No',
    'Disability Status': 'No, I do not have a disability',
  };

  const profile = {
    _scrapedWizardQuestions: new Map(), // empty from wizard
    _scrapedQuestions: [],
    _scrapedReviewMap: scrapedReviewMap,
  };

  const knownNorms = new Set(
    (profile._scrapedQuestions || []).map(q =>
      (q.question_normalized || q.normalized || q.label || q.question || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
    )
  );

  for (const [lbl, val] of Object.entries(scrapedReviewMap)) {
    if (!lbl || lbl.length < 2) continue;
    const normLbl = lbl.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normLbl || knownNorms.has(normLbl)) continue;

    const isChoice = /select|gender|race|veteran|disability|country|state|phone.*type|source|hear about/i.test(normLbl);
    const fieldType = isChoice ? 'dropdown' : (/\bdate\b/i.test(normLbl) ? 'date' : 'text');
    profile._scrapedQuestions.push({
      label: lbl,
      question: lbl,
      question_normalized: normLbl,
      field_type: fieldType,
      type: fieldType,
      options: [],
      required: true,
      is_required: true,
      step: 'Application',
      value: String(val || ''),
    });
    knownNorms.add(normLbl);
  }

  assert.equal(profile._scrapedQuestions.length, 7);
  assert.equal(profile._scrapedQuestions.find(q => q.label === 'How Did You Hear About Us?')?.field_type, 'dropdown');
  assert.equal(profile._scrapedQuestions.find(q => q.label === 'How Did You Hear About Us?')?.value, 'LinkedIn');
  assert.equal(profile._scrapedQuestions.find(q => q.label === 'Country')?.value, 'United States of America');
});
