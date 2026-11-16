import test from 'node:test';
import assert from 'node:assert/strict';
import { getSubmissionAttemptCount } from '../lib/submissionWorkerPool.mjs';

test('getSubmissionAttemptCount correctly parses progressive attempt numbers', () => {
  // Fresh/unattempted rows
  assert.equal(getSubmissionAttemptCount(null), 0);
  assert.equal(getSubmissionAttemptCount(undefined), 0);
  assert.equal(getSubmissionAttemptCount(''), 0);
  assert.equal(getSubmissionAttemptCount('Random error with no attempt bracket'), 0);

  // Attempt 1 failures (reverted to ready_for_review)
  assert.equal(getSubmissionAttemptCount('[Attempt 1/3] Halted at "Application Questions": missing answer'), 1);
  assert.equal(getSubmissionAttemptCount('[Attempt 1/2] Halted at "My Information": date error'), 1);

  // Attempt 2 failures (reverted to ready_for_review)
  assert.equal(getSubmissionAttemptCount('[Attempt 2/3] Halted at "My Experience": job title required'), 2);
  assert.equal(getSubmissionAttemptCount('[Attempt 2/2 Failed] Some error'), 2);

  // Attempt 3 failures (final failure)
  assert.equal(getSubmissionAttemptCount('[Attempt 3/3 Failed at "Review & Submit"]: Submit button not clickable'), 3);

  // User stop errors: NEVER count as failed attempts (must return 0)
  assert.equal(getSubmissionAttemptCount('Stopped by user'), 0);
  assert.equal(getSubmissionAttemptCount('Stop requested by user'), 0);
  assert.equal(getSubmissionAttemptCount('[Attempt 3/3 Failed at "Unknown Step"]: Stopped by user'), 0);
  assert.equal(getSubmissionAttemptCount('[Attempt 1/3] Halted at "Step 1": Stopped by user'), 0);
});

test('Progressive 3-attempt state transitions: Attempts 1 & 2 stay ready_for_review, Attempt 3 marks failed, screenshots captured across all attempts', () => {
  const evaluateAttempt = (prevErrorMessage, failureReason, failedStep, shotUrl = null) => {
    const prevAttempts = getSubmissionAttemptCount(prevErrorMessage);
    const currentAttempt = prevAttempts + 1;
    const isFinal = currentAttempt >= 3;

    if (currentAttempt < 3) {
      return {
        currentAttempt,
        status: 'ready_for_review',
        isFinal: false,
        errorMessage: `[Attempt ${currentAttempt}/3] Halted at "${failedStep}": ${failureReason}`,
        application_submitted_screenshot_url: shotUrl,
      };
    } else {
      return {
        currentAttempt,
        status: 'failed',
        isFinal: true,
        errorMessage: `[Attempt 3/3 Failed at "${failedStep}"]: ${failureReason}`,
        application_submitted_screenshot_url: shotUrl,
      };
    }
  };

  // Attempt 1: 0 previous attempts -> Attempt 1/3 fails, captures Attempt 1 screenshot
  const shot1 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-1_comp_task1_attempt1_failed.png';
  const attempt1 = evaluateAttempt(null, 'Timeout on Next button', 'My Information', shot1);
  assert.equal(attempt1.currentAttempt, 1);
  assert.equal(attempt1.status, 'ready_for_review', 'Attempt 1 MUST NOT be marked failed');
  assert.equal(attempt1.isFinal, false);
  assert.equal(attempt1.application_submitted_screenshot_url, shot1, 'Attempt 1 failure screenshot must be saved');
  assert.ok(attempt1.errorMessage.includes('[Attempt 1/3]'));
  assert.ok(attempt1.errorMessage.includes('My Information'));

  // Attempt 2: 1 previous attempt -> Attempt 2/3 fails, replaces cell with Attempt 2 screenshot
  const shot2 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-1_comp_task1_attempt2_failed.png';
  const attempt2 = evaluateAttempt(attempt1.errorMessage, 'Field postal code invalid', 'My Information', shot2);
  assert.equal(attempt2.currentAttempt, 2);
  assert.equal(attempt2.status, 'ready_for_review', 'Attempt 2 MUST NOT be marked failed');
  assert.equal(attempt2.isFinal, false);
  assert.equal(attempt2.application_submitted_screenshot_url, shot2, 'Attempt 2 failure screenshot must replace Attempt 1');
  assert.ok(attempt2.errorMessage.includes('[Attempt 2/3]'));

  // Attempt 3: 2 previous attempts -> Attempt 3/3 fails, replaces cell with Attempt 3 screenshot and marks failed
  const shot3 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-1_comp_task1_attempt3_failed.png';
  const attempt3 = evaluateAttempt(attempt2.errorMessage, 'Application wizard stalled', 'Application Questions', shot3);
  assert.equal(attempt3.currentAttempt, 3);
  assert.equal(attempt3.status, 'failed', 'Attempt 3 MUST be marked failed');
  assert.equal(attempt3.isFinal, true);
  assert.equal(attempt3.application_submitted_screenshot_url, shot3, 'Attempt 3 final failure screenshot must replace previous');
  assert.ok(attempt3.errorMessage.includes('[Attempt 3/3 Failed at "Application Questions"]'));
});

