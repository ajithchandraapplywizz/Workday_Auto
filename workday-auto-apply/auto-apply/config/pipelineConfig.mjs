/**
 * pipelineConfig.mjs — 6-Worker Pipeline Configuration
 *
 * Configures strictly 6 canonical workers across 2 dedicated stages:
 * - Pool 1 (Scanning & Resolving): 3 parallel workers ('scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3')
 *   Takes unique links, fills/scrapes blueprint, and resolves all link clients -> ready_for_review
 * - Pool 2 (Submissions): 3 parallel workers ('submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3')
 *   Submits applications in ready_for_review on Workday and uploads proof screenshots
 *
 * Database worker_status table maintains strictly these 6 rows.
 */

export const PIPELINE_CONFIG = {
  stages: {
    SCANNING: 'scanning',
    RESOLVING: 'resolving',
    READY_FOR_REVIEW: 'ready_for_review',
    SUBMITTING: 'submitting',
    IDLE: 'idle',
  },

  workersCount: 6,
  scanCount: 3,
  resolveCount: 3,
  submitCount: 3,

  scanWorkerIds: ['scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3'],
  resolveWorkerIds: ['scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3'],
  submitWorkerIds: ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'],

  workerNames: {
    scanning_worker_1: 'Scanning & Resolving Worker 1',
    scanning_worker_2: 'Scanning & Resolving Worker 2',
    scanning_worker_3: 'Scanning & Resolving Worker 3',
    submitting_worker_1: 'Submitting Worker 1',
    submitting_worker_2: 'Submitting Worker 2',
    submitting_worker_3: 'Submitting Worker 3',
  },

  allWorkerIds: [
    'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
    'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'
  ],

  webhookPort: Number(process.env.DAEMON_PORT) || 3001,
  headless: process.env.HEADLESS !== 'false',
};
