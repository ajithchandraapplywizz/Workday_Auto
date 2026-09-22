import { waitForDomSettled } from '../workdayDom.mjs';
import { delegateDropdown, delegateExistingFill } from './_delegate.mjs';
import { fillWorkdayCustomDropdown } from './workdayCustomDropdown.mjs';
import { okResult, failResult } from './_result.mjs';
import { matchOptionSafely, fillSelectVerified } from './selectVerified.mjs';

/**
 * Custom Workday combobox / selectOne. Opens the live list, picks an exact option, verifies.
 * Does not invent an option.
 */
export async function fillCombobox(page, field, answer, ctx = {}) {
  const options = (field.options || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).filter(Boolean);
  if (options.length) {
    const safeMatch = matchOptionSafely(answer, options);
    if (!safeMatch.match) {
      return failResult(field, `option_not_in_list:${safeMatch.reason || 'not_found'}`, { recoverable: false });
    }
  }

  const verifiedResult = await fillSelectVerified(page, field, answer, ctx);
  if (verifiedResult.success) return verifiedResult;

  const custom = await fillWorkdayCustomDropdown(page, field, answer);
  if (custom.success) return okResult(field, custom.verifiedValue, custom.attempts || 1);

  const raw = field._raw || field;
  let ok = false;
  if (raw.selectOneIndex != null || raw.formFieldIndex != null || /dropdown|combobox|select/i.test(String(raw.fieldType || field.elementType))) {
    ok = await delegateDropdown(page, field, answer);
  }
  if (!ok) ok = await delegateExistingFill(page, field, answer, ctx.profile);
  await waitForDomSettled(page, { timeout: 800 }).catch(() => {});
  if (ok) return okResult(field, answer, 2);
  return failResult(field, custom.reason || 'custom_combobox_option_not_found', {
    recoverable: true,
    attempts: custom.attempts || 2,
  });
}
