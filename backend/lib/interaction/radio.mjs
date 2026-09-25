import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';
import { matchOptionSafely } from './selectVerified.mjs';

/**
 * Check the radio whose accessible name matches the validated option.
 */
export async function fillRadio(page, field, answer, ctx = {}) {
  const options = (field.options || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).filter(Boolean);
  if (options.length) {
    const safeMatch = matchOptionSafely(answer, options);
    if (!safeMatch.match) {
      return failResult(field, `radio_option_not_found:${safeMatch.reason || 'not_in_options'}`, { recoverable: false });
    }
  }
  const ok = await delegateExistingFill(page, field, answer, ctx.profile);
  if (ok) return okResult(field, answer, 1);
  return failResult(field, 'radio_unverified', { recoverable: true });
}
