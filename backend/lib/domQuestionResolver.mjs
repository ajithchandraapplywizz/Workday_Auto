/**
 * domQuestionResolver.mjs — Playwright DOM question → answer pipeline.
 *
 * Flow (simple):
 *   1. Playwright discovers label + field type + live options on the page
 *   2. Match label to Apply Wizz API client payload (bootstrap fetch, once per run)
 *   3. If no API hit → planner.resolveField (YAML/profile/resume)
 *   4. If still empty → LLM analyses full user profile from API + YAML
 */

import { resolveDomQuestionFromApplyWizz, stripWorkdayQuestionLabel } from './applyWizzClient.mjs';
import { enrichFieldWithTypeCode } from './fieldTypeCodes.mjs';

function fieldOptions(field = {}) {
  return (field.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Resolve one Workday question using Apply Wizz API first.
 * Uses every DOM text signal we scanned (label, candidates, container, element).
 * @param {string} questionLabel
 * @param {object} field — discovered DOM field
 * @param {object} profile — must be hydrated via bootstrapClientContext
 * @param {{ page?: import('playwright').Page }} [opts]
 * @returns {Promise<{ answer: string, source: string }|null>}
 */
export async function resolveFromApplyWizzForDomQuestion(questionLabel, field = {}, profile = {}, opts = {}) {
  const label = stripWorkdayQuestionLabel(questionLabel || field.label || field.questionLabel || '');
  if (!label) return null;

  const enriched = enrichFieldWithTypeCode(field);
  let options = fieldOptions(enriched);

  if (!options.length && opts.page && /dropdown|select|combobox|radio|checkbox/i.test(String(enriched.fieldType || ''))) {
    const { collectLiveFieldOptions } = await import('./workdayDom.mjs');
    options = await collectLiveFieldOptions(opts.page, label, enriched.fieldType).catch(() => []);
  }

  const extraTexts = [
    ...(Array.isArray(field.labelCandidates) ? field.labelCandidates : []),
    field.containerText || '',
    field.elementText || '',
    field.placeholder || '',
  ].filter(Boolean);

  const hit = resolveDomQuestionFromApplyWizz(label, profile, {
    options,
    fieldType: enriched.fieldType || enriched.type || '',
    threshold: 0.48,
    extraTexts,
  });

  if (hit?.answer) {
    return { answer: String(hit.answer), source: hit.source || 'applywizz' };
  }
  return null;
}
