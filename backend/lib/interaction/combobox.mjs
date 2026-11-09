import { waitForDomSettled } from '../workdayDom.mjs';
import { delegateDropdown, delegateExistingFill } from './_delegate.mjs';
import { fillWorkdayCustomDropdown } from './workdayCustomDropdown.mjs';
import { okResult, failResult } from './_result.mjs';
import { matchOptionSafely, fillSelectVerified } from './selectVerified.mjs';
import { resolveAnswerFromLiveOptions } from '../workdayQuestionFill.mjs';

/**
 * Custom Workday combobox / selectOne. Opens the live list, picks an exact option, verifies.
 * Does not invent an option.
 */
export async function fillCombobox(page, field, answer, ctx = {}) {
  let resolvedAnswer = answer;
  const options = (field.options || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).filter(Boolean);
  if (options.length) {
    let safeMatch = matchOptionSafely(resolvedAnswer, options);
    if (!safeMatch.match) {
      const smartAnswer = resolveAnswerFromLiveOptions({
        liveOptions: options,
        labelText: field.label,
        profile: ctx.profile,
        preferredAnswer: resolvedAnswer,
      });
      if (smartAnswer) {
        resolvedAnswer = smartAnswer;
        safeMatch = { match: smartAnswer, strategy: 'profile_dynamic_match' };
      }
    }
    if (!safeMatch.match) {
      return failResult(field, `option_not_in_list:${safeMatch.reason || 'not_found'}`, { recoverable: false });
    }
  }

  const verifiedResult = await fillSelectVerified(page, field, resolvedAnswer, ctx);
  if (verifiedResult.success) return verifiedResult;

  const custom = await fillWorkdayCustomDropdown(page, field, resolvedAnswer);
  if (custom.success) return okResult(field, custom.verifiedValue, custom.attempts || 1);

  const raw = field._raw || field;
  let ok = false;
  if (raw.selectOneIndex != null || raw.formFieldIndex != null || /dropdown|combobox|select/i.test(String(raw.fieldType || field.elementType))) {
    ok = await delegateDropdown(page, field, resolvedAnswer);
  }
  if (!ok) ok = await delegateExistingFill(page, field, resolvedAnswer, ctx.profile);
  await waitForDomSettled(page, { timeout: 200 }).catch(() => {});
  if (ok) return okResult(field, resolvedAnswer, 2);
  return failResult(field, custom.reason || 'custom_combobox_option_not_found', {
    recoverable: true,
    attempts: custom.attempts || 2,
  });
}
