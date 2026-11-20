/**
 * envConfig.mjs — Centralized Runtime Environment & Configuration Manager
 * =======================================================================
 * Governs environment detection, cascading .env / .env.development loading,
 * and execution isolation between Railway Production and Local Development.
 *
 * Architecture Invariants:
 * 1. Railway Production is Immutable:
 *    - In Railway (or NODE_ENV=production), environment variables supplied by Railway
 *      are supreme. .env.development is NEVER loaded in production.
 * 2. Local Development Isolation:
 *    - In local development, .env is loaded first, then overlaid by .env.development.
 *    - Allows running local workers without manually editing source code.
 *    - Prevents local daemon from accidentally consuming cloud tasks or intercepting
 *      production Supabase bot_control signals (via AUTO_START_ON_BOOT & IGNORE_CLOUD_SIGNALS).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

let envLoaded = false;

/**
 * Returns true if executing in Railway cloud or production container.
 */
export function isProduction() {
  return Boolean(
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_STATIC_URL ||
    process.env.RAILWAY_PROJECT_ID
  );
}

/**
 * Returns true if executing locally.
 */
export function isDevelopment() {
  return !isProduction();
}

/**
 * Returns true if running on Windows.
 */
export function isWindows() {
  return process.platform === 'win32';
}

/**
 * Simple key=value parser for .env files.
 */
function parseEnvContent(filePath) {
  if (!existsSync(filePath)) return {};
  const entries = {};
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let val = match[2].trim();
      val = val.replace(/^['"](.*)['"]$/, '$1');
      entries[key] = val;
    }
  } catch (err) {
    console.warn(`[ENV] Warning: Failed to parse ${filePath}: ${err.message}`);
  }
  return entries;
}

/**
 * Loads environment variables according to execution context.
 * In production: Strictly preserves Railway process.env.
 * In development: Loads .env, then overlays .env.development.
 */
export function loadEnvConfiguration({ forceReload = false } = {}) {
  if (envLoaded && !forceReload) return;
  envLoaded = true;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(currentDir, '..', '..');

  // If already running in Railway production, do not load development files
  if (isProduction()) {
    // Railway injects secrets directly into process.env.
    // If a base .env exists on disk (e.g. in container build), apply only unset keys.
    const prodEnvPath = resolve(projectRoot, '.env');
    if (existsSync(prodEnvPath)) {
      const prodEntries = parseEnvContent(prodEnvPath);
      for (const [key, val] of Object.entries(prodEntries)) {
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
    return;
  }

  // --- Local Development Environment Loading ---
  // 1. Load base .env first (if present) without overwriting pre-set process.env variables
  const baseEnvPath = resolve(projectRoot, '.env');
  if (existsSync(baseEnvPath)) {
    const baseEntries = parseEnvContent(baseEnvPath);
    for (const [key, val] of Object.entries(baseEntries)) {
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }

  // 2. Load .env.development and overlay local development preferences
  const devEnvPath = resolve(projectRoot, '.env.development');
  if (existsSync(devEnvPath)) {
    const devEntries = parseEnvContent(devEnvPath);
    for (const [key, val] of Object.entries(devEntries)) {
      // In local dev, .env.development takes precedence over base .env
      process.env[key] = val;
    }
  }

  // Ensure default fallbacks for local development
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
  }
}

/**
 * Determines whether workers (browser automation, scanning, submitting) are permitted to run.
 * Production: Always permitted (true).
 * Local Development: Permitted if RUN_LOCAL_WORKERS === 'true' or CLI flag --run-local-workers passed.
 */
export function canExecuteWorkers(cliArgs = []) {
  if (isProduction()) return true;

  if (process.env.RUN_LOCAL_WORKERS === 'true') {
    return true;
  }

  const combinedArgs = Array.isArray(cliArgs) ? cliArgs : [];
  if (combinedArgs.includes('--run-local-workers') || process.argv.includes('--run-local-workers')) {
    return true;
  }

  return false;
}

/**
 * Returns whether submitter / scanner should automatically start consuming tasks on startup.
 * Production: Always true (container starts immediately).
 * Local Development: Configurable via AUTO_START_ON_BOOT in .env.development (default: false).
 */
export function shouldAutoStartOnBoot() {
  return process.env.AUTO_START_ON_BOOT === 'true';
}

/**
 * Returns whether local daemon should ignore remote Supabase bot_control signals.
 * Production: Always false (Railway containers must respond to signals).
 * Local Development: Defaults to false so dashboard triggers work locally,
 * unless explicitly set to 'true' via IGNORE_CLOUD_SIGNALS.
 */
export function shouldIgnoreCloudSignals() {
  if (isProduction()) return false;
  return process.env.IGNORE_CLOUD_SIGNALS === 'true';
}

/**
 * Returns headless browser setting.
 * Production: Strictly true.
 * Local Development: Defaults to process.env.HEADLESS !== 'false'.
 */
export function isHeadless(cliArgs = []) {
  if (isProduction()) return true;

  const args = Array.isArray(cliArgs) ? cliArgs : process.argv;
  if (args.includes('--headful') || args.includes('--headed')) {
    return false;
  }

  if (process.env.HEADLESS === 'false') {
    return false;
  }

  return true;
}

/**
 * Returns max active browsers for current platform and environment.
 * Railway/Linux: Strictly 1 (prevents pthread_create / cgroup exhaustion).
 * Local Windows: Dynamically references MAX_ACTIVE_BROWSERS or WORKER_COUNT (defaults to 2).
 */
export function getMaxActiveBrowsers() {
  if (process.platform === 'linux') {
    return 1;
  }

  const envExplicit = Number(process.env.MAX_ACTIVE_BROWSERS);
  if (Number.isFinite(envExplicit) && envExplicit > 0) {
    return Math.floor(envExplicit);
  }

  const workerCount = Number(process.env.WORKER_COUNT) ||
    Number(process.env.WORKERS_COUNT) ||
    Number(process.env.SUBMIT_WORKER_COUNT) ||
    Number(process.env.SCAN_WORKER_COUNT);

  if (Number.isFinite(workerCount) && workerCount > 0) {
    return Math.floor(workerCount);
  }

  return 2;
}

// Auto-initialize on import
loadEnvConfiguration();
