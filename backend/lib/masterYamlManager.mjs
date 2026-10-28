/**
 * masterYamlManager.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the Universal Question & Answer Reference Bank & Template
 * (backed persistently by Supabase table `qa_bank` and cached in
 * backend/config/master_scan_template.yml).
 *
 * Requirements:
 * 1. Persistent store in Supabase table `qa_bank` so restarts/redeploys never lose data.
 * 2. Uses UPSERT on (tenant, normalized_question) so parallel workers never collide.
 * 3. Keeps master_scan_template.yml updated as an exported local snapshot.
 * 4. Guards scan_placeholder entries: they are NEVER used at submission for
 *    identity, work auth, visa/sponsorship, EEO, veteran, disability, or salary fields.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import YAML from 'yaml';
import { isSupabaseConfigured, request } from './supabaseClient.mjs';

const YAML_PATH = resolve(process.cwd(), 'backend', 'config', 'master_scan_template.yml');

// In-memory lookup cache to prevent redundant DB calls
const QA_BANK_CACHE = new Map();

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
 * Loads the existing questions map from the local YAML cache
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
 * Saves or merges harvested questions from a blueprint scan into Supabase `qa_bank`
 * and updates the Master YAML local snapshot.
 *
 * @param {Array<object>} harvestedQuestions - Array of { question, field_type, step, options, value, source }
 * @param {object} metadata - { company, roleTitle, mockAwlId, jobUrl, tenant }
 */
