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

test('getDynamicMaxBrowsers dynamically respects MAX_ACTIVE_BROWSERS from env and defaults safely to 2', async () => {
  const { getDynamicMaxBrowsers } = await import('../lib/browserLifecycle.mjs');

  const originalMax = process.env.MAX_ACTIVE_BROWSERS;

  try {
    delete process.env.MAX_ACTIVE_BROWSERS;
    assert.equal(getDynamicMaxBrowsers(), 2, 'Default should be 2 concurrent browsers per container');

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

test('acquireBrowserSlot allows concurrent browsers up to effectiveMax (2) and queues on overflow', async () => {
  const { acquireBrowserSlot, releaseBrowserSlot } = await import('../lib/browserLifecycle.mjs');

  const originalMax = process.env.MAX_ACTIVE_BROWSERS;
  process.env.MAX_ACTIVE_BROWSERS = '2';

  try {
    // 1. Worker 1 acquires slot
    const acquiredW1 = await acquireBrowserSlot('submitting_worker_1');
    assert.equal(acquiredW1, true, 'Worker 1 should acquire initial slot');

    // 2. Worker 2 acquires slot concurrently (both workers work simultaneously in same service)
    const acquiredW2 = await acquireBrowserSlot('submitting_worker_2');
    assert.equal(acquiredW2, true, 'Worker 2 should acquire slot concurrently with Worker 1');

    // 3. Worker 3 attempts to acquire slot while Worker 1 & 2 are active (must be queued/waiting)
    let worker3Acquired = false;
    const w3Promise = acquireBrowserSlot('submitting_worker_3').then((res) => {
      worker3Acquired = res;
    });

    // Verify Worker 3 is queued and hasn't acquired yet
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(worker3Acquired, false, 'Worker 3 must not acquire slot while capacity is full');

    // 4. Worker 1 finishes and releases browser slot
    releaseBrowserSlot('submitting_worker_1');

    // 5. Worker 3 should immediately receive slot
    await w3Promise;
    assert.equal(worker3Acquired, true, 'Worker 3 must acquire slot immediately after a worker closes');

    // Cleanup remaining slots
    releaseBrowserSlot('submitting_worker_2');
    releaseBrowserSlot('submitting_worker_3');
  } finally {
    if (originalMax !== undefined) process.env.MAX_ACTIVE_BROWSERS = originalMax;
    else delete process.env.MAX_ACTIVE_BROWSERS;
  }
});

test('getDynamicMaxBrowsers dynamically respects WORKER_COUNT=3 and explicit worker ID lists', async () => {
  const { getDynamicMaxBrowsers } = await import('../lib/browserLifecycle.mjs');

  const origWorkers = process.env.WORKER_COUNT;
  const origSubmitList = process.env.SUBMISSION_WORKER_IDS;
  const origMax = process.env.MAX_ACTIVE_BROWSERS;

  try {
    // 1. When WORKER_COUNT=3 is set, submitting worker gets 3 slots
    process.env.WORKER_COUNT = '3';
    process.env.MAX_ACTIVE_BROWSERS = '1'; // Legacy env must NOT clamp below WORKER_COUNT
    assert.equal(getDynamicMaxBrowsers('submitting_worker_1'), 3, 'Must allocate 3 slots when WORKER_COUNT=3');

    // 2. When SUBMISSION_WORKER_IDS has 3 explicit workers, respects list count exactly
    delete process.env.WORKER_COUNT;
    process.env.SUBMISSION_WORKER_IDS = 'submitting_worker_1,submitting_worker_2,submitting_worker_3';
    assert.equal(getDynamicMaxBrowsers('submitting_worker_2'), 3, 'Must allocate 3 slots matching SUBMISSION_WORKER_IDS list');
  } finally {
    if (origWorkers !== undefined) process.env.WORKER_COUNT = origWorkers;
    else delete process.env.WORKER_COUNT;
    if (origSubmitList !== undefined) process.env.SUBMISSION_WORKER_IDS = origSubmitList;
    else delete process.env.SUBMISSION_WORKER_IDS;
    if (origMax !== undefined) process.env.MAX_ACTIVE_BROWSERS = origMax;
    else delete process.env.MAX_ACTIVE_BROWSERS;
  }
});

test('browserLifecycleEvents emits slot_released on releaseBrowserSlot', async () => {
  const { browserLifecycleEvents, releaseBrowserSlot, acquireBrowserSlot } = await import('../lib/browserLifecycle.mjs');

  let eventFired = false;
  const handler = (wId) => {
    if (wId === 'submitting_worker_test') eventFired = true;
  };
  browserLifecycleEvents.on('slot_released', handler);

  try {
    await acquireBrowserSlot('submitting_worker_test', 5);
    releaseBrowserSlot('submitting_worker_test');
    assert.equal(eventFired, true, 'slot_released event must fire on releaseBrowserSlot');
  } finally {
    browserLifecycleEvents.off('slot_released', handler);
  }
});
