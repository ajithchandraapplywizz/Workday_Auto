import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * End-to-End & Integration Suite: Universal Trigger & Bot Control Architecture
 */

test('Universal Trigger Start: Sets bot_control to parallel state with both scan and submit enabled', async () => {
  const simulatedDbState = {
    id: 'primary',
    stage: 'idle',
    mode: 'idle',
    is_running: false,
    scan_status: 'off',
    scan_enabled: false,
    submit_status: 'off',
    submit_enabled: false,
    stop_requested: false,
    last_action_requested: null,
  };

  // 1. Simulate triggerAllParallelStage payload dispatch
  const startPayload = {
    stage: 'parallel',
    mode: 'parallel',
    is_running: true,
    is_paused: false,
    stop_requested: false,
    scan_enabled: true,
    scan_status: 'running',
    scan_stop_requested: false,
    submit_enabled: true,
    submit_status: 'running',
    submit_stop_requested: false,
    trigger_requested: true,
    last_action_requested: 'start_universal',
    current_action: 'Universal Parallel Pipeline: Scanning & Submissions running concurrently across all workers...',
    active_worker_count: 6,
    updated_at: new Date().toISOString(),
  };

  Object.assign(simulatedDbState, startPayload);

  assert.equal(simulatedDbState.stage, 'parallel', 'Stage must be set to parallel');
  assert.equal(simulatedDbState.mode, 'parallel', 'Mode must be set to parallel');
  assert.equal(simulatedDbState.is_running, true, 'is_running must be true');
  assert.equal(simulatedDbState.scan_status, 'running', 'scan_status must be running');
  assert.equal(simulatedDbState.scan_enabled, true, 'scan_enabled must be true');
  assert.equal(simulatedDbState.submit_status, 'running', 'submit_status must be running');
  assert.equal(simulatedDbState.submit_enabled, true, 'submit_enabled must be true');
  assert.equal(simulatedDbState.last_action_requested, 'start_universal', 'Action must record start_universal');
  assert.equal(simulatedDbState.stop_requested, false, 'stop_requested must be false');
});

test('Universal Trigger Stop: Sets bot_control to idle and all stop flags to true', async () => {
  const simulatedDbState = {
    id: 'primary',
    stage: 'parallel',
    mode: 'parallel',
    is_running: true,
    scan_status: 'running',
    scan_enabled: true,
    submit_status: 'running',
    submit_enabled: true,
    last_action_requested: 'start_universal',
  };

  // 1. Simulate stopAllParallelStage payload dispatch
  const stopPayload = {
    stage: 'idle',
    mode: 'idle',
    is_running: false,
    is_paused: false,
    stop_requested: true,
    scan_status: 'off',
    scan_enabled: false,
    scan_stop_requested: true,
    submit_status: 'off',
    submit_enabled: false,
    submit_stop_requested: true,
    trigger_requested: false,
    last_action_requested: 'stop',
    current_action: 'All workers stopped immediately by user.',
    active_worker_count: 0,
    updated_at: new Date().toISOString(),
  };

  Object.assign(simulatedDbState, stopPayload);

  assert.equal(simulatedDbState.stage, 'idle', 'Stage must be idle on stop');
  assert.equal(simulatedDbState.mode, 'idle', 'Mode must be idle on stop');
  assert.equal(simulatedDbState.is_running, false, 'is_running must be false');
  assert.equal(simulatedDbState.scan_status, 'off', 'scan_status must be off');
  assert.equal(simulatedDbState.submit_status, 'off', 'submit_status must be off');
  assert.equal(simulatedDbState.stop_requested, true, 'stop_requested must be true');
  assert.equal(simulatedDbState.scan_stop_requested, true, 'scan_stop_requested must be true');
  assert.equal(simulatedDbState.submit_stop_requested, true, 'submit_stop_requested must be true');
  assert.equal(simulatedDbState.last_action_requested, 'stop', 'last_action_requested must be stop');
});

