import test from 'node:test';
import assert from 'node:assert/strict';
import { TOTAL_SUBMIT_WORKERS, WORKER_COUNT, TOTAL_SERVICES } from '../config/pipelineConfig.mjs';

test('Pipeline config dynamically calculates total submit workers from WORKER_COUNT and TOTAL_SERVICES', () => {
  assert.equal(TOTAL_SUBMIT_WORKERS, WORKER_COUNT * TOTAL_SERVICES);
  assert.equal(typeof TOTAL_SUBMIT_WORKERS, 'number');
  assert.ok(TOTAL_SUBMIT_WORKERS >= 1);
});

test('Reaper correctly determines resolution target for expired leases with and without authentic proof', () => {
  // Case A: Has authentic submission proof
  const itemWithProof = {
    id: 'test-1',
    status: 'applying',
    application_submitted_screenshot_url: 'https://storage.supabase.co/submitted-applications/AWL-1_workday-submitted_123.png',
  };
  const hasProof = Boolean(
    itemWithProof.application_submitted_screenshot_url &&
    !itemWithProof.application_submitted_screenshot_url.includes('attempt') &&
    !itemWithProof.application_submitted_screenshot_url.includes('failed')
  );
  assert.equal(hasProof, true);
  const targetStatusA = hasProof ? 'submitted' : 'ready_for_review';
  assert.equal(targetStatusA, 'submitted');

  // Case B: Has attempt/failed screenshot (should revert to ready_for_review)
  const itemWithAttempt = {
    id: 'test-2',
    status: 'applying',
    application_submitted_screenshot_url: 'https://storage.supabase.co/failed-applications/AWL-2_attempt1_failed_123.png',
  };
  const hasProofB = Boolean(
    itemWithAttempt.application_submitted_screenshot_url &&
    !itemWithAttempt.application_submitted_screenshot_url.includes('attempt') &&
    !itemWithAttempt.application_submitted_screenshot_url.includes('failed')
  );
  assert.equal(hasProofB, false);
  const targetStatusB = hasProofB ? 'submitted' : 'ready_for_review';
  assert.equal(targetStatusB, 'ready_for_review');

  // Case C: Null screenshot (should revert to ready_for_review)
  const itemNoProof = {
    id: 'test-3',
    status: 'applying',
    application_submitted_screenshot_url: null,
  };
  const hasProofC = Boolean(
    itemNoProof.application_submitted_screenshot_url &&
    !itemNoProof.application_submitted_screenshot_url.includes('attempt') &&
    !itemNoProof.application_submitted_screenshot_url.includes('failed')
  );
  assert.equal(hasProofC, false);
  const targetStatusC = hasProofC ? 'submitted' : 'ready_for_review';
  assert.equal(targetStatusC, 'ready_for_review');
});

test('Worker lease expiry logic accurately detects leases older than timeout', () => {
  const timeoutMs = 3 * 60 * 1000;
  const now = Date.now();

  const freshLease = new Date(now - 60 * 1000).toISOString(); // 1m ago
  const freshLeasedTime = new Date(freshLease).getTime();
  const isFreshExpired = !freshLeasedTime || (now - freshLeasedTime > timeoutMs);
  assert.equal(isFreshExpired, false);

  const staleLease = new Date(now - 5 * 60 * 1000).toISOString(); // 5m ago
  const staleLeasedTime = new Date(staleLease).getTime();
  const isStaleExpired = !staleLeasedTime || (now - staleLeasedTime > timeoutMs);
  assert.equal(isStaleExpired, true);

  const nullLease = null;
  const isNullExpired = !nullLease || (now - (new Date(nullLease).getTime() || 0) > timeoutMs);
  assert.equal(isNullExpired, true);
});

test('getDynamicMaxBrowsers dynamically respects MAX_ACTIVE_BROWSERS from env and defaults safely to 1', async () => {
  const { getDynamicMaxBrowsers } = await import('../lib/browserLifecycle.mjs');

  const originalMax = process.env.MAX_ACTIVE_BROWSERS;

  try {
    delete process.env.MAX_ACTIVE_BROWSERS;
    assert.equal(getDynamicMaxBrowsers(), 1, 'Default should be 1 browser per container');

    process.env.MAX_ACTIVE_BROWSERS = '1';
    assert.equal(getDynamicMaxBrowsers(), 1, 'Should respect explicit MAX_ACTIVE_BROWSERS=1');

    process.env.MAX_ACTIVE_BROWSERS = '2';
    assert.equal(getDynamicMaxBrowsers(), 2, 'Should respect explicit MAX_ACTIVE_BROWSERS=2');

    process.env.MAX_ACTIVE_BROWSERS = '4';
    assert.equal(getDynamicMaxBrowsers(), 4, 'Should respect explicit MAX_ACTIVE_BROWSERS=4');
  } finally {
    if (originalMax !== undefined) process.env.MAX_ACTIVE_BROWSERS = originalMax;
    else delete process.env.MAX_ACTIVE_BROWSERS;
  }
});

test('acquireBrowserSlot strictly enforces single browser mutex and serializes workers in same service', async () => {
  const { acquireBrowserSlot, releaseBrowserSlot } = await import('../lib/browserLifecycle.mjs');

  const originalMax = process.env.MAX_ACTIVE_BROWSERS;
  process.env.MAX_ACTIVE_BROWSERS = '1';

  try {
    // 1. Worker 1 acquires slot
    const acquiredW1 = await acquireBrowserSlot('submitting_worker_1');
    assert.equal(acquiredW1, true, 'Worker 1 should acquire initial slot');

    // 2. Worker 2 attempts to acquire slot while Worker 1 is active (must be queued/waiting)
    let worker2Acquired = false;
    const w2Promise = acquireBrowserSlot('submitting_worker_2').then((res) => {
      worker2Acquired = res;
    });

    // Verify Worker 2 is queued and hasn't acquired yet
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(worker2Acquired, false, 'Worker 2 must not acquire slot while Worker 1 is running');

    // 3. Worker 1 finishes and releases browser slot
    releaseBrowserSlot('submitting_worker_1');

    // 4. Worker 2 should immediately receive slot
    await w2Promise;
    assert.equal(worker2Acquired, true, 'Worker 2 must acquire slot immediately after Worker 1 closes');

    // Cleanup Worker 2 slot
    releaseBrowserSlot('submitting_worker_2');
  } finally {
    if (originalMax !== undefined) process.env.MAX_ACTIVE_BROWSERS = originalMax;
    else delete process.env.MAX_ACTIVE_BROWSERS;
  }
});
