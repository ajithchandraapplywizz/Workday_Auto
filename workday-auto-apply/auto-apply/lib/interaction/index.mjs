/**
 * interaction/index.mjs — Playwright interaction dispatch.
 *
 * LLM answers questions. This module only locates, fills, and verifies.
 */

import { fillText } from './text.mjs';
import { fillTextarea } from './textarea.mjs';
import { fillSelect } from './select.mjs';
import { fillCheckbox } from './checkbox.mjs';
import { fillRadio } from './radio.mjs';
import { fillCombobox } from './combobox.mjs';
import { fillDatepicker } from './datepicker.mjs';
import { fillFileUpload } from './fileUpload.mjs';
import { fillCustomControl } from './customControl.mjs';
import { validateAnswer } from './answerValidator.mjs';
import { logFieldOp } from './observe.mjs';
import { failResult } from './_result.mjs';

export { normalizeDiscoveredField, normalizeDiscoveredFields, mapElementType } from './fieldSchema.mjs';
export { discoverPage } from './pageDiscovery.mjs';
export { validateAnswer } from './answerValidator.mjs';
export { validatePage } from './pageValidator.mjs';
export { locateControl } from './locators.mjs';
export { logFieldOp } from './observe.mjs';

const HANDLERS = {
  text: fillText,
  email: fillText,
  tel: fillText,
  number: fillText,
  textarea: fillTextarea,
  select: fillSelect,
  checkbox: fillCheckbox,
  'multi-checkbox': fillCheckbox,
  radio: fillRadio,
  combobox: fillCombobox,
  'custom-dropdown': fillCombobox,
  'custom-combobox': fillCombobox,
  date: fillDatepicker,
  file: fillFileUpload,
  unknown: fillCustomControl,
  button: fillCustomControl,
};

/**
 * Validate then interact. Never clicks when the answer is unsafe.
 * @param {import('playwright').Page} page
 * @param {object} field  normalized field
 * @param {string|object} resolved
 * @param {{ profile?: object, pageNumber?: number }} [ctx]
 */
export async function interactField(page, field, resolved, ctx = {}) {
  const gate = validateAnswer(field, resolved);
  if (!gate.ok) {
    const rec = logFieldOp({
      page: ctx.pageNumber || field.pageNumber || 1,
      questionId: field.questionId,
      elementType: field.elementType,
      action: 'skip',
      requestedValue: '',
      actualValue: field.currentValue || '',
      verified: false,
      reason: gate.reason,
    });
    return {
      ...failResult(field, gate.reason, { recoverable: false }),
      status: gate.status,
      log: rec,
    };
  }

  const type = field.elementType || field.controlType || 'unknown';
  const handler = HANDLERS[type] || fillCustomControl;
  const result = await handler(page, field, gate.answer, ctx);
  const rec = logFieldOp({
    page: ctx.pageNumber || field.pageNumber || 1,
    questionId: field.questionId,
    elementType: type,
    action: type === 'file' ? 'skip' : 'fill',
    requestedValue: gate.answer,
    actualValue: result.verifiedValue || '',
    verified: result.success === true,
    attempts: result.attempts || 1,
    reason: result.reason || '',
  });
  return { ...result, log: rec };
}
