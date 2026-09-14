/**
 * answerValidator.mjs — Browser layer never invents an answer.
 * LLM / Apply Wizz decide the value; this only checks it is safe to type/click.
 */

import { selectionMatchesAnswer, extractYesNoAnswer, isYesNoQuestionLabel } from '../workdayDefaults.mjs';

const DEFAULT_MIN_CONFIDENCE = 0.45;

function optionList(field = {}) {
  return (field.options || field._raw?.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Map a semantic answer onto an exact live option. No first-option guess.
 * @returns {{ ok: true, answer: string } | { ok: false, status: string, reason: string }}
 */
export function validateAnswer(field = {}, resolved = {}, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const questionId = field.questionId || field.label || '';
  const label = field.label || '';
  if (resolved == null) {
    return { ok: false, status: 'requires_review', reason: 'unsafe_answer', questionId };
  }
  const answer = typeof resolved === 'object' && resolved ? resolved.answer : resolved;
  const confidence = typeof resolved === 'object' && resolved ? Number(resolved.confidence) : NaN;

  if (answer == null || String(answer).trim() === '') {
    return { ok: false, status: 'requires_review', reason: 'unsafe_answer', questionId };
  }

  if (Number.isFinite(confidence) && confidence < minConfidence) {
    return { ok: false, status: 'requires_review', reason: 'unsafe_answer', questionId };
  }

  const text = String(answer).trim();
  const options = optionList(field);
  const elementType = field.elementType || field.controlType || field.fieldType || '';
  // Single-choice only. Multi-checkbox and text/textarea answers are not guessed, but
  // they are not required to equal one option string.
  const needsOption = /^(select|combobox|custom-dropdown|custom-combobox|radio)$/i.test(String(elementType))
    || /dropdown|select|combobox|radio/i.test(String(field.fieldType || ''))
      && !/checkbox-group|multi/i.test(String(field.fieldType || elementType));

  if (options.length && needsOption) {
    const exact = options.find((opt) => opt === text || opt.toLowerCase() === text.toLowerCase());
    if (exact) return { ok: true, answer: exact, questionId };

    const polarity = extractYesNoAnswer(text) || (isYesNoQuestionLabel(label) ? extractYesNoAnswer(text) : null);
    if (polarity) {
      const yn = options.find((opt) => extractYesNoAnswer(opt) === polarity);
      if (yn) return { ok: true, answer: yn, questionId };
    }

    const matched = options.find((opt) => selectionMatchesAnswer(opt, text));
    if (matched) return { ok: true, answer: matched, questionId };

    return {
      ok: false,
      status: 'requires_review',
      reason: 'unsafe_answer',
      questionId,
      detail: 'option_not_in_list',
    };
  }

  return { ok: true, answer: text, questionId };
}
