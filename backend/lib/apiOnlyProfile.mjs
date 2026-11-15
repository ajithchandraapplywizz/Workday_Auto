/**
 * apiOnlyProfile.mjs — Answer sources: Apply Wizz API → resume parse → LLM only.
 *
 * Local profile.yml qa_answers, qa-store.json, llm-qa-store, and tenant YAML
 * caches are never used as answer storage. Supabase client_answers is the
 * durable answer store; Apply Wizz and LLM remain optional upstream sources.
 */

import { isApplyWizzConfigured } from './applyWizzClient.mjs';

/**
 * @returns {boolean}
 */
export function isApiOnlyAnswerMode() {
  return true;
}

/**
 * Empty local Q&A overlays so fuzzy/YAML paths stay inert.
 * @param {object} profile
 */
export function applyApiOnlyProfileGuards(profile = {}) {
  if (!isApiOnlyAnswerMode()) return profile;
  profile._apiOnlyMode = true;
  const hasPreResolved = Boolean(
    (profile._resolvedAnswersJson && profile._resolvedAnswersJson.length > 0) ||
    (profile._resolvedAnswersMap && profile._resolvedAnswersMap.size > 0) ||
    (profile.resolved_answers && (Array.isArray(profile.resolved_answers) ? profile.resolved_answers.length > 0 : Object.keys(profile.resolved_answers).length > 0))
  );
  if (!hasPreResolved) {
    profile.qa_answers = {};
  }
  return profile;
}
