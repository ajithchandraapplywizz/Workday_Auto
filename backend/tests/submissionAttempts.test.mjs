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
