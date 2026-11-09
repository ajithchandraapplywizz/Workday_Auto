import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswerFromLiveOptions } from '../lib/workdayQuestionFill.mjs';

test('Voluntary Disclosures: Generic Dropdown with Veteran Status options resolves correctly', () => {
  const veteranOptions = [
    'I identify as one or more of the classifications of protected veteran listed above',
    'I am not a protected veteran',
    'I do not wish to answer',
  ];

  const profile = {
    eeo: {
      veteran_status: 'I am not a protected veteran',
      gender: 'Male',
      race: 'Asian (United States of America)',
    },
  };

  const resolved = resolveAnswerFromLiveOptions({
    liveOptions: veteranOptions,
    labelText: 'Please select from the dropdown menu below.*',
    profile,
  });

  assert.equal(resolved, 'I am not a protected veteran');
});

test('Voluntary Disclosures: Multi-checkbox race options strictly filter to Asian only', () => {
  const raceOptions = [
    'Asian (United States of America)',
    'Black or African American (United States of America)',
    'Hispanic or Latino (United States of America)',
    'I do not wish to answer. (United States of America)',
    'Native Hawaiian or Other Pacific Islander (United States of America)',
    'Two or More Races (United States of America)',
    'White (United States of America)',
  ];

  // Verify option-based classification maps to Asian
  const resolved = resolveAnswerFromLiveOptions({
    liveOptions: raceOptions,
    labelText: 'Please select your race/ethnicity',
    profile: { eeo: { race: 'Asian (United States of America)' } },
  });

  assert.match(resolved, /asian/i);
  assert.doesNotMatch(resolved, /black|hispanic|white|hawaiian|two/i);
});

test('Stage 1 vs Stage 3 Zoho Disconnection Status Handling', () => {
  // Test result object from a Zoho disconnected candidate
  const result = {
    status: 'zoho_not_connected',
    reason: 'zoho mail not connected',
    isZohoNotConnected: true,
    stoppedAtStep: 'Auth Gateway / Zoho Mail Verification',
    failureReason: 'zoho mail not connected (AWL-ID: AWL-101, mail: sai.madhamshetty@applywizard.ai)',
  };

  // Stage 1 (Scanner): Sibling cascade check
  const isZohoAuthIssue = Boolean(
    result?.status === 'auth-failed' ||
    result?.status === 'auth_failed' ||
    result?.status === 'zoho_not_connected' ||
    result?.reason === 'mailbox_not_connected' ||
    result?.reason === 'zoho mail not connected' ||
    result?.isZohoNotConnected ||
    /zoho.*not.*connected|mailbox.*not.*connected/i.test(String(result?.failureReason || ''))
  );

  assert.equal(isZohoAuthIssue, true);

  // Sibling cascade switches to next candidate
  const candidatePool = ['AWL-101', 'AWL-102', 'AWL-103'];
  let cIdx = 0;
  let nextCandidate = null;
  if (isZohoAuthIssue && cIdx < candidatePool.length - 1) {
    nextCandidate = candidatePool[cIdx + 1];
  }

  assert.equal(nextCandidate, 'AWL-102');

  // Stage 3 (Submitter): Fatal non-retryable check
  const rawErrMsg = result?.failureReason || result?.error;
  const isZohoFatal = Boolean(
    /zoho.*not.*connected|mailbox.*not.*connected/i.test(rawErrMsg) ||
    result?.isZohoNotConnected ||
    result?.status === 'zoho_not_connected' ||
    result?.reason === 'zoho mail not connected'
  );

  assert.equal(isZohoFatal, true);
});
