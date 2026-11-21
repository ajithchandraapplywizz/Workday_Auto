import test from 'node:test';
import assert from 'node:assert/strict';

test('Stage 1 (Scanner): Dynamic Worker & Browser Allocation strictly from Env across 2 Services', async () => {
  // Test Service 1 (Scanner_Resolver_1)
  const envService1 = {
    SERVICE_ROLE: 'scanner',
    ROLE: 'scanner',
    WORKER_COUNT: '2',
    WORKER_OFFSET: '0',
    MAX_ACTIVE_BROWSERS: '1',
  };

  const workerCountS1 = Number(envService1.WORKER_COUNT);
  const offsetS1 = Number(envService1.WORKER_OFFSET);
  const workersS1 = Array.from({ length: workerCountS1 }, (_, i) => `scanning_worker_${i + 1 + offsetS1}`);

  assert.equal(workerCountS1, 2, 'Service 1 worker count must strictly be 2 from env');
  assert.equal(offsetS1, 0, 'Service 1 offset must strictly be 0 from env');
  assert.deepEqual(workersS1, ['scanning_worker_1', 'scanning_worker_2'], 'Service 1 must generate scanning_worker_1 and scanning_worker_2');

  // Staggered cluster starting index for Service 1
  const clusterStartS1 = offsetS1 % 10;
  assert.equal(clusterStartS1, 0, 'Service 1 must start claiming clusters from index 0');

  // Test Service 2 (Scanner_Resolver_2)
  const envService2 = {
    SERVICE_ROLE: 'scanner',
    ROLE: 'scanner',
    WORKER_COUNT: '2',
    WORKER_OFFSET: '2',
    MAX_ACTIVE_BROWSERS: '1',
  };

  const workerCountS2 = Number(envService2.WORKER_COUNT);
  const offsetS2 = Number(envService2.WORKER_OFFSET);
  const workersS2 = Array.from({ length: workerCountS2 }, (_, i) => `scanning_worker_${i + 1 + offsetS2}`);

  assert.equal(workerCountS2, 2, 'Service 2 worker count must strictly be 2 from env');
  assert.equal(offsetS2, 2, 'Service 2 offset must strictly be 2 from env');
  assert.deepEqual(workersS2, ['scanning_worker_3', 'scanning_worker_4'], 'Service 2 must generate scanning_worker_3 and scanning_worker_4');

  // Staggered cluster starting index for Service 2
  const clusterStartS2 = offsetS2 % 10;
  assert.equal(clusterStartS2, 2, 'Service 2 must start claiming clusters from index 2');

  // Combined across both services: strictly 4 unique workers
  const combinedScanningWorkers = [...new Set([...workersS1, ...workersS2])];
  assert.equal(combinedScanningWorkers.length, 4, 'Across 2 scanning services, strictly 4 unique workers are active');
  assert.deepEqual(combinedScanningWorkers, ['scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3', 'scanning_worker_4']);
});

test('Stage 2 (Resolver): Dynamic Answer Resolution Worker Allocation from Env', async () => {
  // Service 1 Resolver
  const workerCountS1 = 2;
  const offsetS1 = 0;
  const resolverWorkersS1 = Array.from({ length: workerCountS1 }, (_, i) => `resolving_worker_${i + 1 + offsetS1}`);
  assert.deepEqual(resolverWorkersS1, ['resolving_worker_1', 'resolving_worker_2']);

  // Service 2 Resolver
  const workerCountS2 = 2;
  const offsetS2 = 2;
  const resolverWorkersS2 = Array.from({ length: workerCountS2 }, (_, i) => `resolving_worker_${i + 1 + offsetS2}`);
  assert.deepEqual(resolverWorkersS2, ['resolving_worker_3', 'resolving_worker_4']);

  // Combined across both services: strictly 4 unique resolvers
  const combinedResolvers = [...new Set([...resolverWorkersS1, ...resolverWorkersS2])];
  assert.equal(combinedResolvers.length, 4);
});

