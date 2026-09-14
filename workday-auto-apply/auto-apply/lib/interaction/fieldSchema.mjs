/**
 * fieldSchema.mjs — Normalize discovered Workday controls into one object.
 * Playwright interaction uses this shape. The LLM never receives locators to click.
 */

import { fieldTypeToCode, codeToFieldType } from '../fieldTypeCodes.mjs';
import { normalizeLabel } from '../qaStore.mjs';
import { inferWidgetKind, isSelectOnePlaceholder } from './workdayCustomDropdown.mjs';

const ELEMENT_TYPES = new Set([
  'text', 'textarea', 'email', 'tel', 'number', 'date',
  'select', 'combobox', 'radio', 'checkbox', 'multi-checkbox',
  'file', 'button', 'custom-dropdown', 'custom-combobox', 'unknown',
]);

/**
 * @param {string} fieldType
 * @param {object} [raw]
 */
export function mapElementType(fieldType = '', raw = {}) {
  const t = String(fieldType || raw.fieldType || raw.type || raw.inputType || '').toLowerCase();
  if (/file|upload|resume|cv/.test(t) && /file/.test(t)) return 'file';
  if (/textarea/.test(t)) return 'textarea';
  if (/email/.test(t)) return 'email';
  if (/tel|phone/.test(t)) return 'tel';
  if (/number|spin|numeric/.test(t) && !/date/.test(t)) return 'number';
  if (/date|monthyear|year/.test(t)) return 'date';
  if (/checkbox-group|multi.?check|select all that apply/.test(t)) return 'multi-checkbox';
  if (/^checkbox$/.test(t)) return 'checkbox';
  if (/radio/.test(t)) return 'radio';
  if (/select-one|native.?select|^select$/.test(t) && raw.nativeSelect) return 'select';
  if (/combobox|typeahead|searchable/.test(t)) return 'custom-combobox';
  if (/dropdown|select/.test(t)) return 'custom-dropdown';
  if (/button/.test(t)) return 'button';
  if (/text|input/.test(t)) return 'text';
  return ELEMENT_TYPES.has(t) ? t : 'unknown';
}

function optionTexts(raw = {}) {
  return (raw.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text || o?.value || ''))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stableQuestionId(raw = {}, label = '') {
  if (raw.wdQId) return String(raw.wdQId);
  if (raw.questionId) return String(raw.questionId);
  const norm = normalizeLabel(label).replace(/\s+/g, '-').slice(0, 48);
  return norm ? `q-${norm}` : `q-unknown`;
}

/**
 * Convert a discovered Workday field into the standard interaction object.
 * Keeps `_raw` so existing fillers can still use wdQId / selectOneIndex.
 * @param {object} raw
 * @param {{ pageNumber?: number, stepName?: string }} [meta]
 */
export function normalizeDiscoveredField(raw = {}, meta = {}) {
  const label = String(raw.questionLabel || raw.label || raw.id || raw.name || '')
    .replace(/\s+/g, ' ')
    .trim();
  const fieldType = raw.fieldType || raw.type || '';
  const elementType = mapElementType(fieldType, raw);
  const options = optionTexts(raw);
  const questionId = stableQuestionId(raw, label);
  const widgetKind = inferWidgetKind({ ...raw, fieldType, nativeSelect: raw.nativeSelect });
  const currentValue = raw.currentValue ?? raw.value ?? null;

  return {
    questionId,
    label,
    description: String(raw.placeholder || raw.description || raw.helpText || '').trim(),
    elementType,
    controlType: elementType,
    fieldType: fieldType || codeToFieldType(fieldTypeToCode(elementType)),
    field_type_code: raw.field_type_code || fieldTypeToCode(fieldType || elementType),
    required: raw.required === true || raw.hasRequiredMarker === true || /\*/.test(label),
    options,
    optionsNeedOpen: options.length === 0 && /dropdown|combobox|select/i.test(elementType),
    widgetKind,
    triggerRole: raw.triggerRole || (widgetKind === 'aria-combobox' ? 'combobox' : widgetKind === 'native-select' ? 'select' : 'button'),
    currentValue: isSelectOnePlaceholder(currentValue) ? null : currentValue,
    disabled: raw.disabled === true,
    visible: raw.visible !== false,
    pageNumber: meta.pageNumber ?? raw.pageNumber ?? 1,
    stepName: meta.stepName || raw.stepName || '',
    locatorStrategy: {
      preferred: raw.wdQId ? 'data-wd-q-id' : 'role+label',
      fallbacks: ['getByLabel', 'aria', 'data-automation-id', 'dom-relationship'],
    },
    wdQId: raw.wdQId || null,
    selectOneIndex: raw.selectOneIndex ?? null,
    formFieldIndex: raw.formFieldIndex ?? null,
    _raw: raw,
  };
}

/**
 * @param {object[]} raws
 * @param {{ pageNumber?: number, stepName?: string }} [meta]
 */
export function normalizeDiscoveredFields(raws = [], meta = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of raws) {
    const field = normalizeDiscoveredField(raw, meta);
    if (!field.label || seen.has(field.questionId)) continue;
    seen.add(field.questionId);
    out.push(field);
  }
  return out;
}

export { ELEMENT_TYPES };
