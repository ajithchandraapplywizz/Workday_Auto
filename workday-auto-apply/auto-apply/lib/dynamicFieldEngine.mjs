/**
 * dynamicFieldEngine.mjs — Session reset + page orchestration entry.
 *
 * The Application Agent Orchestrator owns scan → reason → validate → fill → verify.
 * Playwright (hands) and the question engine (brain) stay separate.
 */

import { runWorkdayPageWorkflow } from './orchestrator/workdayPageWorkflow.mjs';

function ensureSessionSets(profile) {
  if (!(profile._dynamicSkipNorms instanceof Set)) {
    profile._dynamicSkipNorms = new Set(profile._dynamicSkipNorms || []);
  }
  if (!(profile._dynamicRetryNorms instanceof Map)) {
    profile._dynamicRetryNorms = new Map();
  }
}

function resetRetryMapForStep(profile, stepName) {
  if (profile._dynamicLoopStep !== stepName) {
    profile._dynamicLoopStep = stepName;
    profile._dynamicRetryNorms = new Map();
  }
}

/**
 * Clear per-application session markers so each new job URL gets a fresh live DOM pass.
 * Does not touch profile.yml answers (qa_answers / personal / experience).
 * @param {object} profile
 */
export function resetPerApplicationSessionState(profile = {}) {
  profile._filledValues = {};
  profile._filledFingerprints = new Set();
  profile._dynamicSkipNorms = new Set();
  profile._dynamicRetryNorms = new Map();
  profile._discoveredFields = [];
  profile._humanRequired = [];
  profile._stepBlocked = {};
  profile._answerCache = new Map();
  profile._verifiedMemory = { byId: {}, byIntent: {}, byNorm: {} };
  delete profile._lastOrchestrator;
  delete profile._dynamicLoopStep;
  delete profile._step1SourceFilled;
  delete profile._clientBootstrapped;
}

/**
 * Run the orchestrator for the current wizard step.
 */
export async function runDynamicFieldLoop(page, profile, plan = {}, stepName = '', options = {}) {
  const maxCycles = options.maxPasses ?? (/voluntary disclosures|application questions/i.test(stepName) ? 18 : 14);
  profile._currentStep = stepName;
  profile._jobUrl = profile._jobUrl || page.url();
  ensureSessionSets(profile);
  resetRetryMapForStep(profile, stepName);

  const result = await runWorkdayPageWorkflow(page, profile, plan, stepName, {
    maxCycles,
    maxOuterPasses: options.maxOuterPasses ?? 4,
    pageNumber: options.pageNumber || 1,
  });
  profile._lastOrchestrator = result.orchestrator;
  return {
    filled: result.filled || 0,
    humanRequired: result.humanRequired || [],
    pageCheck: result.pageCheck,
    orchestrator: result.orchestrator,
    status: result.status,
  };
}