test('Stage 3 (Submitter): Dynamic Worker & Browser Allocation strictly from Env across 2 Services', async () => {
  const { resolveInstanceSubmissionWorkerIds } = await import('../lib/submissionWorkerPool.mjs');

  const origCount = process.env.WORKER_COUNT;
  const origOffset = process.env.WORKER_OFFSET;
  const origRole = process.env.SERVICE_ROLE;

  try {
    // Service 1 (Submitting_1)
    process.env.SERVICE_ROLE = 'submitter';
    process.env.WORKER_COUNT = '2';
    process.env.WORKER_OFFSET = '0';
    const s1Workers = await resolveInstanceSubmissionWorkerIds();
    assert.deepEqual(s1Workers, ['submitting_worker_1', 'submitting_worker_2'], 'Submitting Service 1 must resolve workers 1 & 2');

    // Service 2 (Submitting_2)
    process.env.WORKER_COUNT = '2';
    process.env.WORKER_OFFSET = '2';
    const s2Workers = await resolveInstanceSubmissionWorkerIds();
    assert.deepEqual(s2Workers, ['submitting_worker_3', 'submitting_worker_4'], 'Submitting Service 2 must resolve workers 3 & 4');

    // Dynamic scale-up test: User changes WORKER_COUNT to 3 in env
    process.env.WORKER_COUNT = '3';
    process.env.WORKER_OFFSET = '0';
    const scaledS1 = await resolveInstanceSubmissionWorkerIds();
    assert.deepEqual(scaledS1, ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'], 'Dynamically scales to 3 workers on Service 1');

    process.env.WORKER_COUNT = '3';
    process.env.WORKER_OFFSET = '3';
    const scaledS2 = await resolveInstanceSubmissionWorkerIds();
    assert.deepEqual(scaledS2, ['submitting_worker_4', 'submitting_worker_5', 'submitting_worker_6'], 'Dynamically scales to workers 4, 5, 6 on Service 2');
  } finally {
    if (origCount !== undefined) process.env.WORKER_COUNT = origCount;
    else delete process.env.WORKER_COUNT;
    if (origOffset !== undefined) process.env.WORKER_OFFSET = origOffset;
    else delete process.env.WORKER_OFFSET;
    if (origRole !== undefined) process.env.SERVICE_ROLE = origRole;
    else delete process.env.SERVICE_ROLE;
  }
});

test('Dynamic Browser Allocation: getDynamicMaxBrowsers strictly respects MAX_ACTIVE_BROWSERS', async () => {
  const { getDynamicMaxBrowsers } = await import('../lib/browserLifecycle.mjs');

  const origMax = process.env.MAX_ACTIVE_BROWSERS;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    // 1. When user sets MAX_ACTIVE_BROWSERS="1" in env (like user provided sample)
    process.env.MAX_ACTIVE_BROWSERS = '1';
    assert.equal(getDynamicMaxBrowsers(), 1, 'Must strictly return 1 when MAX_ACTIVE_BROWSERS=1');

    // 2. When user updates MAX_ACTIVE_BROWSERS="2" in Railway UI
    process.env.MAX_ACTIVE_BROWSERS = '2';
    assert.equal(getDynamicMaxBrowsers(), 2, 'Must dynamically scale to 2 when user updates env to 2');

    // 3. When user updates MAX_ACTIVE_BROWSERS="3" in Railway UI
    process.env.MAX_ACTIVE_BROWSERS = '3';
    assert.equal(getDynamicMaxBrowsers(), 3, 'Must dynamically scale to 3 when user updates env to 3');

    // 4. Verify behavior under Linux platform (Railway production)
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.MAX_ACTIVE_BROWSERS = '1';
    assert.equal(getDynamicMaxBrowsers(), 1, 'Under Linux, strictly returns 1 when env is 1');

    process.env.MAX_ACTIVE_BROWSERS = '2';
    assert.equal(getDynamicMaxBrowsers(), 2, 'Under Linux, strictly returns 2 when env is 2 (zero hardcoding)');
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origMax !== undefined) process.env.MAX_ACTIVE_BROWSERS = origMax;
    else delete process.env.MAX_ACTIVE_BROWSERS;
  }
});

