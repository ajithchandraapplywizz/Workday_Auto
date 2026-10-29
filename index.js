/**
 * Workday Auto-Apply — Railway / Railpack Production Entry Point
 * ==============================================================
 * Automatically executed by Railway / Railpack on container startup.
 * Runs the autonomous 3-worker background queue daemon.
 */

import fs from 'node:fs';

const daemonPath = fs.existsSync(new URL('./backend/scripts/queue_daemon.mjs', import.meta.url))
  ? './backend/scripts/queue_daemon.mjs'
  : './scripts/queue_daemon.mjs';

const { initOnStartup } = await import(daemonPath);

if (typeof initOnStartup === 'function') {
  initOnStartup().catch((err) => {
    console.error('[RAILWAY FATAL] Failed to initialize queue daemon:', err);
    process.exit(1);
  });
}

