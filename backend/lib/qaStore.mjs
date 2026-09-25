/**
 * qaStore.mjs — Persistent Q&A helpers
 *
 * Canonical Workday store: config/profile.yml → qa_answers (via saveAnswerToYaml).
 * JsonQAStore for session cache. SupabaseQAStore for Production Phase.
 */

import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import yaml from 'js-yaml';
import { fuzzyScore } from './fields.mjs';
import { resolveMinimumAgeAnswer } from './minimumAge.mjs';
import { isApiOnlyAnswerMode } from './apiOnlyProfile.mjs';

export const COMPLIANCE_PATTERNS = [
  /work\s*auth/i,
  /authorized\s*to\s*work/i,
  /legally\s*authorized/i,
  /visa/i,
  /sponsorship/i,
  /require.*sponsor/i,
  /veteran/i,
  /disability/i,
  /\brace\b/i,
  /ethnicity/i,
  /\bgender\b/i,
  /\beeo\b/i,
  /voluntary\s*disclosure/i,
  /government\s*employment/i,
];

export function isComplianceSensitive(label) {
  const text = String(label || '').toLowerCase();
  return COMPLIANCE_PATTERNS.some((re) => re.test(text));
}

const COMPENSATION_RE = /(salary|compensation|pay|wage|remuneration|expected.*(?:salary|pay|comp)|desired.*(?:salary|pay|comp|amount)|annual.*(?:salary|pay|comp)|target.*pay|base\s*pay|hourly\s*(?:rate|wage)|minimum\s+hourly|currency|what\s*is\s*your\s*(?:desired|expected|minimum)\s*(?:salary|compensation|pay|amount|hourly|wage))/i;

/** Salary/compensation questions — labels vary (salary vs compensation vs amount). */
export function isSalaryQuestion(label) {
  return COMPENSATION_RE.test(String(label || ''));
}

/** Hourly wage / per-hour pay — must not use the yearly salary fact. */
export function isHourlyWageQuestion(label = '') {
  return /hourly|per\s*hour|minimum\s+hourly/i.test(String(label || ''));
}

export function isCompensationKey(key) {
  return COMPENSATION_RE.test(String(key || ''));
}

const DEFAULT_COMPENSATION_ANSWER = '1000000';

/**
 * Cross-key lookup: "desired compensation" matches stored "desired salary" answers.
 */
export function lookupSemanticCompensationAnswer(rawLabel, profile = null, tenant = '') {
  if (!isSalaryQuestion(rawLabel)) return null;

  const norm = normalizeLabel(rawLabel);

  if (isHourlyWageQuestion(rawLabel) && profile?.compensation_hourly) {
    return String(profile.compensation_hourly);
  }
  const unwrapComp = (val) => {
    if (val == null) return null;
    if (typeof val === 'object') return val.target || val.amount || val.value || val.annual || null;
    return String(val);
  };
  const compVal = unwrapComp(profile?.compensation) || unwrapComp(profile?.salary) || unwrapComp(profile?.experience?.desired_salary);
  if (compVal && !isHourlyWageQuestion(rawLabel)) return String(compVal);

  let best = null;
  let bestScore = 0;

  const consider = (key, answer) => {
    if (!answer || !isCompensationKey(key)) return;
    const score = fuzzyScore(norm, normalizeLabel(key));
    if (score > bestScore) {
      bestScore = score;
      best = String(answer);
    }
  };

  if (profile?.qa_answers) {
    for (const [key, val] of Object.entries(profile.qa_answers)) {
      consider(key, val);
    }
  }

  if (best && bestScore >= 0.45) return best;

  for (const fallbackKey of ['desired salary', 'desired compensation', 'salary expectation', 'compensation']) {
    const hit = profile?.qa_answers?.[fallbackKey];
    if (hit) return String(hit);
  }

  return DEFAULT_COMPENSATION_ANSWER;
}

/**
 * Cross-source semantic lookup:
 * Apply Wizz API → concept synonyms → tenant YAML → profile qa → compensation DB.
 */
