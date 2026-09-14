/**
 * answerRecord.mjs — Structured decision for the Playwright layer.
 */

export const REASON = {
  EXPLICIT_PROFILE_MATCH: 'EXPLICIT_PROFILE_MATCH',
  VERIFIED_PREVIOUS_ANSWER: 'VERIFIED_PREVIOUS_ANSWER',
  SEMANTIC_PROFILE_MATCH: 'SEMANTIC_PROFILE_MATCH',
  OPTION_MATCH: 'OPTION_MATCH',
  UNKNOWN_INFORMATION: 'UNKNOWN_INFORMATION',
  AMBIGUOUS_QUESTION: 'AMBIGUOUS_QUESTION',
  HIGH_RISK_MISSING_DATA: 'HIGH_RISK_MISSING_DATA',
  NO_VALID_OPTION: 'NO_VALID_OPTION',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
};

export const SOURCE = {
  APPLYWIZZ: 'applywizz_profile',
  MEMORY: 'verified_answer_memory',
  USER: 'explicit_user_data',
  DETERMINISTIC: 'deterministic_mapping',
  LLM: 'llm_semantic_analysis',
  UNKNOWN: 'unknown',
};

/**
 * @param {object} partial
 */
export function buildAnswerRecord(partial = {}) {
  const confidence = Number(partial.confidence);
  const safeConfidence = Number.isFinite(confidence) ? confidence : 0;
  const requiresReview = partial.requiresReview === true
    || !partial.answer
    || safeConfidence < 0.70
    || Boolean(partial.reasonCode && /UNKNOWN|AMBIGUOUS|HIGH_RISK|NO_VALID|LOW_CONFIDENCE/.test(partial.reasonCode));

  return {
    questionId: partial.questionId || '',
    intent: partial.intent || 'unknown',
    normalizedQuestion: partial.normalizedQuestion || partial.label || '',
    answer: requiresReview && !partial.keepAnswerOnReview ? null : (partial.answer ?? null),
    answerType: partial.answerType || 'text',
    confidence: safeConfidence,
    source: partial.source || SOURCE.UNKNOWN,
    requiresReview,
    reasonCode: partial.reasonCode || (requiresReview ? REASON.UNKNOWN_INFORMATION : REASON.EXPLICIT_PROFILE_MATCH),
  };
}

export function reviewRecord(field, intent, reasonCode, extras = {}) {
  return buildAnswerRecord({
    questionId: field.questionId,
    intent,
    normalizedQuestion: field.label,
    answerType: extras.answerType,
    confidence: extras.confidence || 0,
    source: extras.source || SOURCE.UNKNOWN,
    requiresReview: true,
    reasonCode,
    keepAnswerOnReview: false,
  });
}
