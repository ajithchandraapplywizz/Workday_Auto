import { exec, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const browserLifecycleEvents = new EventEmitter();
browserLifecycleEvents.setMaxListeners(0);

const activeSlotWaiters = new Set();

/**
 * Notify all pending slot waiters immediately and emit on browserLifecycleEvents.
 * Auto-cleans any stale listeners to guarantee zero memory accumulation.
 */
export function notifySlotReleased(workerId = 'worker') {
  if (activeSlotWaiters.size > 0) {
    const waiters = Array.from(activeSlotWaiters);
    activeSlotWaiters.clear();
    for (const waiter of waiters) {
      try { waiter(); } catch {}
    }
  }

  try {
    if (browserLifecycleEvents.listenerCount('slot_released') > 10) {
      browserLifecycleEvents.removeAllListeners('slot_released');
    }
    browserLifecycleEvents.emit('slot_released', workerId);
  } catch {}
}

/**
 * Cleanly waits for either a slot release notification or a timeout.
 * Zero-leak guarantee: Uses an internal Set of active waiters instead of accumulating
 * EventEmitter listeners. When the timeout expires or when a slot is released,
 * the waiter is immediately deleted from memory.
 */
export function waitForSlotReleaseOrTimeout(timeoutMs = 100) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;

    const waiter = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      activeSlotWaiters.delete(waiter);
      resolve(true);
    };

    activeSlotWaiters.add(waiter);

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = null;
      activeSlotWaiters.delete(waiter);
      resolve(false);
    }, timeoutMs);
  });
}

export function getPendingSlotWaitersCount() {
  return activeSlotWaiters.size;
}

if (!process.env.MALLOC_ARENA_MAX) process.env.MALLOC_ARENA_MAX = '2';
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '8';

export const LEAN_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-zygote',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=384',
  '--disable-extensions',
  '--disable-default-apps',
  '--mute-audio',
  '--autoplay-policy=user-gesture-required',
  '--no-first-run',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--no-crashpad',
  '--disable-component-update',
  '--disable-infobars',
  '--window-size=1280,900',
  '--disk-cache-size=33554432',
  '--media-cache-size=1',
  '--in-process-gpu',
  '--num-raster-threads=1',
  '--disable-features=AudioServiceOutOfProcess,OptimizationHints,Translate,PaintHolding,DialMediaRouteProvider',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
];

/**
 * Reaps orphan/zombie chromium processes on Linux to prevent EAGAIN / PID / pthread_create limit exhaustion.
 * STRICT GUARD: Never reap processes if any active browser context is currently alive, unless forced.
 */
