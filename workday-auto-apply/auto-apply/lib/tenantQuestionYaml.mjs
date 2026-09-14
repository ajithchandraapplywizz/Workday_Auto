/**
 * tenantQuestionYaml.mjs — Persist per-company scan results in tenant override YAML.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { normalizeLabel } from './qaStore.mjs';
import { fuzzyScore } from './fields.mjs';
import { fieldTypeToCode, FIELD_TYPE_CODE_LABELS } from './fieldTypeCodes.mjs';
import { resolveMinimumAgeAnswer } from './minimumAge.mjs';

const TENANT_DIR = resolve(process.cwd(), 'config', 'tenant-overrides');
const MANIFEST_PATH = resolve(process.cwd(), 'config', 'wd5-tenants.json');

const DEFAULT_FIELD_OVERRIDES = [
  ['how did you hear about us', 'personal.source'],
  ['phone device type', '_static.Mobile'],
  ['have you previously been employed', '_static.No'],
  ['have you ever been employed', '_static.No'],
  ['do you have any relatives', '_static.No'],
  ['do you have a relative', '_static.No'],
  ['are you currently or have you ever worked', '_static.No'],
  ['contract worker or consultant', '_static.No'],
  ['job title', 'experience.current_title'],
  ['company', 'experience.current_company'],
  ['location', 'experience.location'],
  ['from', 'experience.from_date'],
  ['to', 'experience.to_date'],
  ['school or university', 'education.university'],
  ['degree', 'education.degree'],
  ['field of study', 'education.field_of_study_hierarchy'],
  ['city', 'personal.city'],
];

let manifestCache = null;
const tenantDocCache = new Map();

function loadTenantDocSync(tenant) {
  const resolvedTenant = String(tenant || '').trim().toLowerCase();
  if (!resolvedTenant || resolvedTenant === 'unknown') return null;
  const path = getTenantYamlPath(resolvedTenant);
  if (!path || !existsSync(path)) return null;
  try {
    const mtime = readFileSync(path, 'utf-8').length;
    const cached = tenantDocCache.get(resolvedTenant);
    if (cached?.mtimeKey === mtime) return cached.doc;
    const doc = yaml.load(readFileSync(path, 'utf-8')) || {};
    const normalized = {
      ...doc,
      field_overrides: normalizeFieldOverrides(doc.field_overrides || doc.field_map),
      scanned_questions: Array.isArray(doc.scanned_questions) ? doc.scanned_questions : [],
      scan_urls: Array.isArray(doc.scan_urls) ? doc.scan_urls : [],
    };
    tenantDocCache.set(resolvedTenant, { mtimeKey: mtime, doc: normalized });
    return normalized;
  } catch {
    return null;
  }
}

function normalizeTenantQuestionKey(label = '') {
  return String(label || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lookup answer from tenant-only DB (config/tenant-overrides/{tenant}.yml scanned_questions).
 * Never mixes answers across tenants.
 */
/** Optional per-tenant experience overrides (e.g. umiami.yml `experience:` block). */
export function getTenantExperienceOverrides(tenant) {
  const doc = loadTenantDocSync(tenant);
  const exp = doc?.experience;
  if (!exp || typeof exp !== 'object') return null;
  return exp;
}

/** Optional per-tenant personal overrides (e.g. umiami.yml `personal:` block). */
export function getTenantPersonalOverrides(tenant) {
  const doc = loadTenantDocSync(tenant);
  const personal = doc?.personal;
  if (!personal || typeof personal !== 'object') return null;
  return personal;
}

/** Optional per-tenant education overrides (e.g. umiami.yml `education:` block). */
export function getTenantEducationOverrides(tenant) {
  const doc = loadTenantDocSync(tenant);
  const education = doc?.education;
  if (!education || typeof education !== 'object') return null;
  return education;
}

/**
 * Merge tenant-only personal / experience / education blocks into profile (tenant wins).
 * Does not affect other tenants — only runs when a tenant YAML defines these blocks.
 */
