import { fillWorkdayDateField } from '../workdayDateFill.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

function inferSection(field = {}) {
  const step = String(field.stepName || field._raw?.stepName || '');
  const label = String(field.label || '');
  if (/education/i.test(step) || /school|degree|field of study/i.test(label)) return 'education';
  return 'work';
}

function inferMode(field = {}, answer = '') {
  const raw = String(field.fieldType || field._raw?.type || '');
  if (/^year$/i.test(raw) || /^\d{4}$/.test(String(answer).trim())) return 'year';
  return 'monthyear';
}

/**
 * Work Experience / Education From–To spins, or a generic date input.
 */
export async function fillDatepicker(page, field, answer, ctx = {}) {
  const label = field.label || '';
  if (/^from\b|^to\b|start date|end date|actual or expected/i.test(label)) {
    const result = await fillWorkdayDateField(page, {
      labelPattern: label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      sectionType: inferSection(field),
      value: String(answer),
      mode: inferMode(field, answer),
      requiredOnly: ctx.requiredOnly === true,
    });
    if (result?.ok) return okResult(field, answer, (result.attempts || []).length || 1);
    return failResult(field, 'datepicker_unverified', { recoverable: true, attempts: 2 });
  }
  const ok = await delegateExistingFill(page, field, answer, ctx.profile);
  if (ok) return okResult(field, answer, 1);
  return failResult(field, 'datepicker_unverified', { recoverable: true });
}