export async function saveMasterYamlTemplate(harvestedQuestions = [], metadata = {}) {
  if (!Array.isArray(harvestedQuestions) || harvestedQuestions.length === 0) {
    return { added: 0, total: 0 };
  }

  const existingQuestions = getMasterYamlQuestions();
  let addedCount = 0;
  let updatedCount = 0;

  const tenant = String(metadata.tenant || 'global').trim().toLowerCase();
  const dbRows = [];
  const now = new Date().toISOString();

  for (const item of harvestedQuestions) {
    const rawLabel = item.question || item.label || '';
    if (!rawLabel || typeof rawLabel !== 'string') continue;

    const normKey = normalizeQuestionKey(rawLabel);
    if (!normKey) continue;

    const sampleVal = item.value ?? item.answer ?? item.default_answer ?? null;
    const cleanOptions = Array.isArray(item.options)
      ? Array.from(new Set(item.options.map((o) => String(o).trim()).filter(Boolean)))
      : [];
    const source = item.source || 'scan_placeholder';
    const fieldType = item.field_type || item.type || 'text';
    const stepName = item.step || 'Application Questions';

    // Prepare DB row for qa_bank
    dbRows.push({
      tenant,
      normalized_question: normKey,
      field_type: fieldType,
      options: cleanOptions,
      answer: sampleVal ? String(sampleVal).trim() : null,
      source,
      step_name: stepName,
      updated_at: now,
    });

    // Update in-memory lookup cache
    QA_BANK_CACHE.set(`${tenant}:${normKey}`, {
      answer: sampleVal ? String(sampleVal).trim() : null,
      source,
      options: cleanOptions,
      fieldType,
    });

    if (!existingQuestions[normKey]) {
      existingQuestions[normKey] = {
        question: rawLabel.trim(),
        field_type: fieldType,
        step: stepName,
        options: cleanOptions,
        sample_answer: sampleVal ? String(sampleVal).trim() : null,
        source,
        tenant,
        first_seen_company: metadata.company || 'Workday Partner',
        first_seen_role: metadata.roleTitle || 'Application',
        mock_client_id: metadata.mockAwlId || 'AWL-1568',
        created_at: now,
      };
      addedCount++;
    } else {
      const entry = existingQuestions[normKey];
      if (cleanOptions.length > (entry.options?.length || 0)) {
        entry.options = cleanOptions;
        updatedCount++;
      }
      if (!entry.sample_answer && sampleVal) {
        entry.sample_answer = String(sampleVal).trim();
        updatedCount++;
      }
    }
  }

  // 1. Persist to Supabase qa_bank table via UPSERT
  if (isSupabaseConfigured() && dbRows.length > 0) {
    try {
      await request('qa_bank', {
        method: 'POST',
        query: '?on_conflict=tenant,normalized_question',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: dbRows,
      });
      console.log(`🏦 [qa_bank] Persisted ${dbRows.length} questions to Supabase qa_bank table.`);
    } catch (dbErr) {
      console.warn(`⚠️ [qa_bank] Note on saving to qa_bank table: ${dbErr?.message?.slice(0, 140)}`);
    }
  }

  // 2. Export / update local YAML file snapshot
  const outputDoc = {
    title: 'Workday Auto Master Question & Answer Reference Bank',
    description: 'Consolidated, deduplicated form questions, types, and sample answers captured by Blueprint Workers',
    version: '1.0.0',
    last_updated: now,
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
 * Searches qa_bank / master YAML for an answer matching a question label.
 * Enforces Rule A guard: scan_placeholder is NEVER used at submission for protected fields.
 */
export async function findAnswerFromQaBank({
  questionLabel = '',
  options = [],
  tenant = 'global',
  isSubmission = false,
} = {}) {
  if (!questionLabel) return null;
  const normKey = normalizeQuestionKey(questionLabel);
  if (!normKey) return null;

  const cleanTenant = String(tenant || 'global').trim().toLowerCase();

  // Guard against using placeholders for sensitive fields during submission
  const isGuardedField = /authorized to work|authori[sz]ed|work auth|visa|sponsor|veteran|disability|gender|sex|race|ethnicity|hispanic|latino|eeo|salary|compensation|first name|last name|email|phone|social security|ssn/i.test(questionLabel);

  // 1. Check in-memory cache first
  let cached = QA_BANK_CACHE.get(`${cleanTenant}:${normKey}`) || QA_BANK_CACHE.get(`global:${normKey}`);
  if (cached) {
    if (isSubmission && isGuardedField && cached.source === 'scan_placeholder') {
      return null;
    }
    if (cached.answer != null) {
      return matchOptionIfPresent(cached.answer, options);
    }
  }

  // 2. Query Supabase qa_bank
  if (isSupabaseConfigured()) {
    try {
      const rows = await request('qa_bank', {
        query: `?normalized_question=eq.${encodeURIComponent(normKey)}&select=tenant,answer,source,options&limit=2`,
      });
      if (Array.isArray(rows) && rows.length > 0) {
        // Prefer tenant match over global
        const hit = rows.find((r) => r.tenant === cleanTenant) || rows[0];
        if (hit) {
          QA_BANK_CACHE.set(`${hit.tenant}:${normKey}`, hit);
          if (isSubmission && isGuardedField && hit.source === 'scan_placeholder') {
            return null;
          }
          if (hit.answer != null) {
            return matchOptionIfPresent(hit.answer, options);
          }
        }
      }
    } catch {}
  }

  // 3. Fallback to local master YAML file
  const localQuestions = getMasterYamlQuestions();
  const yamlMatch = localQuestions[normKey];
  if (yamlMatch && yamlMatch.sample_answer != null) {
    if (isSubmission && isGuardedField && yamlMatch.source === 'scan_placeholder') {
      return null;
    }
    return matchOptionIfPresent(yamlMatch.sample_answer, options);
  }

  return null;
}

function matchOptionIfPresent(answer, options = []) {
  if (!answer) return null;
  if (Array.isArray(options) && options.length > 0) {
    const found = options.find((o) =>
      String(o).trim().toLowerCase() === String(answer).trim().toLowerCase()
    );
    if (found) return found;
    // Partial/prefix match
    const prefixMatch = options.find((o) =>
      String(o).trim().toLowerCase().startsWith(String(answer).trim().toLowerCase())
    );
    if (prefixMatch) return prefixMatch;
  }
  return answer;
}

export function findAnswerFromMasterYaml(questionLabel = '', options = []) {
  return findAnswerFromQaBank({ questionLabel, options, isSubmission: false });
}