export function applyTenantOverridesToProfile(profile, tenant) {
  if (!profile || !tenant) return profile;
  const doc = loadTenantDocSync(tenant);
  if (!doc) return profile;

  if (doc.personal && typeof doc.personal === 'object') {
    profile.personal = { ...(profile.personal || {}), ...doc.personal };
    profile.qa_answers = profile.qa_answers || {};
    for (const [key, val] of Object.entries(doc.personal)) {
      if (val != null && val !== '') profile.qa_answers[key.replace(/_/g, ' ')] = String(val);
    }
    if (doc.personal.state) profile.qa_answers.state = String(doc.personal.state);
    if (doc.personal.city) profile.qa_answers.city = String(doc.personal.city);
  }
  if (doc.experience && typeof doc.experience === 'object') {
    profile.experience = { ...(profile.experience || {}), ...doc.experience };
  }
  if (doc.education && typeof doc.education === 'object') {
    profile.education = { ...(profile.education || {}), ...doc.education };
  }
  return profile;
}

export function lookupTenantAnswer(tenant, label, { threshold = 0.72 } = {}) {
  const ageYes = resolveMinimumAgeAnswer(label);
  if (ageYes) return ageYes;

  const doc = loadTenantDocSync(tenant);
  if (!doc) return null;
  const norm = normalizeTenantQuestionKey(label);
  if (!norm) return null;

  let exact = null;
  for (const q of doc.scanned_questions || []) {
    const qn = normalizeTenantQuestionKey(q.normalized || q.label);
    if (qn === norm) {
      if (q.answer != null && q.answer !== '') return String(q.answer);
      exact = q;
    }
  }

  let best = null;
  let bestScore = 0;
  for (const q of doc.scanned_questions || []) {
    if (q.answer == null || q.answer === '') continue;
    const qn = normalizeTenantQuestionKey(q.normalized || q.label);
    const score = fuzzyScore(norm, qn);
    if (score > bestScore) {
      bestScore = score;
      best = String(q.answer);
    }
  }
  if (best && bestScore >= threshold) return best;
  return exact?.answer != null ? String(exact.answer) : null;
}

function loadManifest() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    manifestCache = { tenants: [] };
  }
  return manifestCache;
}

export function getTenantYamlPath(tenant) {
  const slug = String(tenant || '').trim().toLowerCase();
  if (!slug || slug === 'unknown') return null;
  return resolve(TENANT_DIR, `${slug}.yml`);
}

export function resolveCompanyDisplayName(tenant, companyFromCsv = '') {
  if (companyFromCsv) return companyFromCsv;
  const manifest = loadManifest();
  const hit = (manifest.tenants || []).find((t) => t.slug === tenant);
  return hit?.name || tenant;
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function normalizeFieldOverrides(raw = []) {
  return raw
    .map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return [String(entry[0]), String(entry[1])];
      }
      return null;
    })
    .filter(Boolean);
}

function sanitizeQuestion(q = {}) {
  const label = String(q.label || '').trim();
  if (!label) return null;
  const normalized = q.normalized || normalizeLabel(label);
  const options = [...new Set((q.options || []).map((o) => String(o || '').trim()).filter(Boolean))];
  const fieldType = q.fieldType || 'input';
  const code = q.field_type_code ?? q.fieldTypeCode ?? fieldTypeToCode(fieldType);
  return {
    label,
    normalized,
    fieldType,
    field_type_code: Number(code),
    field_type_name: FIELD_TYPE_CODE_LABELS[Number(code)] || 'input',
    required: Boolean(q.required),
    step: q.step || '',
    options,
    answer: q.answer ?? null,
    last_seen_at: q.last_seen_at || new Date().toISOString(),
  };
}

function mergeQuestion(prev, next) {
  const base = sanitizeQuestion(next);
  if (!prev) return base;
  const mergedOptions = [...new Set([...(prev.options || []), ...(base.options || [])])];
  return {
    label: base.label || prev.label,
    normalized: prev.normalized || base.normalized,
    fieldType: base.fieldType || prev.fieldType,
    field_type_code: base.field_type_code ?? prev.field_type_code,
    field_type_name: base.field_type_name || prev.field_type_name,
    required: base.required ?? prev.required,
    step: base.step || prev.step,
    options: mergedOptions,
    answer: (base.answer != null && base.answer !== '') ? base.answer : (prev.answer ?? null),
    last_seen_at: base.last_seen_at || prev.last_seen_at,
  };
}

