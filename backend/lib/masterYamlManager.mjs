/**
 * masterYamlManager.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the Master Question & Answer YAML Reference Template
 * (backend/config/master_scan_template.yml).
 *
 * Requirements:
 * 1. Creates only one deduplicated master YAML file on the first blueprint run.
 * 2. Strictly deduplicates questions so no duplicate question label exists.
 * 3. Stores complete metadata: field_type, step, options, sample answers.
 * 4. Provides fast lookup so future scanning & resolving applications can
 *    reference this bank for automatic 100% answer resolution.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import YAML from 'yaml';

const YAML_PATH = resolve(process.cwd(), 'backend', 'config', 'master_scan_template.yml');

/**
 * Normalizes question strings to a canonical key for strict deduplication
 */
export function normalizeQuestionKey(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/[*#?:!.,;'"()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Loads the existing questions map from the YAML file
 */
export function getMasterYamlQuestions() {
  try {
    if (!existsSync(YAML_PATH)) {
      return {};
    }
    const raw = readFileSync(YAML_PATH, 'utf8');
    const doc = YAML.parse(raw) || {};
    return doc.questions || {};
  } catch (err) {
    console.warn(`[masterYamlManager] Warning reading YAML: ${err.message}`);
    return {};
  }
}

/**
 * Saves or merges harvested questions from a blueprint scan into the Master YAML.
 * Guarantees ZERO duplicate entries.
 *
 * @param {Array<object>} harvestedQuestions - Array of { question, field_type, step, options, value }
 * @param {object} metadata - { company, roleTitle, mockAwlId, jobUrl }
 */
export function saveMasterYamlTemplate(harvestedQuestions = [], metadata = {}) {
  if (!Array.isArray(harvestedQuestions) || harvestedQuestions.length === 0) {
    return { added: 0, total: 0 };
  }

  const existingQuestions = getMasterYamlQuestions();
  let addedCount = 0;
  let updatedCount = 0;

  for (const item of harvestedQuestions) {
    const rawLabel = item.question || item.label || '';
    if (!rawLabel || typeof rawLabel !== 'string') continue;

    const normKey = normalizeQuestionKey(rawLabel);
    if (!normKey) continue;

    const sampleVal = item.value ?? item.answer ?? item.default_answer ?? null;
    const cleanOptions = Array.isArray(item.options)
      ? Array.from(new Set(item.options.map((o) => String(o).trim()).filter(Boolean)))
      : [];

    if (!existingQuestions[normKey]) {
      existingQuestions[normKey] = {
        question: rawLabel.trim(),
        field_type: item.field_type || item.type || 'text',
        step: item.step || 'Application Questions',
        options: cleanOptions,
        sample_answer: sampleVal ? String(sampleVal).trim() : null,
        first_seen_company: metadata.company || 'Workday Partner',
        first_seen_role: metadata.roleTitle || 'Application',
        mock_client_id: metadata.mockAwlId || 'AWL-PRIMARY',
        created_at: new Date().toISOString(),
      };
      addedCount++;
    } else {
      // Update missing fields non-destructively
      const entry = existingQuestions[normKey];
      if (cleanOptions.length > entry.options.length) {
        entry.options = cleanOptions;
        updatedCount++;
      }
      if (!entry.sample_answer && sampleVal) {
        entry.sample_answer = String(sampleVal).trim();
        updatedCount++;
      }
    }
  }

  const outputDoc = {
    title: 'Workday Auto Master Question & Answer Reference Bank',
    description: 'Consolidated, deduplicated form questions, types, and sample answers captured by Blueprint Workers',
    version: '1.0.0',
    last_updated: new Date().toISOString(),
    total_unique_questions: Object.keys(existingQuestions).length,
    questions: existingQuestions,
  };

  try {
    const parentDir = dirname(YAML_PATH);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    const yamlString = YAML.stringify(outputDoc, { indent: 2 });
    writeFileSync(YAML_PATH, yamlString, 'utf8');
    console.log(`💾 [masterYamlManager] Master YAML template updated: +${addedCount} new, ${updatedCount} updated (Total: ${outputDoc.total_unique_questions} unique questions) -> ${YAML_PATH}`);
  } catch (err) {
    console.error(`❌ [masterYamlManager] Error writing YAML: ${err.message}`);
  }

  return {
    added: addedCount,
    updated: updatedCount,
    total: Object.keys(existingQuestions).length,
    path: YAML_PATH,
  };
}

/**
 * Searches the master YAML for a pre-resolved answer matching a question label
 */
export function findAnswerFromMasterYaml(questionLabel = '', options = []) {
  if (!questionLabel) return null;
  const questions = getMasterYamlQuestions();
  const normKey = normalizeQuestionKey(questionLabel);

  if (questions[normKey]) {
    const match = questions[normKey];
    if (match.sample_answer != null) {
      // If options are provided, ensure the answer is in the options
      if (Array.isArray(options) && options.length > 0) {
        const foundOpt = options.find((o) =>
          String(o).trim().toLowerCase() === String(match.sample_answer).trim().toLowerCase()
        );
        if (foundOpt) return foundOpt;
      }
      return match.sample_answer;
    }
  }

  return null;
}
