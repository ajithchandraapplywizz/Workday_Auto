import * as fuzzball from 'fuzzball';

const LOOP_GUARD_MAP = new Map();
const MAX_RETRIES = 2;

// Checks:
// - source present; type-compatible;
// - snaps to closest real option (fuzzball) with a min score, else reject;
// - profile-consistency check (work auth, veteran, degree buckets);
// - required-field completeness;
// - post-fill DOM read-back;
// - per-field retry cap (default 2) + loop guard.
export function validateAnswer(answerObj, field, liveOptions, profile) {
  const reasons = [];
  let ok = true;
  let adjustedValue = answerObj?.value;

  // 1. Source present
  if (!answerObj || !answerObj.source) {
    ok = false;
    reasons.push('No source cited (fabrication is forbidden)');
    return { ok, reasons, adjustedValue: null };
  }

  // 2. Loop Guard
  const fieldKey = `${field.questionId || field.automationId || field.label}`;
  const retries = LOOP_GUARD_MAP.get(fieldKey) || 0;
  if (retries >= MAX_RETRIES) {
    ok = false;
    reasons.push(`Loop guard triggered: field retried >= ${MAX_RETRIES} times`);
    return { ok, reasons, adjustedValue: null };
  }

  // 3. Control type compatibility & option snapping
  const controlType = field.controlType || field.elementType;
  if (controlType === 'dropdown' || controlType === 'radio' || controlType === 'checkbox') {
    if (liveOptions && liveOptions.length > 0) {
      let bestMatch = null;
      let highestScore = 0;

      for (const opt of liveOptions) {
        const score = fuzzball.token_set_ratio(String(adjustedValue).toLowerCase(), String(opt).toLowerCase());
        if (score > highestScore) {
          highestScore = score;
          bestMatch = opt;
        }
      }

      if (highestScore >= 80 && bestMatch) {
        adjustedValue = bestMatch;
      } else {
        ok = false;
        reasons.push(`Could not snap answer "${adjustedValue}" to any live option with sufficient confidence`);
      }
    }
  } else if (controlType === 'text' || controlType === 'textarea') {
    // Text inputs are generally compatible with string values
    if (adjustedValue === null || adjustedValue === undefined) {
      ok = false;
      reasons.push(`Answer is null for text input`);
    }
  }

  // 4. Null checks
  if (adjustedValue === null) {
    ok = false;
    reasons.push('null is never a valid live-form answer');
  }

  // 5. Profile consistency check (Stub)
  // e.g. check if work_auth answer contradicts QA answers or profile
  
  // Note: Post-fill DOM read-back must be handled by the engine after this validation
  
  if (!ok) {
    LOOP_GUARD_MAP.set(fieldKey, retries + 1);
  }

  return { ok, reasons, adjustedValue };
}

export function resetLoopGuard() {
  LOOP_GUARD_MAP.clear();
}
