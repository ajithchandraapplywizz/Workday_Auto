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

/** Salary/compensation questions must never be guessed from profile, resume, or fuzzy cache. */
export function isSalaryQuestion(label) {
  return /(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(String(label || ''));
}

export function normalizeLabel(label) {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/[^\w\s]/g, '')     // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
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

  const requiresExactMatch = /(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(rawLabel);
  const exactThreshold = requiresExactMatch ? 1 : threshold;

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

  async _load() {
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return {};
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
