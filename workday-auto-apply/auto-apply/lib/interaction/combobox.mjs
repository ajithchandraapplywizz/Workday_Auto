import { waitForDomSettled } from '../workdayDom.mjs';
import { delegateDropdown, delegateExistingFill } from './_delegate.mjs';
import { fillWorkdayCustomDropdown } from './workdayCustomDropdown.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Custom Workday combobox / selectOne. Opens the live list, picks an exact option, verifies.
 * Does not invent an option.
 */
export async function fillCombobox(page, field, answer, ctx = {}) {
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