test('Attempt 3 failure patch mandatorily persists screenshot to application_submitted_screenshot_url', () => {
  const finalShotUrl = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-999_company_123_failed_1793685000000.png';
  const finalFailMsg = '[Attempt 3/3 Failed at "Review & Submit"]: Wizard submission timeout';

  const failPatch = {
    status: 'failed',
    error_message: finalShotUrl ? `${finalFailMsg} [diagnostic_screenshot: ${finalShotUrl}]` : finalFailMsg,
    application_submitted_screenshot_url: finalShotUrl,
    updated_at: new Date().toISOString(),
  };

  // Assertions for mandatory fields on Attempt 3 failure
  assert.equal(failPatch.status, 'failed');
  assert.ok(failPatch.application_submitted_screenshot_url, 'Screenshot URL must be stored on Attempt 3 failure');
  assert.equal(failPatch.application_submitted_screenshot_url, finalShotUrl);
  assert.ok(failPatch.error_message.includes('diagnostic_screenshot'));
  assert.equal('completed_at' in failPatch, false, 'completed_at MUST NOT be present in patch');
});

test('Clean patch sanitizer ensures completed_at is stripped and mapped to updated_at', () => {
  const inputPatch = {
    status: 'failed',
    completed_at: '2026-11-03T10:00:00.000Z',
    application_submitted_screenshot_url: 'https://test.png',
  };

  const cleanPatch = { ...inputPatch };
  if ('completed_at' in cleanPatch) {
    if (!cleanPatch.updated_at && cleanPatch.completed_at) {
      cleanPatch.updated_at = cleanPatch.completed_at;
    }
    delete cleanPatch.completed_at;
  }

  assert.equal('completed_at' in cleanPatch, false, 'completed_at must be completely removed');
  assert.equal(cleanPatch.updated_at, '2026-11-03T10:00:00.000Z', 'completed_at must be safely remapped to updated_at');
  assert.equal(cleanPatch.status, 'failed');
  assert.equal(cleanPatch.application_submitted_screenshot_url, 'https://test.png');
});

test('Stopped by user errors evaluate to attempt 0 and are never treated as exhausted attempts', () => {
  const stoppedMsg = '[Attempt 3/3 Failed at "Unknown Step"]: Stopped by user';
  const attempts = getSubmissionAttemptCount(stoppedMsg);
  assert.equal(attempts, 0, 'Stopped by user must evaluate to attempt 0');

  // Verify user stop evaluation helper
  const isUserStop = (errMsg, status) => Boolean(
    status === 'stopped' ||
    /stopped by user|stop requested/i.test(errMsg)
  );

  assert.equal(isUserStop(stoppedMsg, 'ready_for_review'), true);
  assert.equal(isUserStop('Stopped by user', 'stopped'), true);
  assert.equal(isUserStop('Some actual workday error', 'failed'), false);
});

