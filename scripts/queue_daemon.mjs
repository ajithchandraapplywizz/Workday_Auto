/**
 * Universal root forwarder: scripts/queue_daemon.mjs -> backend/scripts/queue_daemon.mjs
 * Ensures commands like `node scripts/queue_daemon.mjs` succeed in all container environments.
 */

export * from '../backend/scripts/queue_daemon.mjs';
import '../backend/scripts/queue_daemon.mjs';
