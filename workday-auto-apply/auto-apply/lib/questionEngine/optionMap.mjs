/**
 * optionMap.mjs — Map a semantic answer onto an exact live Workday option.
 */

import { alignAnswerToWorkdayOptions } from '../applyWizzClient.mjs';
import { extractYesNoAnswer, selectionMatchesAnswer } from '../workdayDefaults.mjs';
import { matchDemographicOption } from '../interaction/workdayCustomDropdown.mjs';

/**
 * @param {string} answer
 * @param {string[]} options
 * @param {string} [elementType]
 * @returns {{ ok: true, answer: string } | { ok: false, reasonCode: string }}
 */
export function mapToExactOption(answer, options = [], elementType = '') {
  const text = answer == null ? '' : String(answer).trim();
  if (!text) return { ok: false, reasonCode: 'UNKNOWN_INFORMATION' };

  const opts = (options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const needsOption = /select|combobox|dropdown|radio/i.test(String(elementType))
    || (opts.length > 0 && /yes|no/i.test(opts.join(' ')));

  if (!opts.length) return { ok: true, answer: text };

  const aligned = alignAnswerToWorkdayOptions(text, opts, elementType);
  if (aligned && opts.some((o) => o === aligned)) return { ok: true, answer: aligned };

  const exact = opts.find((o) => o.toLowerCase() === text.toLowerCase());
  if (exact) return { ok: true, answer: exact };

  const demographic = matchDemographicOption(text, opts);
  if (demographic) return { ok: true, answer: demographic };

  const yn = extractYesNoAnswer(text);
  if (yn) {
    const hit = opts.find((o) => extractYesNoAnswer(o) === yn);
    if (hit) return { ok: true, answer: hit };
  }

  const matched = opts.find((o) => selectionMatchesAnswer(o, text));
  if (matched) return { ok: true, answer: matched };

  if (!needsOption) return { ok: true, answer: text };
  return { ok: false, reasonCode: 'NO_VALID_OPTION' };
}

export function answerTypeFromField(field = {}) {
  const el = field.elementType || field.controlType || field.fieldType || 'text';
  if (/multi-checkbox|checkbox-group/i.test(el)) return 'multi-select';
  if (/checkbox/i.test(el)) return 'checkbox';
  if (/radio/i.test(el)) return 'radio';
  if (/dropdown|combobox|select/i.test(el)) return 'dropdown';
  if (/textarea/i.test(el)) return 'textarea';
  if (/email/i.test(el)) return 'email';
  if (/tel|phone/i.test(el)) return 'phone';
  if (/number|numeric/i.test(el)) return 'number';
  if (/date/i.test(el)) return 'date';
  return 'text';
}
