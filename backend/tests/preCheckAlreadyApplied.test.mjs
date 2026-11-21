import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWorkdayRequisitionId,
  checkIfClientAlreadyAppliedToJob,
} from '../lib/submissionWorkerPool.mjs';

test('extractWorkdayRequisitionId extracts standard Workday job requisition identifiers', () => {
  // Pattern 1: Title_JR1985432
  const u1 = 'https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site/job/San-Francisco/Lead-Engineer_JR1985432';
  assert.equal(extractWorkdayRequisitionId(u1), 'jr1985432');

  // Pattern 2: Title_R-123456 with tracking parameters
  const u2 = 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AI-Engineer_R-123456?source=Indeed&token=abc';
  assert.equal(extractWorkdayRequisitionId(u2), 'r-123456');

  // Pattern 3: Slash-prefixed requisition code
  const u3 = 'https://adobe.wd5.myworkdayjobs.com/external/job/Remote/R109876';
  assert.equal(extractWorkdayRequisitionId(u3), 'r109876');

  // Pattern 4: Query parameter requisition
  const u4 = 'https://autodesk.wd1.myworkdayjobs.com/Careers/job/details?req_id=REQ998877';
  assert.equal(extractWorkdayRequisitionId(u4), 'req998877');

  // Pattern 5: Empty or null
  assert.equal(extractWorkdayRequisitionId(''), '');
  assert.equal(extractWorkdayRequisitionId(null), '');
  assert.equal(extractWorkdayRequisitionId('https://example.com/jobs/no-req-here'), '');
});

test('checkIfClientAlreadyAppliedToJob validates inputs and handles missing data gracefully', async () => {
  const res1 = await checkIfClientAlreadyAppliedToJob({ applywizzId: null, jobUrl: 'https://example.com' });
  assert.equal(res1.alreadyApplied, false);

  const res2 = await checkIfClientAlreadyAppliedToJob({ applywizzId: 'AW_123', jobUrl: null });
  assert.equal(res2.alreadyApplied, false);
});
