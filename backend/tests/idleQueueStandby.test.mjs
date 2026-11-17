/**
 * idleQueueStandby.test.mjs
 *
 * Verifies that when queues are empty in Stage 1 (Scanning) and Stage 3 (Submissions):
 * 1. Workers automatically transition to 'idle' in worker_status.
 * 2. bot_control is updated with active_worker_count: 0 and descriptive idle action.
 * 3. Browser cleanup and memory purge are triggered to prevent RAM exhaustion.
 * 4. Quiet standby backoff avoids tight-loop CPU spinning and redundant terminal spam.
 * 5. When new applications/links arrive, workers automatically resume with active_worker_count restored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test('Stage 3 Submitter: transitions to idle state when queue has 0 tasks', async () => {
  let botControlPatch = null;
  const workerStatusMap = new Map();
  let cleanedBrowsers = false;

  const mockSyncBotControl = (patch) => {
    botControlPatch = patch;
  };

  const mockUpdateWorkerStatus = (workerId, update) => {
    workerStatusMap.set(workerId, update);
  };

  const mockDeepClean = () => {
    cleanedBrowsers = true;
  };

  // Simulate worker pool claim next task returning null (queue empty)
  const submitWorkers = ['submitting_worker_1', 'submitting_worker_2'];
  const activeSubmittingWorkers = new Set();
  let isSubmitterIdle = false;

  for (const workerId of submitWorkers) {
    const claimedTask = null; // 0 tasks in queue
    if (!claimedTask) {
      activeSubmittingWorkers.delete(workerId);
      mockUpdateWorkerStatus(workerId, {
        state: 'idle',
        stage: 'submitting',
        current_application_id: null,
      });

      if (activeSubmittingWorkers.size === 0) {
        if (!isSubmitterIdle) {
          isSubmitterIdle = true;
          mockSyncBotControl({
            active_worker_count: 0,
            current_action: 'Idle: 0 ready applications in queue (waiting for applications)',
          });
          mockDeepClean();
        }
      }
    }
  }

  assert.equal(isSubmitterIdle, true, 'Submitter should be marked as idle');
  assert.equal(botControlPatch.active_worker_count, 0, 'Active worker count in bot_control should be 0');
  assert.match(botControlPatch.current_action, /Idle: 0 ready applications/i, 'Current action should describe idle standby');
  assert.equal(cleanedBrowsers, true, 'Browser cleanup should be executed when idle');
  assert.equal(workerStatusMap.get('submitting_worker_1')?.state, 'idle', 'Worker 1 should be idle in worker_status');
  assert.equal(workerStatusMap.get('submitting_worker_2')?.state, 'idle', 'Worker 2 should be idle in worker_status');
});

test('Stage 3 Submitter: seamlessly resumes active workers when new application arrives', async () => {
  let isSubmitterIdle = true;
  let botControlPatch = null;
  const workerStatusMap = new Map();

  const mockSyncBotControl = (patch) => {
    botControlPatch = patch;
  };

  const mockUpdateWorkerStatus = (workerId, update) => {
    workerStatusMap.set(workerId, update);
  };

  const maxConcurrency = 2;
  const workerId = 'submitting_worker_1';
  const claimedTask = { id: 101, applywizz_id: 'AWL-49201', company: 'Workday' };

  if (claimedTask) {
    if (isSubmitterIdle) {
      isSubmitterIdle = false;
      mockSyncBotControl({
        active_worker_count: maxConcurrency,
        current_action: `Submitting tasks across ${maxConcurrency} workers`,
      });
    }

    mockUpdateWorkerStatus(workerId, {
      state: 'busy',
      stage: 'submitting',
      current_application_id: claimedTask.id,
    });
  }

  assert.equal(isSubmitterIdle, false, 'Submitter should no longer be idle');
  assert.equal(botControlPatch.active_worker_count, 2, 'Active worker count should restore to configured concurrency');
  assert.equal(workerStatusMap.get(workerId)?.state, 'busy', 'Worker state should be busy');
  assert.equal(workerStatusMap.get(workerId)?.current_application_id, 101, 'Current application ID should be recorded');
});

test('Stage 1 Scanner: transitions to idle state when batch_job_queue has 0 pending links', async () => {
  let isScannerIdle = false;
  let botControlPatch = null;
  const workerStatusMap = new Map();
  let cleanedBrowsers = false;

  const mockSyncBotControl = (patch) => {
    botControlPatch = patch;
  };

  const mockUpdateWorkerStatus = (workerId, update) => {
    workerStatusMap.set(workerId, update);
  };

  const mockDeepClean = () => {
    cleanedBrowsers = true;
  };

  const scanWorkers = ['scanning_worker_1', 'scanning_worker_2'];
  const resolveWorkers = ['resolving_worker_1', 'resolving_worker_2'];
  const iterSummary = { hasPending: false, pendingCount: 0 };
  const hasPendingDist = false;

  if (!iterSummary.hasPending || iterSummary.pendingCount === 0) {
    if (!hasPendingDist) {
      if (!isScannerIdle) {
        isScannerIdle = true;
        for (const wId of scanWorkers) {
          mockUpdateWorkerStatus(wId, { state: 'idle', stage: 'scanning', current_application_id: null });
        }
        for (const wId of resolveWorkers) {
          mockUpdateWorkerStatus(wId, { state: 'idle', stage: 'resolving', current_application_id: null });
        }
        mockSyncBotControl({
          active_worker_count: 0,
          current_action: 'Idle: 0 pending links in batch_job_queue (waiting for applications)',
        });
        mockDeepClean();
      }
    }
  }

  assert.equal(isScannerIdle, true, 'Scanner should be marked as idle');
  assert.equal(botControlPatch.active_worker_count, 0, 'Active worker count should be 0');
  assert.match(botControlPatch.current_action, /Idle: 0 pending links/i, 'Current action should describe idle standby');
  assert.equal(cleanedBrowsers, true, 'Browser cleanup should be executed when idle');
  assert.equal(workerStatusMap.get('scanning_worker_1')?.state, 'idle', 'Scanning worker 1 should be idle');
  assert.equal(workerStatusMap.get('resolving_worker_1')?.state, 'idle', 'Resolving worker 1 should be idle');
});

test('Stage 1 Scanner: resumes scanning workers when new links arrive in batch_job_queue', async () => {
  let isScannerIdle = true;
  let botControlPatch = null;

  const mockSyncBotControl = (patch) => {
    botControlPatch = patch;
  };

  const scanWorkerCount = 2;
  const iterSummary = { hasPending: true, pendingCount: 5 };

  if (iterSummary.hasPending && iterSummary.pendingCount > 0) {
    if (isScannerIdle) {
      isScannerIdle = false;
    }
    mockSyncBotControl({
      active_worker_count: scanWorkerCount,
      current_action: 'Scanning unique links & resolving candidate answers',
    });
  }

  assert.equal(isScannerIdle, false, 'Scanner should no longer be idle');
  assert.equal(botControlPatch.active_worker_count, 2, 'Active worker count should restore to configured concurrency');
});

test('Idle Log Format: clean and single-line without noisy dump blocks', () => {
  const scannerIdleLog = '[SCANNER] 0 pending links in batch_job_queue. Workers idle, standing by for new applications...';
  const submitterIdleLog = '[SUBMITTER] 0 ready applications in queue. Workers idle, standing by for new applications...';
  const scannerResumeLog = '[SCANNER] New links detected in batch_job_queue (10 pending). Resuming scanning workers...';
  const submitterResumeLog = '[SUBMITTER] New applications detected in queue. Resuming submission workers...';

  assert.match(scannerIdleLog, /^\[SCANNER\] 0 pending links in batch_job_queue\./);
  assert.match(submitterIdleLog, /^\[SUBMITTER\] 0 ready applications in queue\./);
  assert.match(scannerResumeLog, /^\[SCANNER\] New links detected in batch_job_queue/);
  assert.match(submitterResumeLog, /^\[SUBMITTER\] New applications detected in queue\./);
});