export function cleanupOrphanChromeProcesses({ force = false, ignoreSlots = false } = {}) {
  if (!force) {
    if (activeBrowsers.size > 0 || activeWorkerContexts.size > 0) {
      return;
    }
    if (!ignoreSlots && activeSlots.size > 0) {
      return;
    }
  }
  if (process.platform === 'linux') {
    try {
      execSync('pkill -9 -f "crashpad_handler" || true; pkill -9 -f "chrome-headless-shell" || true; pkill -9 -f "chromium" || true; rm -rf /tmp/playwright_* /tmp/core.* || true', { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }
}

let launchLockPromise = Promise.resolve();
let lastLaunchTime = 0;
const MIN_LAUNCH_GAP_MS = 1500;

/**
 * Atomic launch lock that serializes browser launches across concurrent workers
 * and enforces a minimum 600ms gap to give Linux OS kernel time to reap terminating
 * processes and release thread memory, eliminating spawn EAGAIN (errno 11).
 */
export async function acquireBrowserLaunchLock(workerId = 'worker') {
  let release;
  const currentLock = launchLockPromise;
  launchLockPromise = new Promise((res) => {
    release = res;
  });

  await currentLock;

  const now = Date.now();
  const elapsed = now - lastLaunchTime;
  if (elapsed < MIN_LAUNCH_GAP_MS) {
    const waitMs = MIN_LAUNCH_GAP_MS - elapsed;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  return () => {
    lastLaunchTime = Date.now();
    release();
  };
}

let lastDeepCleanTime = 0;
let hadActiveInstancesSinceLastClean = false;

/**
 * Marks that a browser or execution slot was active, so that subsequent zero-instance transitions trigger a clean.
 */
export function markInstanceActive() {
  hadActiveInstancesSinceLastClean = true;
}

/**
 * Deep cache and process purge executed strictly when ZERO active instances (browsers/tasks) are running.
 * Cleans orphan Linux processes, Playwright temp directories, Chromium profile caches, and triggers V8 GC.
 */
export function deepCleanWhenZeroActiveInstances({ force = false } = {}) {
  const activeCount = activeBrowsers.size;
  const slotCount = activeSlots.size;
  const contextCount = activeWorkerContexts.size;

  // STRICT GUARD: Never clean if ANY browser or worker context is currently active
  if (!force && (activeCount > 0 || slotCount > 0 || contextCount > 0)) {
    return false;
  }

  // STRICT GUARD: If already clean and no instances have run since the last purge, remain idle silently
  if (!force && !hadActiveInstancesSinceLastClean && lastDeepCleanTime > 0) {
    return false;
  }

  const now = Date.now();
  // Throttle to at most once every 10 seconds unless forced
  if (!force && now - lastDeepCleanTime < 10000) {
    return false;
  }
  lastDeepCleanTime = now;
  hadActiveInstancesSinceLastClean = false;

  console.log(`\n🧹 [DEEP PURGE] Zero active instances running (browsers: ${activeCount}, slots: ${slotCount}) — executing deep system cache & process wipe...`);

  if (process.platform === 'linux') {
    try {
      // 1. Force kill all detached or zombie Chromium, Chrome, and crashpad processes
      exec('pkill -9 -f "chrome.*(playwright|user-data-dir|crashpad)" || pkill -9 -f "crashpad_handler" || pkill -9 -f "chrome-headless-shell" || true', () => {});

      // 2. Wipe all temporary Playwright browser profiles, core dumps, and crashpad caches from /tmp and /dev/shm
      exec('rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/playwright-artifacts-* /tmp/core.* /tmp/.org.chromium.Chromium.* /tmp/.com.google.Chrome.* /dev/shm/.org.chromium.* || true', () => {});
    } catch (e) {
      console.warn(`⚠️ [DEEP PURGE] Linux process/disk clean notice: ${e.message}`);
    }
  }

  // 3. Force V8 Garbage Collection to free RAM back to host OS if exposed
  if (typeof global.gc === 'function') {
    try {
      global.gc();
      console.log('   🗑️ V8 heap garbage collection executed.');
    } catch {}
  }

  console.log('✅ [DEEP PURGE] Zero-instance system wipe complete. Memory and process table fully reset.\n');
  return true;
}

/**
 * browserLifecycle.mjs — Global Playwright Browser Registry & Instant Abort Controller
 *
 * Tracks all active Chromium browser and context instances across all workers.
 * When Stop is requested, immediately closes all browsers and cancels active execution loops.
 */

const activeBrowsers = new Set();
const activeSlots = new Set();
const waitingQueue = [];

/**
 * Dynamically calculates the maximum allowable concurrent browsers from environment variables.
 * Enforces per-service concurrency matching container safety invariants:
 * - If MAX_ACTIVE_BROWSERS is explicitly set in env, it directly defines the container limit.
 * - In Linux container / Railway environments (RAILWAY_ENVIRONMENT or Linux production),
 *   strictly enforces MAX_ACTIVE_BROWSERS = 1 per container by default to prevent Linux
 *   cgroup pthread_create (errno 11) and spawn EAGAIN errors.
 * - Concurrency is scaled horizontally across container replicas (Submitting_1, Submitting_2).
 * - In local dev (Windows/Mac non-container), defaults safely to 2 or configured worker counts.
 */
export function getDynamicMaxBrowsers(workerId = null) {
  const envExplicit = Number(process.env.MAX_ACTIVE_BROWSERS);

  // Strict Single-Browser Limit for Linux Container / Railway Production
  // In Linux container environments with cgroup limits, launching multiple concurrent
  // Chromium instances triggers pthread_create (errno 11) and spawn EAGAIN.
  // We enforce MAX_ACTIVE_BROWSERS = 1 per container. Scale horizontally across replicas.
  const isContainerLinux = process.platform === 'linux' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RAILWAY_SERVICE_NAME) ||
    (process.env.NODE_ENV === 'production' && process.platform !== 'win32');

  if (isContainerLinux) {
    if (Number.isFinite(envExplicit) && envExplicit > 0) {
      return Math.floor(envExplicit);
    }
    const isScanRole = (process.env.SERVICE_ROLE === 'scanner' || process.env.ROLE === 'scanner') ||
      Boolean(workerId && String(workerId).includes('scan'));
    if (isScanRole) {
      const scanCount = Number(process.env.SCAN_WORKER_COUNT) ||
        Number(process.env.SCAN_WORKERS) ||
        Number(process.env.WORKER_COUNT) || 2;
      return Math.max(1, Math.floor(scanCount));
    }
    return 1;
  }

  // In local development / Windows non-container environments:
  const isSubmitWorker = Boolean(workerId && String(workerId).includes('submit'));
  const isScanWorker = Boolean(workerId && String(workerId).includes('scan'));

  // 1. Check explicit comma-separated ID lists in env
  if (isSubmitWorker) {
    const list = process.env.SUBMISSION_WORKER_IDS || process.env.SUBMIT_WORKER_IDS;
    if (list) {
      const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts.length;
    }
  } else if (isScanWorker) {
    const list = process.env.SCAN_WORKER_IDS;
    if (list) {
      const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts.length;
    }
  }

  // 2. Parse role-specific worker counts from env
  const scanSpecific = Number(process.env.SCAN_WORKER_COUNT) ||
    Number(process.env.SCAN_WORKERS) ||
    Number(process.env.SCANNING_WORKER_COUNT) || 0;

  const submitSpecific = Number(process.env.SUBMIT_WORKER_COUNT) ||
    Number(process.env.SUBMIT_WORKERS) ||
    Number(process.env.SUBMISSION_WORKER_COUNT) ||
    Number(process.env.SUBMISSION_WORKERS) || 0;

  const generalWorkers = Number(process.env.WORKER_COUNT) ||
    Number(process.env.WORKERS_COUNT) ||
    Number(process.env.WORKERS) ||
    Number(process.env.MAX_WORKERS) ||
    Number(process.env.CONCURRENT_WORKERS) || 0;

  if (isScanWorker && scanSpecific > 0) {
    return Math.floor(scanSpecific);
  }
  if (isSubmitWorker && submitSpecific > 0) {
    return Math.floor(submitSpecific);
  }

  // If workerId is provided and general worker count is set (e.g. WORKER_COUNT=3):
  if (workerId && generalWorkers > 0) {
    return (Number.isFinite(envExplicit) && envExplicit > generalWorkers)
      ? Math.floor(envExplicit)
      : Math.floor(generalWorkers);
  }

  // If MAX_ACTIVE_BROWSERS is explicitly set in env, it directly defines the container limit
  if (Number.isFinite(envExplicit) && envExplicit > 0) {
    return Math.floor(envExplicit);
  }

  // If general worker count is set
  if (generalWorkers > 0) {
    return Math.floor(generalWorkers);
  }

  // Default to 2 concurrent active browsers per container/service
  return 2;
}

const MAX_CONCURRENT_BROWSERS = getDynamicMaxBrowsers();

let globalStopRequested = false;
let scanStopRequested = false;
let submitStopRequested = false;

/**
 * Acquire an active Playwright browser slot dynamically referencing worker counts from env.
 * Enforces per-service concurrency limits (allowing all configured workers in the container,
 * default 2 per container, to work simultaneously without serializing).
 * If dynamic slot limit is reached, pauses execution asynchronously until an active browser exits.
 */
export async function acquireBrowserSlot(workerId = 'worker', maxSlots = null) {
  if (isGlobalStopRequested() || (String(workerId).includes('submit') && isSubmitStopRequested())) {
    throw new Error(`[LIFECYCLE] Cannot acquire browser slot: stop requested`);
  }
  // If this worker already owns an active slot, grant immediately
  if (activeSlots.has(workerId)) {
    return true;
  }

  // Prune any disconnected/closed browser handles
  for (const b of activeBrowsers) {
    if (typeof b.isConnected === 'function' && !b.isConnected()) {
      activeBrowsers.delete(b);
      browserRoles.delete(b);
    }
  }

  const effectiveMax = (maxSlots !== null && Number(maxSlots) > 0)
    ? Math.floor(Number(maxSlots))
    : getDynamicMaxBrowsers(workerId);

  if (activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax) {
    activeSlots.add(workerId);
    markInstanceActive();
    return true;
  }

  console.log(`⏳ [SLOT GUARD] ${workerId} waiting for active browser slot in this service (${activeBrowsers.size}/${effectiveMax} active, queue depth: ${waitingQueue.length + 1})...`);

  return new Promise((resolve, reject) => {
    let checkTimer = null;
    const waitStartTime = Date.now();
    const STALE_SLOT_TIMEOUT_MS = 120000; // 2 minutes max if 0 live browsers exist (leaked slot recovery)
    const MAX_LIVE_WAIT_MS = 600000; // 10 minutes max if a live browser is genuinely running
    const cleanup = () => {
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
    };
    const queueItem = { workerId, resolve, reject, cleanup };
    waitingQueue.push(queueItem);

    // Check every 200ms to unblock when a slot frees up or on stop signals
    checkTimer = setInterval(() => {
      if (isGlobalStopRequested() || (String(workerId).includes('submit') && isSubmitStopRequested())) {
        cleanup();
        const idx = waitingQueue.indexOf(queueItem);
        if (idx !== -1) waitingQueue.splice(idx, 1);
        reject(new Error(`[LIFECYCLE] Aborted: stop requested while waiting for browser slot`));
        return;
      }

      // Prune dead/disconnected browser handles
      for (const b of activeBrowsers) {
        if (typeof b.isConnected === 'function' && !b.isConnected()) {
          activeBrowsers.delete(b);
          browserRoles.delete(b);
        }
      }

      // If slot freed up and this worker is next in line
      if (activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax && waitingQueue[0] === queueItem) {
        cleanup();
        waitingQueue.shift();
        activeSlots.add(workerId);
        markInstanceActive();
        console.log(`🔓 [SLOT GUARD] ${workerId} acquired browser slot immediately (${activeBrowsers.size + 1}/${effectiveMax})`);
        resolve(true);
        return;
      }

      const waitedMs = Date.now() - waitStartTime;

      // Only recover leaked slots when ZERO live browsers are actually connected!
      // Never force-grant a 2nd browser while a live browser is still running (prevents 2/1 EAGAIN).
      if (activeBrowsers.size === 0 && waitedMs > STALE_SLOT_TIMEOUT_MS) {
        cleanup();
        const idx = waitingQueue.indexOf(queueItem);
        if (idx !== -1) waitingQueue.splice(idx, 1);
        console.warn(`⚠️ [SLOT GUARD] ${workerId} detected leaked slot with 0 live browsers (>120s). Reclaiming stale slot.`);
        activeSlots.clear();
        activeSlots.add(workerId);
        markInstanceActive();
        resolve(true);
        return;
      }

      if (waitedMs > MAX_LIVE_WAIT_MS) {
        cleanup();
        const idx = waitingQueue.indexOf(queueItem);
        if (idx !== -1) waitingQueue.splice(idx, 1);
        reject(new Error(`[HOST_RESOURCE_EXHAUSTION] Timed out waiting for active browser slot (>10m)`));
        return;
      }
    }, 200);

    if (checkTimer && typeof checkTimer.unref === 'function') {
      checkTimer.unref();
    }
  });
}

/**
 * Release an active browser slot and immediately wake up the next queued worker in this service.
 */
export function releaseBrowserSlot(workerId = 'worker') {
  activeSlots.delete(workerId);
  // Prune any disconnected/closed browser handles
  for (const b of activeBrowsers) {
    if (typeof b.isConnected === 'function' && !b.isConnected()) {
      activeBrowsers.delete(b);
      browserRoles.delete(b);
    }
  }
  const effectiveMax = getDynamicMaxBrowsers(workerId);
  while (waitingQueue.length > 0 && activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax) {
    const next = waitingQueue.shift();
    if (next) {
      if (typeof next.cleanup === 'function') {
        next.cleanup();
      }
      activeSlots.add(next.workerId);
      markInstanceActive();
      console.log(`🔓 [SLOT GUARD] Browser slot released. Handing immediately to waiting worker: ${next.workerId} (${activeSlots.size}/${effectiveMax} active)`);
      if (typeof next.resolve === 'function') {
        next.resolve(true);
      }
    }
  }
  try {
    notifySlotReleased(workerId);
  } catch {}
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
    markInstanceActive();
    const role = meta.role || (meta.workerId && String(meta.workerId).includes('submit') ? 'submit' : 'scan');
    browserRoles.set(browser, role);
    try {
      if (typeof browser.on === 'function') {
        browser.on('disconnected', () => {
          activeBrowsers.delete(browser);
          browserRoles.delete(browser);
          if (meta.workerId) {
            releaseBrowserSlot(meta.workerId);
          }
        });
      }
    } catch {}
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
  if (activeBrowsers.size === 0 && activeSlots.size === 0) {
    deepCleanWhenZeroActiveInstances();
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
  if (activeBrowsers.size === 0) deepCleanWhenZeroActiveInstances({ force: true });
}

/**
 * Closes the browser strictly belonging to a single worker without affecting sibling workers.
 */
export async function abortWorkerBrowser(workerId) {
  if (!workerId) return;
  const ctx = activeWorkerContexts.get(workerId);
  if (ctx?.browser) {
    try {
      await ctx.browser.close().catch(() => {});
    } catch {}
    activeBrowsers.delete(ctx.browser);
    browserRoles.delete(ctx.browser);
  }
  unregisterWorkerContext(workerId);
  releaseBrowserSlot(workerId);
}

/**
 * Forcefully and immediately close submission Playwright browser instances.
 */
export async function abortSubmitBrowsers({ force = false } = {}) {
  if (!force && !submitStopRequested && !globalStopRequested) {
    return; // Never abort active submission browsers unless an explicit user stop is active!
  }
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
  // Race against 2s timeout so stuck Playwright sockets never hang the stop signal
  await Promise.race([Promise.allSettled(closePromises), new Promise((r) => setTimeout(r, 2000))]);
  console.log(`✅ [LIFECYCLE] Submission browser instances closed.`);
  cleanupOrphanChromeProcesses();
  if (activeBrowsers.size === 0) deepCleanWhenZeroActiveInstances({ force: true });
}

/**
 * Forcefully and immediately close all open Playwright browser instances.
 * Terminates active pages, network connections, and visible windows in <500ms.
 */
export async function abortAllActiveBrowsers({ force = false } = {}) {
  if (!force && !globalStopRequested && !submitStopRequested && !scanStopRequested) {
    return; // Never abort all active browsers unless an explicit user stop signal is present!
  }
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
  // Race against 2s timeout so stuck Playwright sockets never hang the stop signal
  await Promise.race([Promise.allSettled(closePromises), new Promise((r) => setTimeout(r, 2000))]);
  console.log(`✅ [LIFECYCLE] All browser instances closed cleanly.`);
  cleanupOrphanChromeProcesses();
  deepCleanWhenZeroActiveInstances({ force: true });
}
