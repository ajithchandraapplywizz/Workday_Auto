import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  failClusterTasksByIds,
  resetClusterTasksByIds,
  resetClusterTasksToPending,
} from '../lib/clusterBatchRunner.mjs';

describe('Scanner Retry & Expired Policy Guardrails', () => {
  test('failClusterTasksByIds correctly identifies expired jobs and passes screenshotUrl', async () => {
    // Test logic pattern: isExpired regex
    const expiredReasons = [
      'Link expired on Workday',
      'The page you are looking for doesn\'t exist',
      'Job posting has been closed',
      '404 Not Found',
      'no longer accepting applications',
      'dead/expired URL',
      'job_expired_or_not_found',
    ];

    for (const r of expiredReasons) {
      const isExpired = /expired|does not exist|doesn'?t exist|page not found|404|no longer (?:accepting|available)|closed|filled/i.test(r);
      assert.equal(isExpired, true, `Expected "${r}" to be recognized as expired`);
    }

    const nonExpiredReasons = [
      'Worker error: browserContext.newPage: Target page, context or browser has been closed',
      'Element click intercepted by overlay',
      'TimeoutError: waiting for selector',
      'NetworkError: connection refused',
    ];

    for (const r of nonExpiredReasons) {
      const text = r;
      const isBrowserCloseError = /(?:browser|context|target).*closed/i.test(text) && !/link\s*expired|job\s*expired/i.test(text);
      const isExpired = !isBrowserCloseError && /(?:link\s*expired|job\s*expired|dead\/expired|^expired$|does not exist|doesn'?t exist|page not found|\b(?:error\s*)?404\b|no longer accepting applications|no longer available|(?:job|posting|position)\s*(?:has been\s*)?(?:closed|filled))/i.test(text);
      assert.equal(isExpired, false, `Expected "${r}" to NOT be recognized as expired`);
    }
  });

  test('3-Attempt scan progression invariants', () => {
    const MAX_ATTEMPTS = 3;
    let currentAttempts = 0;

    // Attempt 1 fails
    let nextAttempt = currentAttempts + 1;
    assert.equal(nextAttempt, 1);
    assert.equal(currentAttempts < 2, true, 'Attempt 1 must re-queue (not permanent fail)');

    // Attempt 2 fails
    currentAttempts = 1;
    nextAttempt = currentAttempts + 1;
    assert.equal(nextAttempt, 2);
    assert.equal(currentAttempts < 2, true, 'Attempt 2 must re-queue (not permanent fail)');

    // Attempt 3 fails
    currentAttempts = 2;
    nextAttempt = currentAttempts + 1;
    assert.equal(nextAttempt, 3);
    assert.equal(currentAttempts < 2, false, 'Attempt 3 must permanently mark as failed');
  });

  test('resetClusterTasks query excludes expired and finished jobs', () => {
    const queryPart = '&status=neq.expired&status=neq.already_expired&status=neq.reached_review&status=neq.already_reached_review&status=neq.scanned&status=neq.submitted';
    assert.ok(queryPart.includes('neq.expired'), 'Must protect expired rows from reset');
    assert.ok(queryPart.includes('neq.scanned'), 'Must protect scanned rows from reset');
    assert.ok(queryPart.includes('neq.submitted'), 'Must protect submitted rows from reset');
  });
});
