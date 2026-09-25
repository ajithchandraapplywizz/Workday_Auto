import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Unknown / custom Workday widgets — reuse the existing formField filler.
 * No invented selectors.
 */
export async function fillCustomControl(page, field, answer, ctx = {}) {
  const ok = await delegateExistingFill(page, field, answer, ctx.profile);
  if (ok) return okResult(field, answer, 1);
  return failResult(field, 'custom_control_unverified', { recoverable: true });
}
