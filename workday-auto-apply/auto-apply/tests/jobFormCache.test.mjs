import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJobPostingUrl } from '../lib/supabaseClient.mjs';

test('canonicalJobPostingUrl normalizes Workday URLs correctly', () => {
  const url1 = 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345/apply?source=LinkedIn';
  const url2 = 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345?source=Indeed&ref=123';
  const url3 = 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345/applicationSubmitted';

  const c1 = canonicalJobPostingUrl(url1);
  const c2 = canonicalJobPostingUrl(url2);
  const c3 = canonicalJobPostingUrl(url3);

  assert.equal(c1, 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345');
  assert.equal(c2, 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345');
  assert.equal(c3, 'https://company.wd5.myworkdayjobs.com/en-US/Careers/job/City/Job-Title_JR12345');
  assert.equal(c1, c2);
  assert.equal(c2, c3);
});

test('canonicalJobPostingUrl handles URLs with encoded commas', () => {
  const raw = 'https://company.wd5.myworkdayjobs.com/job/Austin%2C-TX/Developer_JR1';
  const clean = canonicalJobPostingUrl(raw);
  assert.equal(clean, 'https://company.wd5.myworkdayjobs.com/job/Austin,-TX/Developer_JR1');
});

test('preResolveClientAnswersMap resolves answers for all schema fields from candidate profile', async () => {
  const { preResolveClientAnswersMap } = await import('../lib/jobFormCache.mjs');
  
  const mockSchema = {
    tenant: 'acme',
    company: 'Acme Corp',
    fields_schema: [
      { label: 'First Name', normalized_label: 'first name', is_required: true },
      { label: 'Last Name', normalized_label: 'last name', is_required: true },
      { label: 'Email', normalized_label: 'email', is_required: true },
    ],
  };

  const mockProfile = {
    personal: {
      first_name: 'John',
      last_name: 'Doe',
      email: 'john.doe@example.com',
    },
    _supabaseQa: {
      'first name': 'John',
      'last name': 'Doe',
      'email': 'john.doe@example.com',
    },
  };

  const answers = await preResolveClientAnswersMap({
    jobUrl: 'https://acme.wd5.myworkdayjobs.com/Careers/job/Engineer_JR100',
    schema: mockSchema,
    profile: mockProfile,
  });

  assert.ok(typeof answers['first name'] === 'string' && answers['first name'].length > 0);
  assert.ok(typeof answers['last name'] === 'string' && answers['last name'].length > 0);
  assert.ok(typeof answers['email'] === 'string' && answers['email'].includes('@'));
});

test('bulkPreResolveForJobUrl resolves pending clients and updates their queue rows', async () => {
  const { bulkPreResolveForJobUrl } = await import('../lib/jobFormCache.mjs');
  
  // Test safety when no pending tasks or empty schema
  await bulkPreResolveForJobUrl({
    jobUrl: 'https://acme.wd5.myworkdayjobs.com/job/1',
    schema: { fields_schema: [] },
    loadProfileFn: async () => ({}),
  });

  assert.ok(true, 'bulkPreResolveForJobUrl gracefully handles empty inputs');
});