async function loadTenantDoc(tenant) {
  const path = getTenantYamlPath(tenant);
  if (!path || !existsSync(path)) {
    return {
      field_overrides: DEFAULT_FIELD_OVERRIDES.map((e) => [...e]),
      scanned_questions: [],
      scan_urls: [],
    };
  }
  const text = await readFile(path, 'utf-8');
  const doc = yaml.load(text) || {};
  return {
    ...doc,
    field_overrides: normalizeFieldOverrides(doc.field_overrides || doc.field_map),
    scanned_questions: Array.isArray(doc.scanned_questions) ? doc.scanned_questions : [],
    scan_urls: Array.isArray(doc.scan_urls) ? doc.scan_urls : [],
  };
}

function tenantHeaderComment(displayName, tenant, scanUrls = []) {
  const hosts = [];
  const seen = new Set();
  for (const raw of scanUrls) {
    try {
      const host = new URL(String(raw)).hostname.toLowerCase();
      if (host && !seen.has(host)) {
        seen.add(host);
        hosts.push(host);
      }
    } catch { /* skip bad URL */ }
  }
  if (hosts.length) {
    return `# ${displayName} — YAML shared for tenant "${tenant}" on ${hosts.join(', ')}\n`;
  }
  return `# ${displayName} — YAML keyed by tenant slug "${tenant}" (any wd* platform)\n`;
}

function buildTenantYamlText(doc, displayName, tenant) {
  let out = tenantHeaderComment(displayName, tenant, doc.scan_urls || []);
  out += `company: ${yamlQuote(doc.company || displayName)}\n`;
  out += `tenant: ${tenant}\n`;
  if (doc.last_scanned_at) out += `last_scanned_at: ${doc.last_scanned_at}\n`;

  const urls = doc.scan_urls || [];
  if (urls.length > 0) {
    out += 'scan_urls:\n';
    for (const url of urls) out += `  - ${yamlQuote(url)}\n`;
  }

  out += 'field_overrides:\n';
  const overrides = doc.field_overrides?.length ? doc.field_overrides : DEFAULT_FIELD_OVERRIDES;
  for (const [pattern, path] of overrides) {
    out += `  - [${yamlQuote(pattern)}, ${yamlQuote(path)}]\n`;
  }

  const questions = (doc.scanned_questions || []).filter((q) => q?.label);
  if (questions.length > 0) {
    out += 'scanned_questions:\n';
    for (const q of questions) {
      out += `  - label: ${yamlQuote(q.label)}\n`;
      out += `    normalized: ${yamlQuote(q.normalized || normalizeLabel(q.label))}\n`;
      out += `    fieldType: ${yamlQuote(q.fieldType || 'input')}\n`;
      if (q.field_type_code != null) out += `    field_type_code: ${Number(q.field_type_code)}\n`;
      out += `    required: ${q.required ? 'true' : 'false'}\n`;
      if (q.step) out += `    step: ${yamlQuote(q.step)}\n`;
      if (q.options?.length) {
        out += '    options:\n';
        for (const opt of q.options) out += `      - ${yamlQuote(opt)}\n`;
      }
      if (q.answer != null && q.answer !== '') {
        out += `    answer: ${yamlQuote(q.answer)}\n`;
      }
      if (q.last_seen_at) out += `    last_seen_at: ${q.last_seen_at}\n`;
    }
  }

  return `${out.trimEnd()}\n`;
}

/**
 * Merge harvested questions into config/tenant-overrides/{tenant}.yml
 * @returns {Promise<{ path: string, added: number, total: number } | null>}
 */