export async function lookupSemanticAnswer(rawLabel, profile = null, tenant = '', { threshold = 0.52 } = {}) {
  const norm = normalizeLabel(rawLabel);
  if (!norm) return null;

  const ageYes = resolveMinimumAgeAnswer(rawLabel, profile);
  if (ageYes) return { answer: ageYes, source: 'minimum_age', score: 1 };

  const isOpenEnded = norm.length > 55
    || /^(briefly|describe|explain|tell us|please explain|why (are|do|would)|cover letter)/i.test(String(rawLabel || '').trim());

  try {
    const { lookupApplyWizzAnswer } = await import('./applyWizzClient.mjs');
    const fromApi = lookupApplyWizzAnswer(rawLabel, profile, { threshold });
    if (fromApi?.answer) return { ...fromApi, source: fromApi.source || 'applywizz' };
  } catch { /* optional module */ }

  // API-only runs may use Apply Wizz, profile facts, and the LLM, but never
  // fall through to tenant YAML or the local Q&A database.
  if (isApiOnlyAnswerMode()) return null;

  try {
    const { resolveByConcept } = await import('./answerConcepts.mjs');
    const fromConcept = resolveByConcept(rawLabel, profile);
    if (fromConcept?.answer) {
      return {
        answer: fromConcept.answer,
        source: fromConcept.source,
        score: 0.95,
        matchedKey: fromConcept.concept,
      };
    }
  } catch { /* optional */ }

  if (isSalaryQuestion(rawLabel)) {
    const comp = lookupSemanticCompensationAnswer(rawLabel, profile, tenant);
    if (comp) return { answer: comp, source: 'semantic_compensation', score: 1 };
  }

  // Essay / open-ended prompts: only concept/exact sources above — no fuzzy YAML reuse.
  if (isOpenEnded) return null;

  if (tenant) {
    try {
      const { lookupTenantAnswer } = await import('./tenantQuestionYaml.mjs');
      const fromTenant = lookupTenantAnswer(tenant, rawLabel, { threshold });
      if (fromTenant) return { answer: fromTenant, source: 'tenant_yaml', score: 1 };
    } catch { /* ignore */ }
  }

  let best = null;
  let bestScore = 0;
  if (profile?.qa_answers) {
    for (const [key, val] of Object.entries(profile.qa_answers)) {
      if (val == null || val === '') continue;
      const score = fuzzyScore(norm, normalizeLabel(key));
      if (score > bestScore) {
        bestScore = score;
        best = { answer: String(val), source: 'profile_qa', score, matchedKey: key };
      }
    }
  }
  if (best && bestScore >= threshold) return best;
  return null;
}

/**
 * Personal skill / years-of-experience facts the LLM must not invent.
 * Policy answers (work auth, relatives, EEO) are not high-risk.
 */
export function isHighRiskPersonalFactQuestion(label) {
  const text = String(label || '');
  if (isSalaryQuestion(text)) return true;
  return /(how many years|years?\s+of\s+(experience|exp)|experience with|proficient (in|with)|expert (in|with)|certified (in|on)|certification|do you have .{0,40}experience|licen[cs]e\s*number|clearance|security\s*clearance|passport|ssn|social\s*security)/i.test(text);
}