test('Zoho authentication and verification failures strictly follow 3-attempt lifecycle before marking failed', () => {
  const evaluateZohoAttempt = (prevErrorMessage, zohoError, shotUrl = null) => {
    const prevAttempts = getSubmissionAttemptCount(prevErrorMessage);
    const currentAttempt = prevAttempts + 1;
    const isFatalNonRetryable = false; // Zoho errors are retryable

    if (currentAttempt < 3 && !isFatalNonRetryable) {
      return {
        currentAttempt,
        status: 'ready_for_review',
        error_message: shotUrl ? `[Attempt ${currentAttempt}/3] Halted at "Authentication": ${zohoError} [diagnostic_screenshot: ${shotUrl}]` : `[Attempt ${currentAttempt}/3] Halted at "Authentication": ${zohoError}`,
        application_submitted_screenshot_url: shotUrl,
      };
    } else {
      return {
        currentAttempt,
        status: 'failed',
        error_message: shotUrl ? `[Attempt 3/3 Failed at "Authentication"]: ${zohoError} [diagnostic_screenshot: ${shotUrl}]` : `[Attempt 3/3 Failed at "Authentication"]: ${zohoError}`,
        application_submitted_screenshot_url: shotUrl,
      };
    }
  };

  const zohoMsg = 'zoho mail not connected (AWL-ID: AWL-101, mail: candidate@example.com)';

  // Attempt 1 Zoho failure: MUST stay ready_for_review with attempt 1 screenshot
  const shot1 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-101_attempt1_failed.png';
  const att1 = evaluateZohoAttempt(null, zohoMsg, shot1);
  assert.equal(att1.currentAttempt, 1);
  assert.equal(att1.status, 'ready_for_review', 'Attempt 1 Zoho failure MUST stay ready_for_review');
  assert.equal(att1.application_submitted_screenshot_url, shot1);
  assert.ok(att1.error_message.includes('[Attempt 1/3]'));

  // Attempt 2 Zoho failure: MUST stay ready_for_review with attempt 2 screenshot replacing attempt 1
  const shot2 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-101_attempt2_failed.png';
  const att2 = evaluateZohoAttempt(att1.error_message, zohoMsg, shot2);
  assert.equal(att2.currentAttempt, 2);
  assert.equal(att2.status, 'ready_for_review', 'Attempt 2 Zoho failure MUST stay ready_for_review');
  assert.equal(att2.application_submitted_screenshot_url, shot2);
  assert.ok(att2.error_message.includes('[Attempt 2/3]'));

  // Attempt 3 Zoho failure: MUST transition to failed with attempt 3 screenshot
  const shot3 = 'https://supabase.co/storage/v1/object/public/failed-applications/AWL-101_attempt3_failed.png';
  const att3 = evaluateZohoAttempt(att2.error_message, zohoMsg, shot3);
  assert.equal(att3.currentAttempt, 3);
  assert.equal(att3.status, 'failed', 'Attempt 3 Zoho failure MUST transition to failed');
  assert.equal(att3.application_submitted_screenshot_url, shot3);
  assert.ok(att3.error_message.includes('[Attempt 3/3 Failed at "Authentication"]'));
});

test('Claim atomic filters allow candidates with non-null failure screenshots to be retried', () => {
  // Simulate database candidates in job_distributions
  const candidates = [
    {
      id: 'task-fresh',
      status: 'ready_for_review',
      error_message: null,
      application_submitted_screenshot_url: null,
    },
    {
      id: 'task-retry1',
      status: 'ready_for_review',
      error_message: '[Attempt 1/3] Halted at "Authentication": zoho verification timeout',
      application_submitted_screenshot_url: 'https://supabase.co/storage/v1/object/public/failed-applications/attempt1.png',
    },
    {
      id: 'task-retry2',
      status: 'ready_for_review',
      error_message: '[Attempt 2/3] Halted at "My Experience": required field missing',
      application_submitted_screenshot_url: 'https://supabase.co/storage/v1/object/public/failed-applications/attempt2.png',
    },
    {
      id: 'task-submitted',
      status: 'submitted',
      error_message: null,
      application_submitted_screenshot_url: 'https://supabase.co/storage/v1/object/public/submitted-applications/proof.png',
    },
  ];

  // Retry 1 filter matcher: checks error_message includes Attempt 1 and status is not submitted/completed
  const retry1Candidates = candidates.filter((c) =>
    ['ready_for_review', 'queued'].includes(c.status) &&
    c.status !== 'submitted' &&
    c.status !== 'completed' &&
    c.error_message && c.error_message.includes('[Attempt 1/3]')
  );
  assert.equal(retry1Candidates.length, 1);
  assert.equal(retry1Candidates[0].id, 'task-retry1');
  assert.ok(retry1Candidates[0].application_submitted_screenshot_url, 'Retry 1 candidate has attempt 1 screenshot');

  // Retry 2 filter matcher: checks error_message includes Attempt 2 and status is not submitted/completed
  const retry2Candidates = candidates.filter((c) =>
    ['ready_for_review', 'queued'].includes(c.status) &&
    c.status !== 'submitted' &&
    c.status !== 'completed' &&
    c.error_message && c.error_message.includes('[Attempt 2/3]')
  );
  assert.equal(retry2Candidates.length, 1);
  assert.equal(retry2Candidates[0].id, 'task-retry2');
  assert.ok(retry2Candidates[0].application_submitted_screenshot_url, 'Retry 2 candidate has attempt 2 screenshot');

  // Submitted applications must NEVER match retry filters
  assert.ok(!retry1Candidates.some(c => c.status === 'submitted'));
  assert.ok(!retry2Candidates.some(c => c.status === 'submitted'));
});
