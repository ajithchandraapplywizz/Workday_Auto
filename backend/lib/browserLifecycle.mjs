import { exec } from 'node:child_process';

if (!process.env.MALLOC_ARENA_MAX) process.env.MALLOC_ARENA_MAX = '2';
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';

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
      exec('pkill -9 -f "crashpad_handler" || pkill -9 -f "chrome-headless-shell" || pkill -9 -f "chromium" || pkill -9 -f "chrome" || true', () => {});
      exec('rm -rf /tmp/playwright_* /tmp/core.* || true', () => {});
    } catch {}
  }
}

let lastDeepCleanTime = 0;

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

  const now = Date.now();
  // Throttle to at most once every 10 seconds unless forced
  if (!force && now - lastDeepCleanTime < 10000) {
    return false;
  }
  lastDeepCleanTime = now;

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
 * Defaults to 2 active browsers per service container (or WORKER_COUNT from env)
 * to allow both dedicated submitting workers in each service (e.g. submitting_worker_1 & 2 on Service 1,
 * and submitting_worker_3 & 4 on Service 2) to execute applications concurrently.
 */
export function getDynamicMaxBrowsers() {
  const envExplicit = Number(process.env.MAX_ACTIVE_BROWSERS);
  if (Number.isFinite(envExplicit) && envExplicit > 0) return Math.floor(envExplicit);

  const envWorkers = Number(process.env.SUBMIT_WORKER_COUNT) ||
    Number(process.env.SUBMIT_WORKERS) ||
    Number(process.env.SUBMISSION_WORKER_COUNT) ||
    Number(process.env.WORKER_COUNT) ||
    Number(process.env.WORKERS_COUNT) ||
    Number(process.env.WORKERS) ||
    Number(process.env.MAX_WORKERS);

  if (Number.isFinite(envWorkers) && envWorkers > 0) {
    return Math.floor(envWorkers);
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
    : getDynamicMaxBrowsers();

  if (activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax) {
    activeSlots.add(workerId);
    return true;
  }

  console.log(`⏳ [SLOT GUARD] ${workerId} waiting for active browser slot in this service (${activeBrowsers.size}/${effectiveMax} active, queue depth: ${waitingQueue.length + 1})...`);

  return new Promise((resolve, reject) => {
    let checkTimer = null;
    const cleanup = () => {
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
    };
    const queueItem = { workerId, resolve, reject, cleanup };
    waitingQueue.push(queueItem);

    // Rapid check (30ms) to unblock immediately when a slot frees up or on stop signals
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
        console.log(`🔓 [SLOT GUARD] ${workerId} acquired browser slot immediately (${activeBrowsers.size + 1}/${effectiveMax})`);
        resolve(true);
      }
    }, 30);

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
  const effectiveMax = getDynamicMaxBrowsers();
  while (waitingQueue.length > 0 && activeBrowsers.size < effectiveMax && activeSlots.size < effectiveMax) {
    const next = waitingQueue.shift();
    if (next) {
      if (typeof next.cleanup === 'function') {
        next.cleanup();
      }
      activeSlots.add(next.workerId);
      console.log(`🔓 [SLOT GUARD] Browser slot released. Handing immediately to waiting worker: ${next.workerId} (${activeSlots.size}/${effectiveMax} active)`);
      if (typeof next.resolve === 'function') {
        next.resolve(true);
      }
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