export function normalizeLabel(label) {
  if (!label) return '';
  let norm = label
    .toLowerCase()
    .replace(/[^\w\s]/g, '')     // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

  // Spelling-variant normalization (British / American & common Workday terms)
  norm = norm
    .replace(/\bauthoris(ed|ing|ation|e)\b/g, 'authoriz$1')
    .replace(/\borganis(ed|ing|ation|e)\b/g, 'organiz$1')
    .replace(/\brecognis(ed|ing|ation|e)\b/g, 'recogniz$1')
    .replace(/\bsummaris(ed|ing|ation|e)\b/g, 'summariz$1')
    .replace(/\bcolour\b/g, 'color')
    .replace(/\bselect\s+one\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return norm;
}


export function buildScopedLabel(label, tenant = '') {
  const base = normalizeLabel(label);
  if (!tenant) return base;
  const tenantKey = String(tenant).trim().toLowerCase();
  if (!tenantKey || tenantKey === 'unknown') return base;
  return `${tenantKey}::${base}`;
}

export function buildCacheKey(normalizedLabel, tenant = '') {
  return buildScopedLabel(normalizedLabel, tenant);
}

const DEFAULT_STORE_PATH = resolve(process.cwd(), 'data', 'qa-store.json');
const SEED_STORE_PATH = resolve(process.cwd(), 'data', 'qa-store.seed.json');
const DEFAULT_SETTINGS_PATH = resolve(process.cwd(), 'config', 'settings.yml');

let cachedSettings = null;

/**
 * Load matching/runtime settings from config/settings.yml.
 * @returns {Promise<{ fuzzy_threshold: number, max_field_retries: number }>}
 */
export async function loadSettings() {
  if (cachedSettings) return cachedSettings;
  const defaults = { fuzzy_threshold: 0.55, max_field_retries: 3, mutation_observer_debounce_ms: 300 };
  try {
    const content = await fs.readFile(DEFAULT_SETTINGS_PATH, 'utf-8');
    const doc = yaml.load(content) || {};
    cachedSettings = {
      fuzzy_threshold: doc?.matching?.fuzzy_threshold ?? defaults.fuzzy_threshold,
      max_field_retries: doc?.runtime?.max_field_retries ?? defaults.max_field_retries,
      mutation_observer_debounce_ms: doc?.runtime?.mutation_observer_debounce_ms ?? defaults.mutation_observer_debounce_ms,
    };
  } catch {
    cachedSettings = defaults;
  }
  return cachedSettings;
}

/**
 * Fuzzy-match a scanned question against profile qa_answers and JSON store.
 * Checks tenant-scoped entries first, then falls back to global entries.
 * @param {string} rawLabel
 * @param {object} profile
 * @param {JsonQAStore|null} qaStore
 * @param {number} [threshold]
 * @param {string} [tenant]
 * @returns {Promise<{ answer: string, source: string, score: number, matchedKey?: string }|null>}
 */
export async function findBestMatch(rawLabel, profile, qaStore = null, threshold = 0.55, tenant = '') {
  const normalized = normalizeLabel(rawLabel);
  if (!normalized) return null;

  // Cached YAML/LLM "No" must never win on 16+/18+ working-age questions.
  const ageYes = resolveMinimumAgeAnswer(rawLabel, profile);
  if (ageYes) return { answer: ageYes, source: 'minimum_age', score: 1 };

  if (isApiOnlyAnswerMode()) {
    const semantic = isSalaryQuestion(rawLabel)
      ? lookupSemanticCompensationAnswer(rawLabel, profile, tenant)
      : null;
    if (semantic) return { answer: semantic, source: 'applywizz_compensation', score: 1 };
    return null;
  }

  const requiresExactMatch = isSalaryQuestion(rawLabel);
  const exactThreshold = requiresExactMatch ? 1 : threshold;

  if (requiresExactMatch) {
    const semantic = lookupSemanticCompensationAnswer(rawLabel, profile, tenant);
    if (semantic) return { answer: semantic, source: 'semantic_compensation', score: 1 };
  }

  let bestTenant = null;
  let bestTenantScore = 0;
  let bestGlobal = null;
  let bestGlobalScore = 0;

  const considerTenant = (key, answer, source = 'cache') => {
    if (!answer) return;
    const score = fuzzyScore(normalized, normalizeLabel(key));
    if (score > bestTenantScore) {
      bestTenantScore = score;
      bestTenant = { answer: String(answer), source, score, matchedKey: key };
    }
  };

  const considerGlobal = (key, answer, source = 'cache') => {
    if (!answer) return;
    const score = fuzzyScore(normalized, normalizeLabel(key));
    if (score > bestGlobalScore) {
      bestGlobalScore = score;
      bestGlobal = { answer: String(answer), source, score, matchedKey: key };
    }
  };

  if (tenant && profile?.qa_answers) {
    for (const [key, val] of Object.entries(profile.qa_answers)) {
      const scoped = buildScopedLabel(key, tenant);
      if (scoped === buildScopedLabel(normalized, tenant)) {
        considerTenant(key, val, 'profile_tenant');
      }
    }
  }

  if (profile?.qa_answers) {
    for (const [key, val] of Object.entries(profile.qa_answers)) {
      if (!String(key).includes('::')) {
        considerGlobal(key, val, 'profile');
      }
    }
  }

  if (tenant && qaStore?.listEntries) {
    for (const entry of await qaStore.listEntries(tenant)) {
      const entryKey = entry.normalized_label || entry.raw_label || '';
      if (entryKey.startsWith(`${tenant.toLowerCase()}::`)) {
        considerTenant(entryKey, entry.answer, 'store_tenant');
      }
    }
  }

  if (qaStore?.listEntries) {
    for (const entry of await qaStore.listEntries()) {
      const entryKey = entry.normalized_label || entry.raw_label || '';
      if (!String(entryKey).includes('::')) {
        considerGlobal(entryKey, entry.answer, 'store');
      }
    }
  }

  if (bestTenant && bestTenantScore >= exactThreshold) return bestTenant;
  if (bestGlobal && bestGlobalScore >= exactThreshold) return bestGlobal;
  return null;
}

export async function saveAnswerToYaml(rawLabel, answer, profilePath) {
  if (isApiOnlyAnswerMode()) return;
  try {
    const pPath = profilePath || resolve(process.cwd(), 'config', 'profile.yml');
    let content = '';
    try {
      content = await fs.readFile(pPath, 'utf-8');
    } catch {
      return;
    }
    const doc = yaml.load(content) || {};
    if (!doc.qa_answers || typeof doc.qa_answers !== 'object') {
      doc.qa_answers = {};
    }
    const norm = normalizeLabel(rawLabel);
    doc.qa_answers[norm] = answer;
    await fs.writeFile(pPath, yaml.dump(doc, { indent: 2, lineWidth: -1 }), 'utf-8');
    console.log(`    💾 Saved answer for "${rawLabel}" permanently to config/profile.yml`);
  } catch (err) {
    console.log(`    ⚠️  Could not save answer to profile.yml: ${err.message}`);
  }
}

// ─── Local JSON backend (default, single-user) ─────────────────────────────
export class JsonQAStore {
  constructor(storePath = DEFAULT_STORE_PATH, tenant = '') {
    this.storePath = storePath;
    this.tenant = tenant;
  }

  async get(normalizedLabel, tenant = this.tenant) {
    const data = await this._load();
    const scopedKey = buildScopedLabel(normalizedLabel, tenant);
    const globalKey = normalizeLabel(normalizedLabel);
    return data[scopedKey] ?? data[globalKey] ?? null;
  }

  async set(normalizedLabel, entry, tenant = this.tenant) {
    const data = await this._load();
    const scopedKey = buildScopedLabel(normalizedLabel, tenant);
    const globalKey = normalizeLabel(normalizedLabel);

    if (tenant) {
      data[scopedKey] = entry;
    } else {
      data[globalKey] = entry;
    }

    const dir = dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2), 'utf-8');

    if (!tenant && entry.raw_label && entry.answer) {
      await saveAnswerToYaml(entry.raw_label, entry.answer);
    }
  }

  async _loadSeed() {
    try {
      const content = await fs.readFile(SEED_STORE_PATH, 'utf8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async _load() {
    const seed = await this._loadSeed();
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      return { ...seed, ...JSON.parse(content) };
    } catch {
      return seed;
    }
  }

  /** @returns {Promise<Array<{ normalized_label: string, raw_label: string, answer: string }>>} */
  async listEntries(tenant = this.tenant) {
    const data = await this._load();
    return Object.entries(data)
      .filter(([key]) => {
        if (!tenant) return !String(key).includes('::');
        return String(key).startsWith(`${String(tenant).trim().toLowerCase()}::`);
      })
      .map(([normalized_label, entry]) => ({
        normalized_label,
        raw_label: entry?.raw_label || normalized_label,
        answer: typeof entry === 'object' ? entry.answer : String(entry),
      }));
  }
}

