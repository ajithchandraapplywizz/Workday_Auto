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

  const yn = extractYesNoAnswer(answer);
  if (yn === 'No' || answer === false) {
    const ok = await delegateExistingFill(page, field, 'No', ctx.profile);
    return ok ? okResult(field, 'No', 1) : failResult(field, 'checkbox_uncheck_unverified', { recoverable: true });
  }
  if (yn === 'Yes' || answer === true) {
    const ok = await delegateExistingFill(page, field, 'Yes', ctx.profile);
    return ok ? okResult(field, 'Yes', 1) : failResult(field, 'checkbox_check_unverified', { recoverable: true });
  }
  return failResult(field, 'checkbox_unsafe_answer', { recoverable: false });
}
