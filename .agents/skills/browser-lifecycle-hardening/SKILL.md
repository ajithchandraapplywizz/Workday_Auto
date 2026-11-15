---
name: browser-lifecycle-hardening
description: >-
  Hardens Playwright browser lifecycles, memory limits, and process concurrency for Workday automation.
  Prevents Linux pthread_create (11) resource exhaustion in Railway/Docker containers, enforces MAX_ACTIVE_BROWSERS=1
  per container, guarantees orphan Chrome process reaping without killing active sibling worker browsers,
  and manages stealth browser flags. Activate when debugging browser crashes, memory leaks, timeouts, or worker pool issues.
---

# Browser Lifecycle & Process Hardening

This skill establishes the production protocols for launching, controlling, and cleanly terminating Playwright Chromium instances across local Windows and Linux container environments (Railway/Docker).

---

## 1. Single Browser Cap & Linux `pthread_create (11)` Prevention

### The Problem
In Linux container environments with cgroup memory and PID limits, launching multiple concurrent headless Chromium instances spawns hundreds of OS threads, triggering:
`pthread_create: Resource temporarily unavailable (errno 11)`
This crashes the container and forces platform restarts.

### The Standard
- **Strict Single-Browser Limit**:
  - `MAX_ACTIVE_BROWSERS = 1` per Railway container.
  - Workers acquire a mutex/slot lease before launching Chromium.
  - Scale concurrency horizontally across multiple container replicas (e.g. `Submitting_1`, `Submitting_2`) rather than vertically inside a single container.

---

## 2. Safe Zombie Process Cleanup

### The Anti-Pattern
Blindly executing `pkill -9 -f "chromium"` or `killall chrome` reaps active browser instances from other workers sharing the machine or container, causing:
`Target page, context or browser has been closed`!

### The Protected Reaping Protocol
In `backend/lib/browserLifecycle.mjs`:
```javascript
export async function cleanupOrphanChromeProcesses() {
  // STRICT GUARD: If any active browser context is running, abort cleanup
  if (activeBrowsers.size > 0 || activeSlots.size > 0 || activeWorkerContexts.size > 0) {
    logger.debug('Active browser sessions exist; skipping orphan cleanup to avoid killing live work.');
    return;
  }

  // Safe to reap only when 0 active sessions are registered
  if (process.platform === 'win32') {
    // Windows: taskkill only when idle
  } else {
    // Linux: pkill -f chromium only when idle
  }
}
```

---

## 3. Stealth Browser Configuration

Workday detects automated bots through `navigator.webdriver`, headless user-agent tokens, and missing WebGL bindings.

Always launch using `stealthBrowser.mjs`:
```javascript
const browser = await chromium.launch({
  headless: process.env.HEADLESS !== 'false',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1920,1080',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
});
```

---

## 4. Graceful Teardown Checklist

On job completion, timeout, or failure:
1. Stream in-memory audit screenshot to Supabase Storage bucket (`submitted-applications` or `failed-applications`).
2. Close page: `await page.close().catch(() => {})`.
3. Close context: `await context.close().catch(() => {})`.
4. Close browser: `await browser.close().catch(() => {})`.
5. Release worker lease / slot mutex: `activeBrowsers.delete(slotId)`.
6. Only run orphan cleanup if `activeBrowsers.size === 0`.
