/**
 * Workday Auto-Apply — Backend Entry Point
 */
import { initOnStartup } from './scripts/queue_daemon.mjs';

if (typeof initOnStartup === 'function') {
  initOnStartup().catch((err) => {
    console.error('[RAILWAY FATAL] Failed to initialize queue daemon:', err);
    process.exit(1);
  });
}
