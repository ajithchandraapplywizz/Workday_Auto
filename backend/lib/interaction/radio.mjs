import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';
import { matchOptionSafely } from './selectVerified.mjs';
import { resolveAnswerFromLiveOptions } from '../workdayQuestionFill.mjs';

/**
 * Check the radio whose accessible name matches the validated option.
 */
export async function fillRadio(page, field, answer, ctx = {}) {
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
      return failResult(field, `radio_option_not_found:${safeMatch.reason || 'not_in_options'}`, { recoverable: false });
    }
  }
  const ok = await delegateExistingFill(page, field, resolvedAnswer, ctx.profile);
  if (ok) return okResult(field, resolvedAnswer, 1);
  return failResult(field, 'radio_unverified', { recoverable: true });
}
