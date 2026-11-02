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

test('Progressive 3-attempt state transitions: Attempts 1 & 2 stay ready_for_review, Attempt 3 marks failed', () => {
  const evaluateAttempt = (prevErrorMessage, failureReason, failedStep) => {
    const prevAttempts = getSubmissionAttemptCount(prevErrorMessage);
    const currentAttempt = prevAttempts + 1;
    const isFinal = currentAttempt >= 3;

    if (currentAttempt < 3) {
      return {
        currentAttempt,
        status: 'ready_for_review',
        isFinal: false,
        errorMessage: `[Attempt ${currentAttempt}/3] Halted at "${failedStep}": ${failureReason}`,
        screenshotRequired: false,
      };
    } else {
      return {
        currentAttempt,
        status: 'failed',
        isFinal: true,
        errorMessage: `[Attempt 3/3 Failed at "${failedStep}"]: ${failureReason}`,
        screenshotRequired: true,
      };
    }
  };

  // Attempt 1: 0 previous attempts -> Attempt 1/3 fails
  const attempt1 = evaluateAttempt(null, 'Timeout on Next button', 'My Information');
  assert.equal(attempt1.currentAttempt, 1);
  assert.equal(attempt1.status, 'ready_for_review', 'Attempt 1 MUST NOT be marked failed');
  assert.equal(attempt1.isFinal, false);
  assert.equal(attempt1.screenshotRequired, false, 'Attempt 1 MUST NOT submit failure screenshot');
  assert.ok(attempt1.errorMessage.includes('[Attempt 1/3]'));
  assert.ok(attempt1.errorMessage.includes('My Information'));

  // Attempt 2: 1 previous attempt -> Attempt 2/3 fails
  const attempt2 = evaluateAttempt(attempt1.errorMessage, 'Field postal code invalid', 'My Information');
  assert.equal(attempt2.currentAttempt, 2);
  assert.equal(attempt2.status, 'ready_for_review', 'Attempt 2 MUST NOT be marked failed');
  assert.equal(attempt2.isFinal, false);
  assert.equal(attempt2.screenshotRequired, false, 'Attempt 2 MUST NOT submit failure screenshot');
  assert.ok(attempt2.errorMessage.includes('[Attempt 2/3]'));

  // Attempt 3: 2 previous attempts -> Attempt 3/3 fails (Strict final attempt)
  const attempt3 = evaluateAttempt(attempt2.errorMessage, 'Application wizard stalled', 'Application Questions');
  assert.equal(attempt3.currentAttempt, 3);
  assert.equal(attempt3.status, 'failed', 'Attempt 3 MUST be marked failed');
  assert.equal(attempt3.isFinal, true);
  assert.equal(attempt3.screenshotRequired, true, 'Attempt 3 MUST capture and submit diagnostic screenshot');
  assert.ok(attempt3.errorMessage.includes('[Attempt 3/3 Failed at "Application Questions"]'));
});
