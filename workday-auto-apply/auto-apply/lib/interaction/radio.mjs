import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Check the radio whose accessible name matches the validated option.
 */
export async function fillRadio(page, field, answer, ctx = {}) {
  const options = field.options || [];
  if (options.length && !options.some((opt) => String(opt).toLowerCase() === String(answer).toLowerCase())) {
    const hit = options.find((opt) => String(opt).toLowerCase().startsWith(String(answer).toLowerCase()));
    if (!hit) return failResult(field, 'radio_option_not_found', { recoverable: false });
  }
  const ok = await delegateExistingFill(page, field, answer, ctx.profile);
  if (ok) return okResult(field, answer, 1);
  return failResult(field, 'radio_unverified', { recoverable: true });
}
