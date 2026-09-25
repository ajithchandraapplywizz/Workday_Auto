/**
 * questionEngine — WHAT to answer. Playwright (`lib/interaction`) is HOW.
 *
 * Consumes Prompt 1 normalized fields. Never clicks, never invents personal facts.
 */

export { classifyQuestionIntent, isHighRiskIntent, intentsAreCompatible } from './intents.mjs';
export { mapToExactOption, answerTypeFromField } from './optionMap.mjs';
export { buildAnswerRecord, reviewRecord, REASON, SOURCE } from './answerRecord.mjs';
export { profileFactPresence, applyWizzStatus } from './profileFacts.mjs';
export {
  answerPageQuestions,
  resolveFieldWithoutLlm,
  resolveDynamicAnswer,
  decisionForField,
  llmAnswerWithPlaywrightContext,
} from './pageAnswerEngine.mjs';
