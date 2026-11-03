import { extractYesNoAnswer } from '../workdayDefaults.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Boolean checkbox or multi-checkbox group. Never toggle blindly.
 */
export async function fillCheckbox(page, field, answer, ctx = {}) {
  const elementType = field.elementType || field.controlType || '';
  if (elementType === 'multi-checkbox' || /checkbox-group/i.test(String(field.fieldType || ''))) {
    const ok = await delegateExistingFill(page, field, answer, ctx.profile);
    if (ok) return okResult(field, answer, 1);
    return failResult(field, 'checkbox_group_unverified', { recoverable: true });
  }

  const ansStr = String(answer || '').trim();
  const yn = extractYesNoAnswer(answer);
  const isAffirmative = yn === 'Yes' || answer === true || /^(true|yes|1|on|agree|accept|willingly|certify|acknowledge|i\s+(agree|accept|willingly|certify|acknowledge|confirm|understand))/i.test(ansStr);
  const isNegative = yn === 'No' || answer === false || /^(false|no|0|off|decline|disagree|i\s+(do\s+not|don't|decline|disagree))/i.test(ansStr);

  const isAgreementLabel = /agree|accept|certify|acknowledge|consent|terms|privacy|understand|confirm|statement|foregoing|declaration/i.test(field.label || '');

  if (isNegative) {
    const ok = await delegateExistingFill(page, field, 'No', ctx.profile);
    return ok ? okResult(field, 'No', 1) : failResult(field, 'checkbox_uncheck_unverified', { recoverable: true });
  }
  if (isAffirmative || isAgreementLabel || (field.required && !isNegative) || (field.label && (ansStr.toLowerCase().includes(field.label.toLowerCase().slice(0, 30)) || field.label.toLowerCase().includes(ansStr.toLowerCase().slice(0, 30))))) {
    const ok = await delegateExistingFill(page, field, 'Yes', ctx.profile);
    return ok ? okResult(field, 'Yes', 1) : failResult(field, 'checkbox_check_unverified', { recoverable: true });
  }
  return failResult(field, 'checkbox_unsafe_answer', { recoverable: false });
}
