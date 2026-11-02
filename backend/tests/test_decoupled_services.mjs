import assert from 'node:assert/strict';
import {
  registerActiveBrowser,
  unregisterActiveBrowser,
  abortScanBrowsers,
  abortSubmitBrowsers,
  isScanStopRequested,
  isSubmitStopRequested,
  setScanStop,
  setSubmitStop,
  getActiveBrowserCount,
} from '../lib/browserLifecycle.mjs';

async function testDecoupledLifecycle() {
  console.log('🧪 Testing Decoupled Browser Lifecycle & Independent Stop Signals...');

  // 1. Reset states
  setScanStop(false);
  setSubmitStop(false);
  assert.equal(isScanStopRequested(), false, 'Scan stop should be false initially');
  assert.equal(isSubmitStopRequested(), false, 'Submit stop should be false initially');

  // 2. Mock browser objects
  let scanClosed = false;
  let submitClosed = false;

  const mockScanBrowser = {
    close: async () => { scanClosed = true; },
  };
  const mockSubmitBrowser = {
    close: async () => { submitClosed = true; },
  };

  // Register both browsers with explicit roles
  registerActiveBrowser(mockScanBrowser, { role: 'scan', workerId: 'worker_1' });
  registerActiveBrowser(mockSubmitBrowser, { role: 'submit', workerId: 'submitting_worker_1' });

  assert.equal(getActiveBrowserCount(), 2, 'Should have 2 active browsers registered');

  // 3. Trigger stop for SCAN ONLY
  console.log('🛑 Triggering abortScanBrowsers()...');
  setScanStop(true);
  assert.equal(isScanStopRequested(), true, 'Scan stop requested should be true');
  assert.equal(isSubmitStopRequested(), false, 'Submit stop requested should still be false');

  await abortScanBrowsers();

  assert.equal(scanClosed, true, 'Scan browser MUST be closed by abortScanBrowsers()');
  assert.equal(submitClosed, false, 'Submit browser MUST NOT be touched when scan is stopped!');
  assert.equal(getActiveBrowserCount(), 1, 'Only 1 browser (submit) should remain active');
  console.log('✅ PASS: Stopping Scanner did NOT abort Submitter browser!');

  // 4. Trigger stop for SUBMIT ONLY
  console.log('🛑 Triggering abortSubmitBrowsers()...');
  setSubmitStop(true);
  assert.equal(isSubmitStopRequested(), true, 'Submit stop requested should be true');

  await abortSubmitBrowsers();

  assert.equal(submitClosed, true, 'Submit browser MUST be closed by abortSubmitBrowsers()');
  assert.equal(getActiveBrowserCount(), 0, 'All browsers cleanly aborted');
  console.log('✅ PASS: Stopping Submitter aborted Submitter browser independently!');

  // Clean up
  setScanStop(false);
  setSubmitStop(false);
  console.log('🎉 ALL DECOUPLED LIFECYCLE TESTS PASSED PERFECTLY!\n');
}

testDecoupledLifecycle().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
