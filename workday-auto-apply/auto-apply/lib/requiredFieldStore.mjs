/**
 * requiredFieldStore.mjs — Persist required DOM questions for reuse.
 *
 * Flow per required field:
 *   1) Parse from live DOM (Playwright)
 *   2) Store label + field_type_code + options → data/required-fields-db.json
 *      and tenant YAML scanned_questions
 *   3) Answer order: DB/YAML → resume → Apply Wizz + LLM profile analysis
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { normalizeLabel } from './qaStore.mjs';
import { enrichFieldWithTypeCode, fieldTypeToCode, FIELD_TYPE_CODE_LABELS } from './fieldTypeCodes.mjs';
import { saveAnswerToTenantYaml } from './tenantQuestionYaml.mjs';

const STORE_PATH = resolve(process.cwd(), 'data', 'required-fields-db.json');

let cache = null;

async function loadStore() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(STORE_PATH, 'utf-8'));
    cache = {
      version: 1,
      updated_at: raw.updated_at || null,
      fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {},
    };
  } catch {
    cache = { version: 1, updated_at: null, fields: {} };
  }
  return cache;
}

async function saveStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  store.updated_at = new Date().toISOString();
  cache = store;
  await writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  return store;
}

function buildKey(tenant, label) {
  const t = String(tenant || 'global').trim().toLowerCase() || 'global';
  return `${t}::${normalizeLabel(label)}`;
}

/**
 * Persist a required field discovery (and optional answer) to the local DB.
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function storeRequiredField({
  tenant = '',
  company = '',
  step = '',
  jobUrl = '',
  label,
  fieldType = 'text',
  fieldTypeCode = null,
  options = [],
  required = true,
  answer = null,
  answerSource = '',
} = {}) {
  if (!label) return null;
  const enriched = enrichFieldWithTypeCode({ fieldType, field_type_code: fieldTypeCode });
  const store = await loadStore();
  const key = buildKey(tenant, label);
  const prev = store.fields[key] || {};
  const optionList = (options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  store.fields[key] = {
    ...prev,
    tenant: String(tenant || '').trim().toLowerCase() || 'global',
    company: company || prev.company || '',
    step: step || prev.step || '',
    job_url: jobUrl || prev.job_url || '',
    label: String(label).replace(/\s+/g, ' ').trim(),
    normalized: normalizeLabel(label),
    field_type: enriched.fieldType,
    field_type_code: enriched.field_type_code,
    field_type_name: FIELD_TYPE_CODE_LABELS[enriched.field_type_code] || 'input',
    options: optionList.length ? optionList : (prev.options || []),
    required: required !== false,
    answer: answer != null && answer !== '' ? String(answer) : (prev.answer || null),
    answer_source: answerSource || prev.answer_source || '',
    last_seen_at: new Date().toISOString(),
    first_seen_at: prev.first_seen_at || new Date().toISOString(),
  };

  await saveStore(store);

  if (tenant && tenant !== 'unknown' && tenant !== 'global') {
    await saveAnswerToTenantYaml(tenant, {
      label,
      answer: store.fields[key].answer || '',
      fieldType: enriched.fieldType,
      options: optionList,
      step,
      fieldTypeCode: enriched.field_type_code,
    }).catch(() => {});
  }

  return store.fields[key];
}

/**
 * Lookup a previously stored required-field answer.
 * @param {string} label
 * @param {string} [tenant]
 * @returns {Promise<{ answer: string, field_type_code: number, source: string }|null>}
 */
export async function lookupStoredRequiredField(label, tenant = '') {
  if (!label) return null;
  const store = await loadStore();
  const keys = [
    buildKey(tenant, label),
    buildKey('global', label),
  ];
  for (const key of keys) {
    const hit = store.fields[key];
    if (hit?.answer != null && hit.answer !== '') {
      return {
        answer: String(hit.answer),
        field_type_code: hit.field_type_code || fieldTypeToCode(hit.field_type),
        field_type: hit.field_type,
        options: hit.options || [],
        source: 'required_fields_db',
        matchedKey: key,
      };
    }
  }

  // Fuzzy-ish: same normalized label across tenants
  const norm = normalizeLabel(label);
  for (const [key, hit] of Object.entries(store.fields)) {
    if (!hit?.answer) continue;
    if (hit.normalized === norm) {
      return {
        answer: String(hit.answer),
        field_type_code: hit.field_type_code || fieldTypeToCode(hit.field_type),
        field_type: hit.field_type,
        options: hit.options || [],
        source: 'required_fields_db_cross',
        matchedKey: key,
      };
    }
  }
  return null;
}

/**
 * Batch-store required questions discovered on a wizard step.
 * @param {object[]} fields
 * @param {object} meta
 * @returns {Promise<number>} count stored
 */
export async function storeRequiredFieldsBatch(fields = [], meta = {}) {
  let count = 0;
  for (const raw of fields) {
    const field = enrichFieldWithTypeCode(raw);
    if (!field.required && !/\*/.test(String(field.label || ''))) continue;
    await storeRequiredField({
      tenant: meta.tenant || '',
      company: meta.company || '',
      step: meta.step || '',
      jobUrl: meta.jobUrl || '',
      label: field.questionLabel || field.label,
      fieldType: field.fieldType,
      fieldTypeCode: field.field_type_code,
      options: field.options || [],
      required: true,
      answer: field.answer || null,
      answerSource: field.answer_source || '',
    });
    count += 1;
  }
  return count;
}

/** @returns {string} */
export function getRequiredFieldsDbPath() {
  return STORE_PATH;
}

/** @returns {Promise<object>} */
export async function dumpRequiredFieldsStore() {
  return loadStore();
}

export function isRequiredFieldsDbPresent() {
  return existsSync(STORE_PATH);
}
