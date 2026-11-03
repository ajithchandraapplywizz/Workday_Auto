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

const DEFAULT_ALL_WORKERS = [
  'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3', 'scanning_worker_4',
  'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3', 'resolving_worker_4',
  'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3', 'submitting_worker_4',
  'submitting_worker_5', 'submitting_worker_6', 'submitting_worker_7', 'submitting_worker_8',
];

const ALL_CANONICAL_WORKERS = [...new Set([...DEFAULT_ALL_WORKERS, ...SCAN_WORKER_IDS, ...RESOLVE_WORKER_IDS, ...SUBMIT_WORKER_IDS])];

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
