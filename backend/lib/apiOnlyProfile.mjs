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
  profile.qa_answers = {};
  return profile;
}
