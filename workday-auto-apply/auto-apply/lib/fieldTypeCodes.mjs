/**
 * fieldTypeCodes.mjs — Stable numeric codes for Workday DOM field types.
 *
 * 1 = input / text / number / date (free-type)
 * 2 = dropdown / select / combobox
 * 3 = radio
 * 4 = single checkbox
 * 5 = multi checkbox (checkbox-group / select-all-that-apply)
 */

export const FIELD_TYPE_CODES = Object.freeze({
  INPUT: 1,
  DROPDOWN: 2,
  RADIO: 3,
  CHECKBOX: 4,
  MULTI_CHECKBOX: 5,
});

export const FIELD_TYPE_CODE_LABELS = Object.freeze({
  1: 'input',
  2: 'dropdown',
  3: 'radio',
  4: 'checkbox',
  5: 'multi_checkbox',
});

/**
 * Map a discovered fieldType string → numeric code.
 * @param {string} fieldType
 * @returns {number}
 */
export function fieldTypeToCode(fieldType = '') {
  const t = String(fieldType || '').toLowerCase().trim();
  if (!t) return FIELD_TYPE_CODES.INPUT;
  if (/checkbox-group|multi.?select|select all that apply/i.test(t)) return FIELD_TYPE_CODES.MULTI_CHECKBOX;
  if (/^checkbox$|single.?check/i.test(t)) return FIELD_TYPE_CODES.CHECKBOX;
  if (/radio/i.test(t)) return FIELD_TYPE_CODES.RADIO;
  if (/dropdown|select|combobox|typeahead|listbox/i.test(t)) return FIELD_TYPE_CODES.DROPDOWN;
  if (/text|input|textarea|number|spin|numeric|tel|email|url|date|search/i.test(t)) {
    return FIELD_TYPE_CODES.INPUT;
  }
  return FIELD_TYPE_CODES.INPUT;
}

/**
 * Map numeric code → canonical fieldType string used by fillers.
 * @param {number|string} code
 * @returns {string}
 */
export function codeToFieldType(code) {
  const n = Number(code);
  switch (n) {
    case FIELD_TYPE_CODES.DROPDOWN: return 'dropdown';
    case FIELD_TYPE_CODES.RADIO: return 'radio';
    case FIELD_TYPE_CODES.CHECKBOX: return 'checkbox';
    case FIELD_TYPE_CODES.MULTI_CHECKBOX: return 'checkbox-group';
    case FIELD_TYPE_CODES.INPUT:
    default: return 'text';
  }
}

/**
 * Human-readable description for LLM prompts.
 * @param {number|string} code
 * @returns {string}
 */
export function describeFieldTypeCode(code) {
  const n = Number(code) || fieldTypeToCode(String(code));
  const map = {
    1: '1=INPUT (type a number or short text — not Yes/No unless the question is clearly yes/no)',
    2: '2=DROPDOWN (pick one listed option; copy option text exactly)',
    3: '3=RADIO (pick one listed option; copy option text exactly)',
    4: '4=CHECKBOX (Yes/check only when the statement is true for this applicant; otherwise leave unchecked / No)',
    5: '5=MULTI_CHECKBOX (select all options that truly apply; do not select everything)',
  };
  return map[n] || map[1];
}

/**
 * Attach field_type_code onto a discovered question object.
 * @param {object} field
 * @returns {object}
 */
export function enrichFieldWithTypeCode(field = {}) {
  const fieldType = field.fieldType || field.type || 'text';
  const code = field.field_type_code ?? field.fieldTypeCode ?? fieldTypeToCode(fieldType);
  return {
    ...field,
    fieldType,
    type: field.type || fieldType,
    field_type_code: Number(code),
    fieldTypeCode: Number(code),
  };
}