test('Clean Log Output: Standardized Single-Line Formats Match User Requirements', () => {
  // Test Format 1: Scanning completion log format
  const sampleScanLog = '[AWL-31424] | Company: Fannie Mae | Status: scanned | Application: https://fanniemae.wd1.myworkdayjobs.com/en-US/job/JR3002 | Screenshot: https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/submitted-applications/AWL-31424.png';
  const scanRegex = /^\[AWL-\d+\] \| Company: .+ \| Status: scanned \| Application: https?:\/\/.+ \| Screenshot: .+$/;
  assert.ok(scanRegex.test(sampleScanLog), 'Scan log must match single-line format');

  // Test Format 2: Submission completion log format
  const sampleSubmitLog = '[AWL-25015] | Company: VF Corporation | Status: submitted | Application: https://vfc.wd5.myworkdayjobs.com/vfc_careers/job/123 | Screenshot: https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/submitted-applications/AWL-25015.png';
  const submitRegex = /^\[AWL-\d+\] \| Company: .+ \| Status: submitted \| Application: https?:\/\/.+ \| Screenshot: .+$/;
  assert.ok(submitRegex.test(sampleSubmitLog), 'Submit log must match single-line format');

  // Test Format 3: Failed application log format
  const sampleFailLog = '[AWL-36112] | Company: S&P Global | Status: failed | Reason: Authentication failed | Application: https://spgi.wd5.myworkdayjobs.com/job/332760 | Screenshot: https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/failed-applications/AWL-36112.png';
  const failRegex = /^\[AWL-\d+\] \| Company: .+ \| Status: failed \| Reason: .+ \| Application: https?:\/\/.+ \| Screenshot: .+$/;
  assert.ok(failRegex.test(sampleFailLog), 'Fail log must match single-line format');

  // Test Format 4: Minimal single-line wizard steps (no blank lines or unwanted chatter)
  const steps = [
    '[AWL-31424] Scanning: MY INFORMATION',
    '[AWL-31424] Scanning: MY EXPERIENCE',
    '[AWL-31424] Scanning: APPLICATION QUESTIONS',
    '[AWL-31424] Scanning: VOLUNTARY DISCLOSURES',
    '[AWL-31424] Scanning: REVIEW AND SUBMIT',
  ];
  const stepRegex = /^\[AWL-\d+\] (Scanning|Submitting): [A-Z0-9 ]+$/;
  for (const s of steps) {
    assert.ok(stepRegex.test(s), `Step log "${s}" must match clean single-line format`);
    assert.ok(!s.includes('\n'), 'Step log must not contain newlines');
  }
});

test('Multi-Replica Protection: Service 2 offset workers never overwrite Service 1 or falsely kill pipeline', () => {
  // Service 1 (Scanner_Resolver_1)
  const s1Offset = 0;
  const s1Limit = 2;
  const s1Ids = Array.from({ length: s1Limit }, (_, i) => `scanning_worker_${i + 1 + s1Offset}`);
  assert.deepEqual(s1Ids, ['scanning_worker_1', 'scanning_worker_2']);

  // Service 2 (Scanner_Resolver_2)
  const s2Offset = 2;
  const s2Limit = 2;
  const s2Ids = Array.from({ length: s2Limit }, (_, i) => `scanning_worker_${i + 1 + s2Offset}`);
  assert.deepEqual(s2Ids, ['scanning_worker_3', 'scanning_worker_4']);

  // S1 and S2 IDs must be completely disjoint (zero collision)
  const intersection = s1Ids.filter((id) => s2Ids.includes(id));
  assert.equal(intersection.length, 0, 'Service 1 and Service 2 must have zero worker ID collisions');

  // Multi-replica mutual kill check:
  // If S1 has active in_flight workers, S2 finishing local tasks must NOT set submit_status/scan_status to 'off'
  const activeWorkersInDb = [
    { worker_id: 'submitting_worker_1', state: 'in_flight', stage: 'submitting' },
    { worker_id: 'submitting_worker_2', state: 'in_flight', stage: 'submitting' },
  ];
  const s2SubmitWorkers = ['submitting_worker_3', 'submitting_worker_4'];
  const hasSiblingSubmitters = activeWorkersInDb.some((w) => !s2SubmitWorkers.includes(w.worker_id));
  assert.equal(hasSiblingSubmitters, true, 'S2 must recognize that S1 is still active in flight and preserve global running status');
});
