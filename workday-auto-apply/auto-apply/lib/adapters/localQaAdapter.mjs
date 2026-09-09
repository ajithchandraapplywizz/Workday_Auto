/**
 * localQaAdapter.mjs — Local Phase Q&A store adapter (YAML + JSON)
 */

import { createQAStore, findBestMatch, loadSettings, saveAnswerToYaml, normalizeLabel } from '../qaStore.mjs';

export function createLocalQaAdapter(options = {}) {
  const store = createQAStore(options);
  return {
    async findBestMatch(userId, question, profile) {
      const settings = await loadSettings();
      return findBestMatch(question, profile, store, settings.fuzzy_threshold);
    },
    async saveAnswer(userId, question, answer, metadata = {}) {
      const norm = metadata.normalized_label || normalizeLabel(question);
      await store.set(norm || question, {
        normalized_label: norm,
        raw_label: metadata.raw_label || question,
        answer,
        source: metadata.source || 'user_provided',
        compliance_sensitive: metadata.compliance_sensitive || false,
      });
      await saveAnswerToYaml(metadata.raw_label || question, answer);
    },
    store,
  };
}
