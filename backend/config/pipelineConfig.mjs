/**
 * pipelineConfig.mjs — 2-Worker Per Service Canonical Pipeline Configuration
 *
 * Configures strictly 2 dedicated workers per service:
 * - Scanning/Resolving: scanning_worker_1, scanning_worker_2
 * - Resolving: resolving_worker_1, resolving_worker_2
 * - Submitting: submitting_worker_1, submitting_worker_2
 */

export const WORKER_COUNT = Number(process.env.WORKER_COUNT) || 2;
export const WORKER_OFFSET = Number(process.env.WORKER_OFFSET) || 0;

// Dynamic worker counts per stage across all services (default: 2 services * WORKER_COUNT)
export const TOTAL_SERVICES = Number(process.env.TOTAL_SERVICES) || 2;
export const TOTAL_SCAN_WORKERS = Number(process.env.TOTAL_SCAN_WORKERS) || (WORKER_COUNT * TOTAL_SERVICES);
export const TOTAL_RESOLVE_WORKERS = Number(process.env.TOTAL_RESOLVE_WORKERS) || (WORKER_COUNT * TOTAL_SERVICES);
export const TOTAL_SUBMIT_WORKERS = Number(process.env.TOTAL_SUBMIT_WORKERS) || (WORKER_COUNT * TOTAL_SERVICES);

export const SCAN_WORKER_IDS = process.env.SCAN_WORKER_IDS
  ? process.env.SCAN_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : Array.from({ length: WORKER_COUNT }, (_, i) => `scanning_worker_${i + 1 + WORKER_OFFSET}`);

export const RESOLVE_WORKER_IDS = process.env.RESOLVE_WORKER_IDS
  ? process.env.RESOLVE_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : Array.from({ length: WORKER_COUNT }, (_, i) => `resolving_worker_${i + 1 + WORKER_OFFSET}`);

export const SUBMIT_WORKER_IDS = process.env.SUBMISSION_WORKER_IDS
  ? process.env.SUBMISSION_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : (process.env.SUBMIT_WORKER_IDS
      ? process.env.SUBMIT_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.from({ length: WORKER_COUNT }, (_, i) => `submitting_worker_${i + 1 + WORKER_OFFSET}`));

export const ALL_CANONICAL_SCAN_IDS = Array.from({ length: TOTAL_SCAN_WORKERS }, (_, i) => `scanning_worker_${i + 1}`);
export const ALL_CANONICAL_RESOLVE_IDS = Array.from({ length: TOTAL_RESOLVE_WORKERS }, (_, i) => `resolving_worker_${i + 1}`);
export const ALL_CANONICAL_SUBMIT_IDS = Array.from({ length: TOTAL_SUBMIT_WORKERS }, (_, i) => `submitting_worker_${i + 1}`);

const ALL_CANONICAL_WORKERS = [...new Set([
  ...ALL_CANONICAL_SCAN_IDS,
  ...ALL_CANONICAL_RESOLVE_IDS,
  ...ALL_CANONICAL_SUBMIT_IDS,
  ...SCAN_WORKER_IDS,
  ...RESOLVE_WORKER_IDS,
  ...SUBMIT_WORKER_IDS,
])];

const WORKER_NAMES = {};
SCAN_WORKER_IDS.forEach((id) => { const n = (id.match(/\d+/) || [1])[0]; WORKER_NAMES[id] = `Scanning Worker ${n}`; });
RESOLVE_WORKER_IDS.forEach((id) => { const n = (id.match(/\d+/) || [1])[0]; WORKER_NAMES[id] = `Resolving Worker ${n}`; });
SUBMIT_WORKER_IDS.forEach((id) => { const n = (id.match(/\d+/) || [1])[0]; WORKER_NAMES[id] = `Submitting Worker ${n}`; });

export const PIPELINE_CONFIG = {
  stages: {
    SCANNING: 'scanning',
    RESOLVING: 'resolving',
    READY_FOR_REVIEW: 'ready_for_review',
    SUBMITTING: 'submitting',
    IDLE: 'idle',
  },

  workersCount: WORKER_COUNT,

  scanWorkerIds: SCAN_WORKER_IDS,
  resolveWorkerIds: RESOLVE_WORKER_IDS,
  submitWorkerIds: SUBMIT_WORKER_IDS,

  workerNames: WORKER_NAMES,
  allWorkerIds: ALL_CANONICAL_WORKERS,

  webhookPort: Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || 8080,
  headless: process.env.HEADLESS !== 'false',
};
