/**
 * browserLifecycle.mjs — Global Playwright Browser Registry & Instant Abort Controller
 *
 * Tracks all active Chromium browser and context instances across all workers.
 * When Stop is requested, immediately closes all browsers and cancels active execution loops.
 */

const activeBrowsers = new Set();
let globalStopRequested = false;
let scanStopRequested = false;
let submitStopRequested = false;

export function setGlobalStop(val) {
  globalStopRequested = Boolean(val);
  if (globalStopRequested) {
    abortAllActiveBrowsers();
  }
}

export function isGlobalStopRequested() {
  return globalStopRequested;
}

export function setScanStop(val) {
  scanStopRequested = Boolean(val);
  if (scanStopRequested) {
    abortAllActiveBrowsers();
  }
}

export function isScanStopRequested() {
  return scanStopRequested;
}

export function setSubmitStop(val) {
  submitStopRequested = Boolean(val);
  if (submitStopRequested) {
    abortAllActiveBrowsers();
  }
}

export function isSubmitStopRequested() {
  return submitStopRequested;
}

export function registerActiveBrowser(browser) {
  if (browser) {
    activeBrowsers.add(browser);
  }
}

export function unregisterActiveBrowser(browser) {
  if (browser) {
    activeBrowsers.delete(browser);
  }
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
 * Forcefully and immediately close all open Playwright browser instances and contexts.
 * Terminates active pages, network connections, and visible windows in <500ms.
 */
export async function abortAllActiveBrowsers() {
  const browserCount = activeBrowsers.size;
  const ctxCount = activeWorkerContexts.size;
  console.log(`\n🛑 [LIFECYCLE] Hard-Aborting ${browserCount} active Playwright browser(s) and ${ctxCount} worker context(s)...`);

  // 1. Immediately close registered worker contexts and pages
  for (const [wId, ctx] of Array.from(activeWorkerContexts.entries())) {
    try {
      if (ctx.page && !ctx.page.isClosed()) {
        ctx.page.close().catch(() => {});
      }
      if (ctx.context) {
        ctx.context.close().catch(() => {});
      }
      if (ctx.browser && ctx.browser.isConnected()) {
        ctx.browser.close().catch(() => {});
      }
    } catch {}
    activeWorkerContexts.delete(wId);
  }

  // 2. Immediately close all registered browser instances
  const closePromises = [];
  for (const browser of Array.from(activeBrowsers)) {
    try {
      if (browser) {
        // Close all open contexts inside browser first
        const contexts = browser.contexts?.() || [];
        for (const c of contexts) {
          c.close().catch(() => {});
        }
        closePromises.push(
          browser.close().catch(() => {})
        );
      }
    } catch {}
    activeBrowsers.delete(browser);
  }
  await Promise.allSettled(closePromises);
  console.log(`✅ [LIFECYCLE] All browser instances and contexts destroyed.`);
}
