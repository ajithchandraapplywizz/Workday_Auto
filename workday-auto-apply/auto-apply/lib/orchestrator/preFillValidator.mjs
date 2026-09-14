/**
 * Pre-fill gate. Playwright must not run unless every check passes.
 */

import { validateAnswer } from '../interaction/answerValidator.mjs';
import { isHighRiskIntent } from '../questionEngine/intents.mjs';
import { contradictsVerified } from './memory.mjs';

export const FILL_CONFIDENCE_FLOOR = 0.70;

/**
 * @param {object} field  normalized Playwright field
 * @param {object} decision  question-engine record
 * @param {object} [profile]
 * @returns {{ ok: true, answer: string } | { ok: false, reason: string, requiresReview: true }}
 */
export function validateBeforeFill(field = {}, decision = {}, profile = {}) {
  if (!field.questionId && !field.label) {
    return { ok: false, reason: 'missing_question_id', requiresReview: true };
  }
  if (!decision || decision.requiresReview === true) {
    return {
      ok: false,
      reason: String(decision?.reasonCode || 'ambiguous_question').toLowerCase(),
      requiresReview: true,
    };
  }

  const required = field.required === true;
  const answer = decision.answer;
  if (required && (answer == null || String(answer).trim() === '')) {
    return { ok: false, reason: 'missing_required_answer', requiresReview: true };
  }
  if (answer == null || String(answer).trim() === '') {
    return { ok: false, reason: 'missing_answer', requiresReview: true };
  }

  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < FILL_CONFIDENCE_FLOOR) {
    return { ok: false, reason: 'low_confidence', requiresReview: true };
  }

  if (isHighRiskIntent(decision.intent) && /llm_semantic|unknown/i.test(String(decision.source || ''))) {
    return { ok: false, reason: 'high_risk_unsupported', requiresReview: true };
  }

  if (contradictsVerified(profile, decision.intent, answer)) {
    return { ok: false, reason: 'contradicts_verified_memory', requiresReview: true };
  }

  const interaction = validateAnswer(field, {
    answer,
    confidence,
  }, { minConfidence: FILL_CONFIDENCE_FLOOR });
  if (!interaction.ok) {
    return { ok: false, reason: interaction.detail || interaction.reason || 'unsafe_answer', requiresReview: true };
  }

  return { ok: true, answer: interaction.answer };
}
