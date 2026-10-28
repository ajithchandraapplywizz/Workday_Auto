/**
 * demoRunner.mjs
 * Bridge to clusterBatchRunner for demo-run CLI command
 */
import { runClusterBatchRunner } from './clusterBatchRunner.mjs';

export async function runDemoBatch(options = {}) {
  return runClusterBatchRunner(options);
}
