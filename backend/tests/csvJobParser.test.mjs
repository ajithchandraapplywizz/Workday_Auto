import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientJobsCsvContent } from '../lib/csvJobParser.mjs';

test('parseClientJobsCsvContent handles standard header names', () => {
  const csv = `applywizz_id,job_url,company
AWL-12345,https://gsk.wd5.myworkdayjobs.com/en-US/GSKCareers/job/London/Microbiology_445791,GSK
AWL-54321,https://gsk.wd5.myworkdayjobs.com/en-US/GSKCareers/job/London/Microbiology_445791,GSK`;

  const parsed = parseClientJobsCsvContent(csv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].applywizzId, 'AWL-12345');
  assert.equal(parsed[0].company, 'GSK');
  assert.equal(parsed[1].applywizzId, 'AWL-54321');
  assert.equal(parsed[0].jobUrl, parsed[1].jobUrl);
});

test('parseClientJobsCsvContent handles alternative headers like client_id and link', () => {
  const csv = `client_id,link
AWL-99999,https://formulaone.wd3.myworkdayjobs.com/F1/job/Biggin-Hill/Design-Quality-Engineer_JR101129`;

  const parsed = parseClientJobsCsvContent(csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].applywizzId, 'AWL-99999');
  assert.match(parsed[0].jobUrl, /formulaone/);
});

test('parseClientJobsCsvContent auto-detects fields without headers', () => {
  const csv = `AWL-77777,https://flir.wd1.myworkdayjobs.com/flircareers/job/UK---Fareham/Design-Engineer_REQ35058`;

  const parsed = parseClientJobsCsvContent(csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].applywizzId, 'AWL-77777');
});
