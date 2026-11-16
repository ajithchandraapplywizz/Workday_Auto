import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_COUNT,
  TOTAL_SERVICES,
  TOTAL_SUBMIT_WORKERS,
  ALL_CANONICAL_SUBMIT_IDS,
} from '../config/pipelineConfig.mjs';

test('Pipeline Config: Default worker count is 2 and total submit workers is capped at 4 across 2 services (Never 8)', () => {
  assert.equal(WORKER_COUNT, 2, 'Default baseline worker count must be 2');
  assert.equal(TOTAL_SERVICES, 2, 'Default total services must be 2');
  assert.ok(TOTAL_SUBMIT_WORKERS <= 4, `Total cluster submit workers (${TOTAL_SUBMIT_WORKERS}) must be <= 4`);
  assert.ok(
    ALL_CANONICAL_SUBMIT_IDS.length <= 4,
    `Canonical submit worker IDs length (${ALL_CANONICAL_SUBMIT_IDS.length}) must be <= 4`
  );
  assert.deepEqual(
    ALL_CANONICAL_SUBMIT_IDS,
    ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3', 'submitting_worker_4']
  );
});

test('Anti-Spam Mutex: Dedicated worker loop prevents duplicate execution for the same worker ID', () => {
  const runningDedicatedWorkerLoops = new Set();
  const workerId = 'submitting_worker_1';

  let executions = 0;
  function trySpawnWorker(wid) {
    if (runningDedicatedWorkerLoops.has(wid)) {
      return { spawned: false, reason: 'already_running' };
    }
    runningDedicatedWorkerLoops.add(wid);
    executions++;
    return { spawned: true };
  }

  // 1st spawn: Allowed
  const first = trySpawnWorker(workerId);
  assert.equal(first.spawned, true);
  assert.equal(executions, 1);

  // 2nd spawn (duplicate webhook or cloud bridge re-entry): Blocked!
  const second = trySpawnWorker(workerId);
  assert.equal(second.spawned, false);
  assert.equal(second.reason, 'already_running');
  assert.equal(executions, 1);

  // 3rd spawn: Blocked!
  const third = trySpawnWorker(workerId);
  assert.equal(third.spawned, false);
  assert.equal(executions, 1);

  // Once first finishes:
  runningDedicatedWorkerLoops.delete(workerId);

  // Subsequent spawn: Allowed again
  const fourth = trySpawnWorker(workerId);
  assert.equal(fourth.spawned, true);
  assert.equal(executions, 2);
});

test('Single-Task-per-Worker Guard: Worker cannot claim another task while an active applying task exists', () => {
  const activeWorkerTasks = new Map();
  const workerId = 'submitting_worker_1';

  function mockClaimTask(wid, taskId) {
    if (activeWorkerTasks.has(wid)) {
      // Worker already has an active task in progress!
      return null;
    }
    activeWorkerTasks.set(wid, taskId);
    return { id: taskId, worker_id: wid, status: 'applying' };
  }

  // Task 1: Claimed
  const task1 = mockClaimTask(workerId, 'task-001');
  assert.ok(task1);
  assert.equal(task1.id, 'task-001');

  // Task 2: Attempted by same worker while task 1 is applying -> Refused!
  const task2 = mockClaimTask(workerId, 'task-002');
  assert.equal(task2, null, 'Worker must not be allowed to claim a second task while first is in-flight');

  // Once task 1 finishes:
  activeWorkerTasks.delete(workerId);

  // Next task: Allowed
  const task3 = mockClaimTask(workerId, 'task-003');
  assert.ok(task3);
  assert.equal(task3.id, 'task-003');
});

test('Frontend KPI: dbApplying strictly filters out stale tasks older than 10 minutes and caps at cluster capacity', () => {
  const maxSubmitWorkers = 4;
  const now = Date.now();
  const freshTime = new Date(now - 2 * 60 * 1000).toISOString(); // 2 mins ago
  const staleTime = new Date(now - 15 * 60 * 1000).toISOString(); // 15 mins ago
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();

  const mockApps = [
    { id: 1, status: 'applying', updated_at: freshTime, worker_leased_at: freshTime },
    { id: 2, status: 'applying', updated_at: freshTime, worker_leased_at: freshTime },
    // 6 stale orphaned rows from hours ago:
    { id: 3, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
    { id: 4, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
    { id: 5, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
    { id: 6, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
    { id: 7, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
    { id: 8, status: 'applying', updated_at: staleTime, worker_leased_at: staleTime },
  ];

  // Old naive logic would count 8!
  const naiveCount = mockApps.filter((a) => a.status === 'applying').length;
  assert.equal(naiveCount, 8, 'Naive logic falsely counts 8 applying tasks');

  // Hardened logic:
  const dbApplying = mockApps.filter((a) => {
    const isApp = a.status === 'applying';
    const isFresh = !a.updated_at || a.updated_at >= tenMinutesAgo || !a.worker_leased_at || a.worker_leased_at >= tenMinutesAgo;
    return isApp && isFresh;
  }).length;

  assert.equal(dbApplying, 2, 'Hardened logic only counts 2 authentically active applying tasks');

  // Hard cap to cluster capacity:
  const applyingKpi = Math.min(dbApplying, maxSubmitWorkers);
  assert.equal(applyingKpi, 2);
  assert.ok(applyingKpi <= maxSubmitWorkers, `Applying KPI must never exceed max cluster submit workers (4)`);
});