export async function saveQuestionsToTenantYaml({
  tenant,
  company = '',
  url = '',
  questions = [],
  scanned_at = new Date().toISOString(),
} = {}) {
  const resolvedTenant = String(tenant || '').trim().toLowerCase();
  if (!resolvedTenant || resolvedTenant === 'unknown') return null;

  const path = getTenantYamlPath(resolvedTenant);
  await mkdir(TENANT_DIR, { recursive: true });

  const doc = await loadTenantDoc(resolvedTenant);
  const displayName = resolveCompanyDisplayName(resolvedTenant, company);

  doc.company = displayName;
  doc.tenant = resolvedTenant;
  doc.last_scanned_at = scanned_at;

  const urlSet = new Set(doc.scan_urls || []);
  if (url) urlSet.add(url);
  doc.scan_urls = [...urlSet];

  const byNorm = new Map();
  for (const q of doc.scanned_questions || []) {
    const clean = sanitizeQuestion(q);
    if (clean) byNorm.set(clean.normalized, clean);
  }

  let added = 0;
  for (const q of questions) {
    const clean = sanitizeQuestion(q);
    if (!clean) continue;
    const prev = byNorm.get(clean.normalized);
    if (!prev) added++;
    byNorm.set(clean.normalized, mergeQuestion(prev, clean));
  }

  doc.scanned_questions = [...byNorm.values()].sort((a, b) => a.label.localeCompare(b.label));

  const text = buildTenantYamlText(doc, displayName, resolvedTenant);
  await writeFile(path, text, 'utf-8');
  tenantDocCache.delete(resolvedTenant);

  return {
    path,
    added,
    total: doc.scanned_questions.length,
  };
}

/**
 * Save a single terminal answer into the tenant YAML scanned_questions entry.
 */
export async function saveAnswerToTenantYaml(tenant, {
  label,
  answer,
  fieldType = 'input',
  options = [],
  step = '',
  fieldTypeCode = null,
} = {}) {
  const resolvedTenant = String(tenant || '').trim().toLowerCase();
  if (!resolvedTenant || resolvedTenant === 'unknown' || !label) return null;

  const path = getTenantYamlPath(resolvedTenant);
  await mkdir(TENANT_DIR, { recursive: true });

  const doc = await loadTenantDoc(resolvedTenant);
  const norm = normalizeLabel(label);
  const byNorm = new Map();
  for (const q of doc.scanned_questions || []) {
    const clean = sanitizeQuestion(q);
    if (clean) byNorm.set(clean.normalized, clean);
  }

  const code = fieldTypeCode ?? fieldTypeToCode(fieldType);
  const prev = byNorm.get(norm) || sanitizeQuestion({ label, fieldType, options, step, field_type_code: code });
  byNorm.set(norm, mergeQuestion(prev, {
    label,
    normalized: norm,
    fieldType,
    field_type_code: code,
    options,
    step,
    answer,
    last_seen_at: new Date().toISOString(),
  }));

  doc.scanned_questions = [...byNorm.values()].sort((a, b) => a.label.localeCompare(b.label));
  const displayName = doc.company || resolveCompanyDisplayName(resolvedTenant);
  const text = buildTenantYamlText(doc, displayName, resolvedTenant);
  await writeFile(path, text, 'utf-8');
  tenantDocCache.delete(resolvedTenant);
  return { path, normalized: norm };
}

/**
 * List unanswered questions from all tenant YAML files.
 */
export async function listPendingTenantQuestions(profile = null) {
  const { readdir } = await import('fs/promises');
  const { findBestMatch, createQAStore, loadSettings } = await import('./qaStore.mjs');
  const { loadProfile } = await import('./planner.mjs');

  const prof = profile || await loadProfile().catch(() => ({}));
  const store = createQAStore();
  const settings = await loadSettings();

  const files = (await readdir(TENANT_DIR)).filter((f) => f.endsWith('.yml'));
  const pending = [];

  for (const file of files) {
    const tenant = file.replace(/\.yml$/i, '');
    const doc = await loadTenantDoc(tenant);
    for (const q of doc.scanned_questions || []) {
      if (q.answer != null && q.answer !== '') continue;
      const match = await findBestMatch(q.label, prof, store, settings.fuzzy_threshold);
      if (match?.answer) continue;
      pending.push({
        tenant,
        company: doc.company || tenant,
        ...q,
      });
    }
  }

  pending.sort((a, b) => a.company.localeCompare(b.company) || a.label.localeCompare(b.label));
  return pending;
}
