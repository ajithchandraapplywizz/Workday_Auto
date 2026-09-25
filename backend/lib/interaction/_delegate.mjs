/**
 * Delegate to the existing Workday fillers. Interaction handlers locate and
 * verify; they do not invent new click paths.
 */

import {
  fillApplicationQuestionField,
  fillWorkdaySelectOneDropdown,
} from '../workdayQuestionFill.mjs';

export async function delegateExistingFill(page, field, answer, profile = null) {
  const raw = field._raw || field;
  const label = field.label || raw.label || '';
  const fieldType = raw.fieldType || field.fieldType || field.elementType || 'text';
  const ok = await fillApplicationQuestionField(page, label, fieldType, answer, profile, raw);
  return Boolean(ok);
}

export async function delegateDropdown(page, field, answer) {
  const raw = field._raw || field;
  const label = field.label || raw.label || '';
  const idx = raw.formFieldIndex ?? raw.selectOneIndex ?? field.formFieldIndex ?? field.selectOneIndex ?? null;
  return fillWorkdaySelectOneDropdown(page, label, answer, {
    formFieldIndex: idx,
    selectOneIndex: idx,
    dropdownPageIndex: idx,
  });
}
