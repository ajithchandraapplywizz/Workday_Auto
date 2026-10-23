/**
 * pipelineConfig.mjs — Dynamic Parallel Autonomous Pipeline Configuration
 *
 * Configures workers dynamically from .env:
 * - WORKER_COUNT / WORKERS_COUNT: Global worker count (default: 2)
 * - SCAN_WORKER_COUNT: Optional override for scanning workers
 * - RESOLVE_WORKER_COUNT: Optional override for resolving workers
 * - SUBMIT_WORKER_COUNT: Optional override for submitting workers
 *
 * Database worker_status table dynamically syncs with these worker IDs.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// Quick env loader for standalone imports
function loadLocalEnvQuick() {
  if (process.env.WORKER_COUNT || process.env.WORKERS_COUNT) return;
  const envCandidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'backend', '.env'),
  ];
  for (const p of envCandidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf-8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const idx = trimmed.indexOf('=');
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = val;
          }
        }
      } catch {}
      break;
    }
  }
}
loadLocalEnvQuick();

const envWorkers = parseInt(
  process.env.WORKER_COUNT ||
  process.env.WORKERS_COUNT ||
  process.env.PIPELINE_WORKER_COUNT ||
  '2',
  10
) || 2;

const scanCount = parseInt(process.env.SCAN_WORKER_COUNT || String(envWorkers), 10) || envWorkers;
const resolveCount = parseInt(process.env.RESOLVE_WORKER_COUNT || String(envWorkers), 10) || envWorkers;
const submitCount = parseInt(process.env.SUBMIT_WORKER_COUNT || String(envWorkers), 10) || envWorkers;

const scanWorkerIds = Array.from({ length: scanCount }, (_, i) => `scanning_worker_${i + 1}`);
const resolveWorkerIds = Array.from({ length: resolveCount }, (_, i) => `resolving_worker_${i + 1}`);
const submitWorkerIds = Array.from({ length: submitCount }, (_, i) => `submitting_worker_${i + 1}`);

const workerNames = {};
scanWorkerIds.forEach((id, i) => { workerNames[id] = `Scanning Worker ${i + 1}`; });
resolveWorkerIds.forEach((id, i) => { workerNames[id] = `Resolving Worker ${i + 1}`; });
submitWorkerIds.forEach((id, i) => { workerNames[id] = `Submitting Worker ${i + 1}`; });

export const PIPELINE_CONFIG = {
  stages: {
    SCANNING: 'scanning',
    RESOLVING: 'resolving',
    READY_FOR_REVIEW: 'ready_for_review',
    SUBMITTING: 'submitting',
    IDLE: 'idle',
  },

  workersCount: envWorkers,
  scanCount,
  resolveCount,
  submitCount,

  scanWorkerIds,
  resolveWorkerIds,
  submitWorkerIds,
  workerNames,

  allWorkerIds: [...new Set([...scanWorkerIds, ...resolveWorkerIds, ...submitWorkerIds])],

  webhookPort: Number(process.env.DAEMON_PORT) || 3001,
  headless: process.env.HEADLESS !== 'false',
};

export const WORKER_COUNT = PIPELINE_CONFIG.workersCount;
