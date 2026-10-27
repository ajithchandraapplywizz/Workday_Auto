/**
 * pipelineConfig.mjs — 10-Worker Shared Pipeline Configuration
 *
 * Configures strictly 10 shared canonical workers (worker_1 through worker_10):
 * - Scanning & Resolving: The 10 workers scan unique job links and resolve 4-tier answers in parallel.
 * - Submissions: The same 10 workers execute Workday submissions in parallel on Railway.
 *
 * Database worker_status table maintains strictly these 10 rows.
 */

export const WORKER_COUNT = Number(process.env.WORKER_COUNT) || 2;
export const WORKER_OFFSET = Number(process.env.WORKER_OFFSET) || 0;
const WORKER_IDS = Array.from({ length: WORKER_COUNT }, (_, i) => `worker_${i + 1 + WORKER_OFFSET}`);

const WORKER_NAMES = {};
WORKER_IDS.forEach((id, i) => { WORKER_NAMES[id] = `Worker ${i + 1 + WORKER_OFFSET}`; });

export const PIPELINE_CONFIG = {
  stages: {
    SCANNING: 'scanning',
    RESOLVING: 'resolving',
    READY_FOR_REVIEW: 'ready_for_review',
    SUBMITTING: 'submitting',
    IDLE: 'idle',
  },

  workersCount: WORKER_COUNT,

  scanWorkerIds: WORKER_IDS,
  resolveWorkerIds: WORKER_IDS,
  submitWorkerIds: WORKER_IDS,

  workerNames: WORKER_NAMES,
  allWorkerIds: WORKER_IDS,

  webhookPort: Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || 8080,
  headless: process.env.HEADLESS !== 'false',
};


