/**
 * pipelineConfig.mjs — 9-Worker Canonical Pipeline Configuration
 *
 * Configures strictly 9 canonical workers:
 * - Scanning (3): scanning_worker_1, scanning_worker_2, scanning_worker_3
 * - Resolving (3): resolving_worker_1, resolving_worker_2, resolving_worker_3
 * - Submitting (3): submitting_worker_1, submitting_worker_2, submitting_worker_3
 *
 * Database worker_status table maintains strictly these rows.
 */

export const WORKER_COUNT = Number(process.env.WORKER_COUNT) || 3;
export const WORKER_OFFSET = Number(process.env.WORKER_OFFSET) || 0;

export const SCAN_WORKER_IDS = Array.from({ length: WORKER_COUNT }, (_, i) => `scanning_worker_${i + 1 + WORKER_OFFSET}`);
export const RESOLVE_WORKER_IDS = Array.from({ length: WORKER_COUNT }, (_, i) => `resolving_worker_${i + 1 + WORKER_OFFSET}`);
export const SUBMIT_WORKER_IDS = Array.from({ length: WORKER_COUNT }, (_, i) => `submitting_worker_${i + 1 + WORKER_OFFSET}`);

const ALL_CANONICAL_WORKERS = [...SCAN_WORKER_IDS, ...RESOLVE_WORKER_IDS, ...SUBMIT_WORKER_IDS];

const WORKER_NAMES = {};
SCAN_WORKER_IDS.forEach((id, i) => { WORKER_NAMES[id] = `Scanning Worker ${i + 1 + WORKER_OFFSET}`; });
RESOLVE_WORKER_IDS.forEach((id, i) => { WORKER_NAMES[id] = `Resolving Worker ${i + 1 + WORKER_OFFSET}`; });
SUBMIT_WORKER_IDS.forEach((id, i) => { WORKER_NAMES[id] = `Submitting Worker ${i + 1 + WORKER_OFFSET}`; });

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
