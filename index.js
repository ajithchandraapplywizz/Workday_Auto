/**
 * Workday Auto-Apply — Railway / Railpack Production Entry Point
 * ==============================================================
 * Automatically executed by Railway / Railpack on container startup.
 * Runs the autonomous 3-worker background queue daemon.
 */

import { initOnStartup } from './backend/scripts/queue_daemon.mjs';

if (typeof initOnStartup === 'function') {
  initOnStartup().catch((err) => {
    console.error('[RAILWAY FATAL] Failed to initialize queue daemon:', err);
    process.exit(1);
  });
}

