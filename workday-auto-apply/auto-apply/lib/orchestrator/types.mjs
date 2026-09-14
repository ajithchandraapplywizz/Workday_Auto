/**
 * Shared orchestrator statuses. Success = verified page state, not "clicked Next".
 */

export const STATUS = {
  PAGE_COMPLETE: 'page_complete',
  PAGE_INCOMPLETE: 'page_incomplete',
  BLOCKED: 'blocked',
  FIELD_FAILED: 'field_failed',
};

export function blockedResult({
  page = 1,
  questionId = '',
  reason = 'unsafe_answer',
  requiresReview = true,
  extras = {},
} = {}) {
  return {
    status: STATUS.BLOCKED,
    page,
    questionId,
    reason,
    requiresReview,
    ...extras,
  };
}
