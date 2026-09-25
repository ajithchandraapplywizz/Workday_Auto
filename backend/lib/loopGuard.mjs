/**
 * loopGuard.mjs — Guard against infinite form-filling loops and stalls.
 * 
 * Provides cycle tracking, per-field attempt limits, and state stagnation detection.
 */

import { normalizeLabel } from './qaStore.mjs';

/**
 * Creates a guard instance for a page loop execution.
 * 
 * @param {object} options
 * @param {number} [options.maxAttemptsPerField=2] Maximum fill attempts per unique field state
 * @param {number} [options.maxIterationsPerPage=8] Maximum scan-fill iterations per page
 * @param {number} [options.maxStallCycles=3] Maximum consecutive cycles with zero successful fills
 */
export function makeGuard({
  maxAttemptsPerField = 2,
  maxIterationsPerPage = 8,
  maxStallCycles = 3,
} = {}) {
  const attempts = new Map();
  let cyclesWithoutProgress = 0;
  let totalIterations = 0;

  /**
   * Generates a stable guard key for a field interaction.
   * Format: controlId + normalized label (NO answer text)
   */
  function makeKey(field, value = '', index = 0) {
    const cid = field?.questionId || field?._raw?.wdQId || 'ctrl';
    const norm = normalizeLabel(field?.label || '') || 'unlabeled';
    return `${cid}_${norm}`;
  }

  /**
   * Records an attempt and checks if the field has exceeded retry limits.
   */
  function recordAttempt(field, value = '', index = 0) {
    const key = makeKey(field, value, index);
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    return {
      key,
      count,
      exceeded: count > maxAttemptsPerField,
    };
  }

  /**
   * Checks if a field attempt would exceed max retries.
   */
  function isExceeded(field, value = '', index = 0) {
    const key = makeKey(field, value, index);
    return (attempts.get(key) || 0) >= maxAttemptsPerField;
  }

  /**
   * Records the result of an iteration/cycle.
   * @param {number} filledCount Number of successfully verified fills in this cycle
   */
  function recordCycle(filledCount = 0) {
    totalIterations += 1;
    if (filledCount > 0) {
      cyclesWithoutProgress = 0;
    } else {
      cyclesWithoutProgress += 1;
    }

    const stalled = cyclesWithoutProgress >= maxStallCycles;
    const pageExceeded = totalIterations >= maxIterationsPerPage;

    return {
      iteration: totalIterations,
      cyclesWithoutProgress,
      stalled,
      pageExceeded,
      shouldAbort: stalled || pageExceeded,
      reason: stalled ? 'max_stall_cycles_reached' : (pageExceeded ? 'max_page_iterations_reached' : null),
    };
  }

  function resetCycleProgress() {
    cyclesWithoutProgress = 0;
  }

  return {
    makeKey,
    recordAttempt,
    isExceeded,
    recordCycle,
    resetCycleProgress,
    get attempts() { return attempts; },
    get totalIterations() { return totalIterations; },
    get cyclesWithoutProgress() { return cyclesWithoutProgress; },
  };
}