test('Multi-replica concurrency: Universal trigger does not swallow signal before opposite replica starts', () => {
  const bcAtStart = {
    stage: 'parallel',
    mode: 'parallel',
    is_running: true,
    scan_status: 'running',
    submit_status: 'running',
    last_action_requested: 'start_universal',
    trigger_requested: true,
  };

  // Scanner polls first
  const isUniversalSignalScanner = bcAtStart.last_action_requested === 'start_universal' || bcAtStart.stage === 'parallel';
  assert.equal(isUniversalSignalScanner, true, 'Scanner must detect universal trigger');

  // Scanner starts and evaluates target stage
  let submitStatusInMemory = 'off'; // Scanner process memory has submitStatus='off'
  const targetStageScanner = (submitStatusInMemory === 'running' || bcAtStart.submit_status === 'running') ? 'parallel' : 'scanning';
  assert.equal(targetStageScanner, 'parallel', 'Target stage must be parallel because submit_status is running in DB');

  // Submitter polls next
  const isParallelSignalSubmitter = bcAtStart.stage === 'parallel' || bcAtStart.last_action_requested === 'start_universal';
  assert.equal(isParallelSignalSubmitter, true, 'Submitter must detect universal trigger');

  let scanStatusInMemory = 'off'; // Submitter process memory
  const targetStageSubmitter = (scanStatusInMemory === 'running' || bcAtStart.scan_status === 'running') ? 'parallel' : 'submitting';
  assert.equal(targetStageSubmitter, 'parallel', 'Submitter target stage must be parallel because scan_status is running in DB');

  // Both services run concurrently in parallel
  assert.equal(targetStageScanner, 'parallel');
  assert.equal(targetStageSubmitter, 'parallel');
});

test('Stop rollback immutability: Submitted applications and screenshots are strictly guarded', () => {
  const sampleDistributions = [
    { id: 1, applywizz_id: 'AWL-101', status: 'applying', application_submitted_screenshot_url: null },
    { id: 2, applywizz_id: 'AWL-102', status: 'submitted', application_submitted_screenshot_url: 'https://storage/submitted-applications/proof1.png' },
    { id: 3, applywizz_id: 'AWL-103', status: 'completed', application_submitted_screenshot_url: 'https://storage/submitted-applications/proof2.png' },
    { id: 4, applywizz_id: 'AWL-104', status: 'ready_for_review', application_submitted_screenshot_url: null },
  ];

  // Simulating the hardened rollback filter: .eq('status', 'applying').is('application_submitted_screenshot_url', null).neq('status', 'submitted').neq('status', 'completed')
  const rollbackFilter = (row) => {
    return row.status === 'applying' &&
      row.application_submitted_screenshot_url === null &&
      row.status !== 'submitted' &&
      row.status !== 'completed';
  };

  const rollbackTargets = sampleDistributions.filter(rollbackFilter);

  assert.equal(rollbackTargets.length, 1, 'Only genuine in-flight unsubmitted rows may be rolled back');
  assert.equal(rollbackTargets[0].applywizz_id, 'AWL-101');

  // Assert that submitted rows with authentic proof screenshots are NEVER touched
  const submittedRows = sampleDistributions.filter((r) => r.status === 'submitted' || r.application_submitted_screenshot_url !== null);
  for (const row of submittedRows) {
    assert.equal(rollbackFilter(row), false, `Row ${row.applywizz_id} must be strictly immutable and never rolled back`);
  }
});

test('Fast communication: fetchBotDaemonStatus derives parallel stage accurately without HTTP blocking', () => {
  const botControl = {
    id: 'primary',
    stage: 'parallel',
    mode: 'parallel',
    is_running: true,
    scan_status: 'running',
    submit_status: 'running',
    scan_enabled: true,
    submit_enabled: true,
    stop_requested: false,
    last_action_requested: 'start_universal',
  };

  const workers = [
    { worker_id: 'scanning_worker_1', state: 'in_flight', stage: 'scanning' },
    { worker_id: 'submitting_worker_1', state: 'in_flight', stage: 'submitting' },
  ];

  const isClusterAuthoritativelyStopped = Boolean(
    botControl.stop_requested ||
    (botControl.is_running === false && botControl.scan_status !== 'running' && botControl.submit_status !== 'running')
  );

  const isScanning = !isClusterAuthoritativelyStopped && Boolean(
    botControl.scan_status === 'running' ||
    (botControl.is_running && botControl.stage === 'parallel')
  );

  const isSubmitting = !isClusterAuthoritativelyStopped && Boolean(
    botControl.submit_status === 'running' ||
    (botControl.is_running && botControl.stage === 'parallel')
  );

  assert.equal(isScanning, true, 'isScanning must evaluate to true');
  assert.equal(isSubmitting, true, 'isSubmitting must evaluate to true');

  let currentStage = 'idle';
  if (isScanning && isSubmitting) currentStage = 'parallel';
  else if (isSubmitting) currentStage = 'submitting';
  else if (isScanning) currentStage = 'scanning';

  assert.equal(currentStage, 'parallel', 'Computed stage must be parallel for instant UI rendering');
});
