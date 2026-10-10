/**
 * pipelineConfig.mjs — 9-Worker Autonomous Pipeline Configuration
 *
 * Configures strictly 9 canonical workers across 3 dedicated pipeline stages:
 * - Stage 1 (Scanning): 3 parallel workers ('scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3')
 * - Stage 2 (Resolving): 3 parallel workers ('resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3')
 * - Human Review Pause: Career Associates review answers in Dashboard
 * - Stage 3 (Submissions): 3 parallel workers ('submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3')
 *
 * Database worker_status table maintains strictly these 9 rows.
 */

export const PIPELINE_CONFIG = {
  stages: {
    SCANNING: 'scanning',
    RESOLVING: 'resolving',
    READY_FOR_REVIEW: 'ready_for_review',
    SUBMITTING: 'submitting',
    IDLE: 'idle',
  },

  workersCount: 9,

  scanWorkerIds: ['scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3'],
  resolveWorkerIds: ['resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3'],
  submitWorkerIds: ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'],

  workerNames: {
    scanning_worker_1: 'Scanning Worker 1',
    scanning_worker_2: 'Scanning Worker 2',
    scanning_worker_3: 'Scanning Worker 3',
    resolving_worker_1: 'Resolving Worker 1',
    resolving_worker_2: 'Resolving Worker 2',
    resolving_worker_3: 'Resolving Worker 3',
    submitting_worker_1: 'Submitting Worker 1',
    submitting_worker_2: 'Submitting Worker 2',
    submitting_worker_3: 'Submitting Worker 3',
  },

  allWorkerIds: [
    'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
    'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3',
    'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'
  ],

  webhookPort: Number(process.env.DAEMON_PORT) || 3001,
  headless: process.env.HEADLESS !== 'false',
};
