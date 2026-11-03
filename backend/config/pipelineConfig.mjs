/**
 * pipelineConfig.mjs — Dynamic Worker Configuration Engine
 * =========================================================
 * Dynamically resolves active worker counts and IDs strictly from environment variables:
 *   - SERVICE_ROLE ('scanner', 'submitter', 'main', 'all')
 *   - WORKER_COUNT (dynamic count per container, default 2)
 *   - WORKER_OFFSET (offset for worker indexing, default 0)
 *   - SCANNER_WORKERS / SCAN_WORKERS
 *   - SUBMISSION_WORKERS / SUBMIT_WORKERS
 *   - RESOLVE_WORKERS / RESOLVING_WORKERS
 *
 * Never hardcodes static worker counts, artificial limits, or fixed log text.
 */

export function getActiveWorkerCount(roleType = '') {
  const baseCount = Number(process.env.WORKER_COUNT) || 2;
  const role = (roleType || process.env.SERVICE_ROLE || process.env.ROLE || '').toLowerCase();

  if (role.includes('scan')) {
    return Number(process.env.SCANNER_WORKERS) || Number(process.env.SCAN_WORKERS) || baseCount;
  }
  if (role.includes('submit')) {
    return Number(process.env.SUBMISSION_WORKERS) || Number(process.env.SUBMIT_WORKERS) || baseCount;
  }
  if (role.includes('resolve')) {
    return Number(process.env.RESOLVE_WORKERS) || Number(process.env.RESOLVING_WORKERS) || baseCount;
  }
  return baseCount;
}

export function getWorkerOffset() {
  return Number(process.env.WORKER_OFFSET) || 0;
}

export function getScanWorkerIds() {
  if (process.env.SCAN_WORKER_IDS) {
    return process.env.SCAN_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const count = getActiveWorkerCount('scanner');
  const offset = getWorkerOffset();
  return Array.from({ length: count }, (_, i) => `scanning_worker_${i + 1 + offset}`);
}

export function getResolveWorkerIds() {
  if (process.env.RESOLVE_WORKER_IDS) {
    return process.env.RESOLVE_WORKER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const count = getActiveWorkerCount('resolver');
  const offset = getWorkerOffset();
  return Array.from({ length: count }, (_, i) => `resolving_worker_${i + 1 + offset}`);
}

export function getSubmitWorkerIds() {
  if (process.env.SUBMISSION_WORKER_IDS || process.env.SUBMIT_WORKER_IDS) {
    const raw = process.env.SUBMISSION_WORKER_IDS || process.env.SUBMIT_WORKER_IDS;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const count = getActiveWorkerCount('submitter');
  const offset = getWorkerOffset();
  return Array.from({ length: count }, (_, i) => `submitting_worker_${i + 1 + offset}`);
}

export const WORKER_COUNT = Number(process.env.WORKER_COUNT) || 2;
export const WORKER_OFFSET = Number(process.env.WORKER_OFFSET) || 0;

export const SCANNER_WORKER_COUNT = Number(process.env.SCANNER_WORKERS) || Number(process.env.SCAN_WORKERS) || WORKER_COUNT;
export const SUBMISSION_WORKER_COUNT = Number(process.env.SUBMISSION_WORKERS) || Number(process.env.SUBMIT_WORKERS) || WORKER_COUNT;
export const RESOLVE_WORKER_COUNT = Number(process.env.RESOLVE_WORKERS) || Number(process.env.RESOLVING_WORKERS) || WORKER_COUNT;

export const SCAN_WORKER_IDS = getScanWorkerIds();
export const RESOLVE_WORKER_IDS = getResolveWorkerIds();
export const SUBMIT_WORKER_IDS = getSubmitWorkerIds();

const ALL_CANONICAL_WORKERS = [...new Set([...SCAN_WORKER_IDS, ...RESOLVE_WORKER_IDS, ...SUBMIT_WORKER_IDS])];

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

  get workersCount() {
    return getActiveWorkerCount();
  },
  get scannerWorkersCount() {
    return getActiveWorkerCount('scanner');
  },
  get submissionWorkersCount() {
    return getActiveWorkerCount('submitter');
  },
  get resolveWorkersCount() {
    return getActiveWorkerCount('resolver');
  },

  get scanWorkerIds() {
    return getScanWorkerIds();
  },
  get resolveWorkerIds() {
    return getResolveWorkerIds();
  },
  get submitWorkerIds() {
    return getSubmitWorkerIds();
  },

  workerNames: WORKER_NAMES,
  allWorkerIds: ALL_CANONICAL_WORKERS,

  webhookPort: Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || 8080,
  headless: process.env.HEADLESS !== 'false',
};
