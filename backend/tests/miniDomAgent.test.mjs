/**
 * miniDomAgent.test.mjs
 * Unit tests for Mini DOM Agent (Real-Time In-Browser Remediation Engine)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeRemediationAnswer,
  runMiniDomRemediation,
} from '../lib/miniDomAgent.mjs';

test('Stage 1 Scan Mode: synthesizeRemediationAnswer applies scan bypass policy', async () => {
  const profile = { _isScanOnly: true };

  // Checkbox bypass
  const cbRes = await synthesizeRemediationAnswer({ controlType: 'checkbox', label: 'Random Agreement' }, profile);
  assert.equal(cbRes.answer, 'true');
  assert.equal(cbRes.source, 'scan_bypass');

  // Dropdown bypass picks valid option
  const ddRes = await synthesizeRemediationAnswer({
    controlType: 'combobox',
    label: 'Preferred shift',
    options: ['Select One', 'Shift A', 'Shift B'],
  }, profile);
  assert.equal(ddRes.answer, 'Shift A');
  assert.equal(ddRes.source, 'scan_bypass');

  // Text date bypass
  const dtRes = await synthesizeRemediationAnswer({ controlType: 'text', label: 'Available Date' }, profile);
  assert.equal(dtRes.answer, '01/01/2026');
  assert.equal(dtRes.source, 'scan_bypass');
});

test('Stage 3 Submission Mode: prioritize pre-resolved answers from Stage 2 resolved_answers', async () => {
  const profile = {
    _isScanOnly: false,
    resolved_answers: {
      'Preferred Working Hours': 'Full-time 40hrs',
      'Willing to Relocate': 'Yes',
    },
  };

  const res = await synthesizeRemediationAnswer({
    controlType: 'text',
    label: 'Preferred Working Hours',
  }, profile);

  assert.equal(res.answer, 'Full-time 40hrs');
  assert.equal(res.source, 'stage2_resolved_answers');
});

test('Stage 3 Submission Mode: deterministic policies for agreements, compliance & criminal', async () => {
  const profile = {
    _isScanOnly: false,
    personal: { full_name: 'John Doe' },
  };

  // Terms agreement checkbox
  const agreeRes = await synthesizeRemediationAnswer({
    controlType: 'checkbox',
    label: 'I certify and agree to the terms',
  }, profile);
  assert.equal(agreeRes.answer, 'true');
  assert.equal(agreeRes.source, 'deterministic_policy');

  // Legal name signature
  const sigRes = await synthesizeRemediationAnswer({
    controlType: 'text',
    label: 'Please type your full legal name to sign',
  }, profile);
  assert.equal(sigRes.answer, 'John Doe');
  assert.equal(sigRes.source, 'profile_identity');

  // Sensitive criminal question -> "No"
  const crimRes = await synthesizeRemediationAnswer({
    controlType: 'radio',
    label: 'Have you ever been convicted of a felony?',
    options: ['Yes', 'No'],
  }, profile);
  assert.equal(crimRes.answer, 'No');
  assert.equal(crimRes.source, 'safe_compliance_policy');

  // Work authorization -> "Yes"
  const authRes = await synthesizeRemediationAnswer({
    controlType: 'radio',
    label: 'Are you legally authorized to work in the United States?',
    options: ['Yes', 'No'],
  }, profile);
  assert.equal(authRes.answer, 'Yes');
  assert.equal(authRes.source, 'safe_compliance_policy');

  // EEO / Disability -> Decline to answer (no hallucination)
  const eeoRes = await synthesizeRemediationAnswer({
    controlType: 'combobox',
    label: 'Voluntary Self-Identification of Disability',
    options: ['Yes, I have a disability', 'No, I do not have a disability', 'I do not wish to answer'],
  }, profile);
  assert.equal(eeoRes.answer, 'I do not wish to answer');
  assert.equal(eeoRes.source, 'safe_eeo_compliance');
});

test('runMiniDomRemediation: clean exit when DOM has 0 uncommitted fields', async () => {
  // Mock Playwright page returning 0 uncommitted fields
  const mockPage = {
    evaluate: async () => [],
  };

  const result = await runMiniDomRemediation(mockPage, {}, { currentStep: 'Review' });
  assert.equal(result.success, true);
  assert.equal(result.remediatedCount, 0);
  assert.equal(result.unresolvedCount, 0);
});
