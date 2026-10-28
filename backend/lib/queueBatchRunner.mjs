/**
 * queueBatchRunner.mjs
 * Bridge to workerPool for queue-run CLI command
 */
import { runQueueWorkerPool } from './workerPool.mjs';

export async function runQueueBatchForUrl(options = {}) {
  return runQueueWorkerPool(options);
}
