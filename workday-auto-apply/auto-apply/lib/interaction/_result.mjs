/** Shared success/failure objects for interaction handlers. */

export function okResult(field, verifiedValue, attempts = 1) {
  return {
    success: true,
    questionId: field.questionId || field.label || '',
    attempts,
    verifiedValue: verifiedValue == null ? '' : String(verifiedValue),
  };
}

export function failResult(field, reason, { recoverable = true, attempts = 1, verifiedValue = '' } = {}) {
  return {
    success: false,
    questionId: field.questionId || field.label || '',
    reason,
    recoverable,
    attempts,
    verifiedValue,
  };
}