// ─── Supabase backend (multi-user, shares dedup cache table) ───────────────
export class SupabaseQAStore {
  constructor(client, table = 'qa_answers', tenant = '') {
    this.client = client;
    this.table = table;
    this.tenant = tenant;
  }

  async get(normalizedLabel, tenant = this.tenant) {
    if (!this.client) return null;
    try {
      const scopedKey = buildScopedLabel(normalizedLabel, tenant);
      const fallbackKey = normalizeLabel(normalizedLabel);
      const { data, error } = await this.client
        .from(this.table)
        .select('answer, raw_label, normalized_label')
        .in('normalized_label', tenant ? [scopedKey, fallbackKey] : [fallbackKey])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    } catch {
      return null;
    }
  }

  async set(normalizedLabel, entry, tenant = this.tenant) {
    if (!this.client) return;
    try {
      await this.client.from(this.table).upsert({
        normalized_label: tenant ? buildScopedLabel(normalizedLabel, tenant) : normalizeLabel(normalizedLabel),
        raw_label: entry.raw_label,
        answer: entry.answer,
        tenant: tenant || null,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Failed to save to Supabase QA store: ${err.message}`);
    }
  }
}

// ─── Factory for selecting QA store backend ────────────────────────────────
export function createQAStore(options = {}) {
  if (process.env.QA_STORE_BACKEND === 'supabase' && options.supabaseClient) {
    return new SupabaseQAStore(options.supabaseClient, options.table || 'qa_answers');
  }
  const storePath = options.storePath || process.env.QA_STORE_PATH || DEFAULT_STORE_PATH;
  return new JsonQAStore(storePath);
}

const DEFAULT_MANUAL_REVIEW_PATH = resolve(process.cwd(), 'data', 'manual-review.json');

let manualReviewWriteQueue = Promise.resolve();

/**
 * Log unverified or invalid fields to the local manual-review queue (data/manual-review.json).
 */
export async function appendManualReviewRecord({
  candidateId = '',
  tenant = '',
  questionLabel = '',
  controlType = '',
  visibleOptions = [],
  tierAttempted = '',
  attemptedValue = '',
  reason = '',
  step = '',
  filePath = null,
} = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    candidate_id: candidateId || process.env.APPLYWIZZ_ID || 'default_candidate',
    workday_tenant: tenant || 'global',
    question_label: questionLabel,
    control_type: controlType,
    visible_options: Array.isArray(visibleOptions) ? visibleOptions : [],
    tier_attempted: tierAttempted || 'none',
    attempted_value: attemptedValue || '',
    reason: reason || 'unresolved',
    step: step || '',
  };

  console.log(`  📋 [MANUAL REVIEW] Logged question to manual review: "${(questionLabel || '').slice(0, 50)}" (${record.workday_tenant})`);

  if (!filePath) {
    return record;
  }

  return manualReviewWriteQueue = manualReviewWriteQueue.then(async () => {
    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      let records = [];
      try {
        const existing = await fs.readFile(filePath, 'utf8');
        records = JSON.parse(existing);
        if (!Array.isArray(records)) records = [];
      } catch {
        records = [];
      }

      const existingIdx = records.findIndex(
        (r) => r.candidate_id === record.candidate_id &&
               r.workday_tenant === record.workday_tenant &&
               r.question_label === record.question_label
      );

      if (existingIdx >= 0) {
        records[existingIdx] = { ...records[existingIdx], ...record, timestamp: new Date().toISOString() };
      } else {
        records.push(record);
      }

      await fs.writeFile(filePath, JSON.stringify(records, null, 2), 'utf8');
    } catch (err) {
      console.error(`  ⚠️  Failed to write manual review record: ${err.message}`);
    }

    return record;
  }).catch(() => record);
}


