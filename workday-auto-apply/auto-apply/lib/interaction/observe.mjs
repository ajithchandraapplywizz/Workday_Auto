/**
 * observe.mjs — Structured logs for every Playwright field operation.
 */

export function fieldOperationLog({
  page = 1,
  questionId = '',
  elementType = '',
  action = '',
  requestedValue = '',
  actualValue = '',
  verified = false,
  attempts = 1,
  reason = '',
} = {}) {
  return {
    timestamp: new Date().toISOString(),
    page,
    questionId,
    elementType,
    action,
    requestedValue: requestedValue == null ? '' : String(requestedValue).slice(0, 120),
    actualValue: actualValue == null ? '' : String(actualValue).slice(0, 120),
    verified: Boolean(verified),
    attempts,
    ...(reason ? { reason } : {}),
  };
}

/**
 * @param {object} entry
 */
export function logFieldOp(entry) {
  const rec = fieldOperationLog(entry);
  const mark = rec.verified ? '✅' : '⛔';
  const extra = rec.reason ? ` (${rec.reason})` : '';
  console.log(
    `    ${mark} [pw ${rec.elementType}] ${String(rec.questionId).slice(0, 40)} `
    + `${rec.action} requested="${rec.requestedValue.slice(0, 40)}" actual="${rec.actualValue.slice(0, 40)}"${extra}`,
  );
  return rec;
}
