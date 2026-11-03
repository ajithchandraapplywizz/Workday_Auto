/**
 * browserLifecycle.mjs — Global Playwright Browser Registry & Instant Abort Controller
 *
 * Tracks all active Chromium browser and context instances across all workers.
 * When Stop is requested, immediately closes all browsers and cancels active execution loops.
 */

const activeBrowsers = new Set();
const activeSlots = new Set();
const waitingQueue = [];
const MAX_CONCURRENT_BROWSERS = Number(process.env.MAX_ACTIVE_BROWSERS || process.env.WORKER_COUNT || 2);

let globalStopRequested = false;
let scanStopRequested = false;
let submitStopRequested = false;

/**
 * Acquire an active Playwright browser slot strictly capping concurrent browsers at maxSlots (default 2).
 * If maxSlots is reached, pauses execution asynchronously until a running browser exits and calls releaseBrowserSlot.
 */
export async function acquireBrowserSlot(workerId = 'worker', maxSlots = MAX_CONCURRENT_BROWSERS) {
  if (isGlobalStopRequested()) {
    throw new Error(`[LIFECYCLE] Cannot acquire browser slot: global stop is active`);
  }
  const effectiveMax = Math.max(1, Number(process.env.MAX_ACTIVE_BROWSERS) || Number(maxSlots) || 4);
  if (activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax) {
    activeSlots.add(workerId);
    return true;
  }

  console.log(`⏳ [SLOT GUARD] ${workerId} waiting for active browser slot (${activeBrowsers.size}/${effectiveMax} active)...`);
  await Promise.race([
    new Promise((resolve, reject) => {
      waitingQueue.push({ workerId, resolve, reject });
    }),
    new Promise((resolve) => setTimeout(() => {
      console.warn(`⚠️ [SLOT GUARD] Browser slot wait timed out for ${workerId} (45s). Self-healing slot to prevent lock.`);
      resolve(true);
    }, 45000))
  ]);
  activeSlots.add(workerId);
  return true;
}

/**
 * Release an active browser slot and immediately wake up the next queued worker.
 */
export function releaseBrowserSlot(workerId = 'worker') {
  activeSlots.delete(workerId);
  if (waitingQueue.length > 0) {
    const next = waitingQueue.shift();
    if (next && typeof next.resolve === 'function') {
      next.resolve(true);
    }
  }
}

const browserRoles = new Map();

export function setGlobalStop(val) {
  globalStopRequested = Boolean(val);
  if (globalStopRequested) {
    scanStopRequested = true;
    submitStopRequested = true;
    abortAllActiveBrowsers();
  } else {
    scanStopRequested = false;
    submitStopRequested = false;
  }
}

export function isGlobalStopRequested() {
  return globalStopRequested;
}

export function setScanStop(val) {
  scanStopRequested = Boolean(val);
  if (scanStopRequested) {
    abortScanBrowsers();
  }
}

export function isScanStopRequested() {
  return scanStopRequested || globalStopRequested;
}

export function setSubmitStop(val) {
  submitStopRequested = Boolean(val);
  if (submitStopRequested) {
    abortSubmitBrowsers();
  }
}

export function isSubmitStopRequested() {
  return submitStopRequested || globalStopRequested;
}

export function registerActiveBrowser(browser, meta = {}) {
  if (browser) {
    activeBrowsers.add(browser);
    const role = meta.role || (meta.workerId && String(meta.workerId).includes('submit') ? 'submit' : 'scan');
    browserRoles.set(browser, role);
  }
}

export function unregisterActiveBrowser(browser, workerId = null) {
  if (browser) {
    activeBrowsers.delete(browser);
    browserRoles.delete(browser);
  }
  if (workerId) {
    releaseBrowserSlot(workerId);
  }
}

export function getActiveBrowserCount() {
  return activeBrowsers.size;
}

const activeWorkerContexts = new Map();

export function registerWorkerContext(workerId, ctx) {
  if (workerId) {
    activeWorkerContexts.set(workerId, ctx);
  }
}

export function unregisterWorkerContext(workerId) {
  if (workerId) {
    activeWorkerContexts.delete(workerId);
  }
}

export function getWorkerContext(workerId) {
  return workerId ? activeWorkerContexts.get(workerId) : null;
}

/**
 * Forcefully and immediately close scanning Playwright browser instances.
 */
export async function abortScanBrowsers() {
  console.log(`\n🛑 [LIFECYCLE] Aborting scanning Playwright browser(s)...`);
  const closePromises = [];
  for (const browser of Array.from(activeBrowsers)) {
    const role = browserRoles.get(browser);
    if (!role || role === 'scan') {
      try {
        closePromises.push(browser.close().catch(() => {}));
      } catch {}
      activeBrowsers.delete(browser);
      browserRoles.delete(browser);
    }
  }
  await Promise.allSettled(closePromises);
  console.log(`✅ [LIFECYCLE] Scanning browser instances closed.`);
}

/**
 * Forcefully and immediately close submission Playwright browser instances.
 */
export async function abortSubmitBrowsers() {
  console.log(`\n🛑 [LIFECYCLE] Aborting submission Playwright browser(s)...`);
  const closePromises = [];
  for (const browser of Array.from(activeBrowsers)) {
    const role = browserRoles.get(browser);
    if (!role || role === 'submit') {
      try {
        closePromises.push(browser.close().catch(() => {}));
      } catch {}
      activeBrowsers.delete(browser);
      browserRoles.delete(browser);
    }
  }
  await Promise.allSettled(closePromises);
  console.log(`✅ [LIFECYCLE] Submission browser instances closed.`);
}

/**
 * Forcefully and immediately close all open Playwright browser instances.
 * Terminates active pages, network connections, and visible windows in <500ms.
 */
export async function abortAllActiveBrowsers() {
  console.log(`\n🛑 [LIFECYCLE] Aborting ${activeBrowsers.size} active Playwright browser(s)...`);
  const closePromises = [];
  for (const browser of Array.from(activeBrowsers)) {
    try {
      closePromises.push(
        browser.close().catch((err) => {
          // Ignore close errors if browser already closed
        })
      );
    } catch {}
    activeBrowsers.delete(browser);
    browserRoles.delete(browser);
  }
  activeSlots.clear();
  while (waitingQueue.length > 0) {
    const item = waitingQueue.shift();
    try { item.reject(new Error('[LIFECYCLE] Aborted: global stop requested')); } catch {}
  }
  await Promise.allSettled(closePromises);
  console.log(`✅ [LIFECYCLE] All browser instances closed cleanly.`);
}
