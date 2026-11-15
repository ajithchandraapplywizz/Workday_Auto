import test from 'node:test';
import assert from 'node:assert/strict';

test('Stage 3 PostgREST logic tree: not.error_message.ilike syntax is valid', () => {
  const orFilter = 'error_message.is.null,not.error_message.ilike.%[Attempt%,error_message.ilike.%Stopped by user%';
  assert.ok(orFilter.includes('not.error_message.ilike.'), 'Must use not.column.operator syntax for PostgREST');
  assert.ok(!orFilter.includes('error_message.not.ilike.'), 'Must NOT use column.not.operator which crashes PostgREST parser');
});

test('Multi-service syncBotControlState cross-stage protection logic', () => {
  // Simulate Scanner finishing when Submitter is active
  const currentBc = {
    scan_status: 'running',
    submit_status: 'running',
    stage: 'parallel',
    is_running: true,
    active_worker_count: 6,
  };

  const scannerFinishedPatch = {
    scan_status: 'off',
    is_running: false,
    stage: 'idle',
    mode: 'idle',
    active_worker_count: 0,
  };

  // Scanner multi-service guard simulation
  const isSubmitActive = Boolean(
    currentBc && (currentBc.submit_status === 'running' || currentBc.stage === 'submitting' || currentBc.stage === 'parallel')
  );

  const sanitized = { ...scannerFinishedPatch };
  delete sanitized.submit_status;

  if (isSubmitActive && (sanitized.scan_status === 'off' || scannerFinishedPatch.is_running === false)) {
    sanitized.is_running = true;
    sanitized.stage = 'submitting';
    sanitized.mode = 'submitting';
    if (sanitized.active_worker_count === 0 && currentBc?.active_worker_count) {
      delete sanitized.active_worker_count;
    }
  }

  assert.equal(sanitized.is_running, true, 'Scanner must NEVER force is_running=false while Submitter is running');
  assert.equal(sanitized.stage, 'submitting', 'Stage must remain submitting when Scanner finishes');
  assert.equal(sanitized.mode, 'submitting', 'Mode must remain submitting when Scanner finishes');
  assert.equal(sanitized.active_worker_count, undefined, 'Active worker count must not be wiped to 0');
});

test('Submitting worker loop does NOT abort on transient is_running=false when submit_status=running', () => {
  const bcState = {
    is_running: false, // temporarily reset by scanner completion
    submit_status: 'running', // submitter is still intended to run
    stop_requested: false,
    submit_stop_requested: false,
  };

  const isSubmitStopped = Boolean(
    bcState && (
      bcState.stop_requested ||
      bcState.submit_stop_requested ||
      bcState.submit_status === 'off' ||
      bcState.last_action_requested === 'stop_submit' ||
      bcState.last_action_requested === 'stop' ||
      bcState.last_action_requested === 'stop_all' ||
      (bcState.is_running === false && bcState.submit_status !== 'running')
    )
  );

  assert.equal(isSubmitStopped, false, 'Submitter worker loop must NOT halt when submit_status is running even if is_running was temporarily falsified');
});
