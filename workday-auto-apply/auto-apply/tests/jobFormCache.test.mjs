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
