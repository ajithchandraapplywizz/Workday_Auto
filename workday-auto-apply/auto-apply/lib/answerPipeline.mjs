/**
 * answerPipeline.mjs — Required-field answer resolution with field-type codes.
 *
 * Order:
 *   1) Apply Wizz API (DOM question → indexed client payload)
 *   2) LLM analyses that same client profile and picks the closest live option
 *
 * Field type codes passed to LLM:
 *   1=input  2=dropdown  3=radio  4=checkbox  5=multi_checkbox
 */

import { enrichFieldWithTypeCode, fieldTypeToCode } from './fieldTypeCodes.mjs';
import { storeRequiredField } from './requiredFieldStore.mjs';
import { createQAStore, normalizeLabel } from './qaStore.mjs';
import { resolveClientAnswer } from './clientAnswer.mjs';
import { isOpenRouterEnabled } from './openRouterLlm.mjs';

/**
 * Resolve an answer for a required DOM field.
 * @param {object} field — discovered question (label, fieldType, options, required)
 * @param {object} profile
 * @param {object} [opts]
 * @returns {Promise<{ answer: string, source: string, field_type_code: number }|null>}
 */
export async function resolveRequiredFieldAnswer(field = {}, profile = {}, opts = {}) {
  const enriched = enrichFieldWithTypeCode(field);
  const label = String(enriched.questionLabel || enriched.label || '').replace(/\s+/g, ' ').trim();
  if (!label) return null;

  const tenant = opts.tenant || profile._tenant || '';
  const fieldType = enriched.fieldType || 'text';
  const code = enriched.field_type_code || fieldTypeToCode(fieldType);
  const options = (enriched.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const resolved = await resolveClientAnswer(enriched, profile, {
    page: opts.page,
    plan: opts.plan,
    tenant,
    company: opts.company || profile._company || '',
    step: opts.step,
    required: true,
    forceLlm: true,
    options,
    fieldType,
  });

  if (resolved?.answer) {
    await storeRequiredField({
      tenant,
      company: profile._company || opts.company || '',
      step: opts.step || profile._currentStep || '',
      jobUrl: opts.jobUrl || profile._jobUrl || '',
      label,
      fieldType,
      fieldTypeCode: code,
      options,
      required: true,
      answer: resolved.answer,
      answerSource: resolved.source,
    }).catch(() => {});
    return {
      answer: resolved.answer,
      source: resolved.source,
      field_type_code: code,
      field_type: fieldType,
    };
  }

  // Offline fallback store still records the question shell for later.
  await storeRequiredField({
    tenant,
    company: profile._company || '',
    step: opts.step || '',
    jobUrl: opts.jobUrl || profile._jobUrl || '',
    label,
    fieldType,
    fieldTypeCode: code,
    options,
    required: true,
  }).catch(() => {});

  return null;
}

/**
 * Snapshot required DOM questions into DB (no answering).
 * @param {import('playwright').Page} page
 * @param {object} meta
 */
export async function parseAndStoreRequiredDomFields(page, meta = {}) {
  const { discoverFormFieldQuestions } = await import('./workdayDom.mjs');
  const questions = await discoverFormFieldQuestions(page);
  const required = questions
    .map((q) => enrichFieldWithTypeCode(q))
    .filter((q) => q.required || /\*/.test(String(q.label || '')));

  const count = await storeRequiredFieldsSafe(required, meta);
  console.log(`  💾 Stored ${count} required DOM field(s) → data/required-fields-db.json (codes 1–5)`);
  return { questions, required, stored: count };
}

async function storeRequiredFieldsSafe(fields, meta) {
  const { storeRequiredFieldsBatch } = await import('./requiredFieldStore.mjs');
  return storeRequiredFieldsBatch(fields, meta);
}

export { createQAStore, normalizeLabel, isOpenRouterEnabled };
