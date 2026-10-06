/**
 * Workday Auto-Apply — Railway / Railpack Production Entry Point
 * ==============================================================
 * Automatically executed by Railway / Railpack on container startup.
 * Runs the autonomous 3-worker background queue daemon.
 */

import './backend/scripts/queue_daemon.mjs';
