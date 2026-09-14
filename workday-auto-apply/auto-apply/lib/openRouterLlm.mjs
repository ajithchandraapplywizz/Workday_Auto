/**
 * openRouterLlm.mjs — Unknown-field answers via OpenRouter (Gemini Flash).
 *
 * Lookup order: data/llm-qa-store.json → OpenRouter API → persist for reuse.
 * Never logs the API key.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import yaml from 'js-yaml';
import {
  isComplianceSensitive,
  isHighRiskPersonalFactQuestion,
  isSalaryQuestion,
  lookupSemanticAnswer,
  lookupSemanticCompensationAnswer,
  normalizeLabel,
} from './qaStore.mjs';
import { fuzzyScore } from './fields.mjs';
import { pickCompensationFromOptions } from './compensationPick.mjs';
import {
  resolveExperienceQuestionAnswer,
  sanitizeExperienceAnswer,
  isYearsQuantityQuestion,
  isDescribeExperienceQuestion,
  buildExperienceContext,
  isInvalidYearsAnswer,
  profileBackedEssay,
} from './experienceAnswer.mjs';
import { extractYesNoAnswer, isYesNoQuestionLabel, lookupSensitiveSafeAnswer } from './workdayDefaults.mjs';
import { fieldTypeToCode, describeFieldTypeCode } from './fieldTypeCodes.mjs';
import { parseMonthYear, parseYear } from './experienceDates.mjs';
import { httpsJsonWithRetry } from './httpClient.mjs';

/**
 * True for free-text / numeric input controls (not dropdown/radio with options).
 * @param {string} fieldType
 * @param {string[]} options
 * @returns {boolean}
 */
export function isInputLikeField(fieldType = '', options = []) {
  if (Array.isArray(options) && options.length > 0) return false;
  const t = String(fieldType || '').toLowerCase();
  if (!t || /text|input|textarea|number|spin|numeric|tel|email|url|search/.test(t)) return true;
  if (/dropdown|select|combobox|radio|checkbox/.test(t)) return false;
  return true;
}

const STORE_PATH = resolve(process.cwd(), 'data', 'llm-qa-store.json');
const PROFILE_PATH = resolve(process.cwd(), 'config', 'profile.yml');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

let storeCache = null;

function getApiKey() {
  return String(process.env.OPENROUTER_API_KEY || '').trim();
}

function getModel() {
  return String(process.env.OPENROUTER_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

export function isOpenRouterEnabled() {
  return Boolean(getApiKey());
}

async function openRouterChat({ messages, temperature = 0.1, max_tokens = 400, timeoutMs = 45000 } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  const res = await httpsJsonWithRetry({
    url: OPENROUTER_URL,
    method: 'POST',
    timeoutMs,
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://local.workday-auto-apply',
      'X-Title': 'workday-auto-apply',
    },
    body: {
      model: getModel(),
      temperature,
      max_tokens,
      messages,
    },
  }, { attempts: 2, label: 'OpenRouter' });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${String(res.text || '').slice(0, 180)}`);
  return res.json();
}

/** Fully automatic apply: no form-answer or stuck-step terminal pauses. */
export function isAutoApplyMode() {
  if (process.env.FORM_ANSWER_TERMINAL === '1') return false;
  if (process.env.OPENROUTER_FALLBACK_TERMINAL === '1') return false;
  if (process.env.OPENROUTER_ASK_SUBMIT === '1') return false;
  return true;
}

async function loadStore() {
  if (storeCache) return storeCache;
  try {
    const raw = JSON.parse(await readFile(STORE_PATH, 'utf-8'));
    storeCache = raw && typeof raw === 'object'
      ? { answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {} }
      : { answers: {} };
  } catch {
    storeCache = { answers: {} };
  }
  return storeCache;
}

async function persistStore() {
  const store = await loadStore();
  store.updated_at = new Date().toISOString();
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Reuse a previously LLM-answered question (generic file, all companies).
 */
export async function lookupLlmAnswer(label, { threshold = 0.88 } = {}) {
  await loadStore();
  return lookupLlmAnswerSync(label, { threshold });
}

/** Sync cache read for DOM peek (no API call). */
export function lookupLlmAnswerSync(label, { threshold = 0.88 } = {}) {
  const norm = normalizeLabel(label);
  if (!norm) return null;
  let store = storeCache;
  if (!store) {
    try {
      const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      store = { answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {} };
      storeCache = store;
    } catch {
      return null;
    }
  }
  const exact = store.answers[norm];
  if (exact?.answer) return String(exact.answer);

  let best = null;
  let bestScore = 0;
  for (const [key, entry] of Object.entries(store.answers || {})) {
    if (!entry?.answer) continue;
    const score = fuzzyScore(norm, key);
    if (score > bestScore) {
      bestScore = score;
      best = String(entry.answer);
    }
  }
  if (best && bestScore >= threshold) return best;
  return null;
}

export async function saveLlmAnswer({ label, answer, options = [], fieldType = '', model = '', company = '' }) {
  const norm = normalizeLabel(label);
  if (!norm || answer == null || answer === '') return;
  const store = await loadStore();
  store.answers[norm] = {
    label: String(label),
    normalized: norm,
    answer: String(answer),
    options: Array.isArray(options) ? options.slice(0, 40) : [],
    fieldType: fieldType || '',
    company: company || '',
    model: model || getModel(),
    source: 'openrouter',
    last_used_at: new Date().toISOString(),
  };
  await persistStore();
}

export function isPersonalIdentityQuestion(label = '') {
  const n = normalizeLabel(label);
  if (!n) return false;
  if (/agency|relative|official|institution|certif|foregoing|on behalf/i.test(n)) return false;
  return /^(legal\s*)?(first|given|last|family|surname|full)\s*name/.test(n)
    || /^(first|last|given)\s*name$/.test(n)
    || /^email/.test(n)
    || /^(phone|mobile|cell)(\s*number)?$/.test(n)
    || /phone\s*number/.test(n)
    || /country.*phone\s*code/.test(n);
}

export function localNearestOption(preferred, options = []) {
  const list = (options || []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const needle = String(preferred || '').replace(/\s+/g, ' ').trim();
  if (!list.length) return null;
  if (!needle) return null;
  let best = list[0];
  let bestScore = 0;
  for (const opt of list) {
    const score = fuzzyScore(needle, opt);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return { option: best, score: bestScore };
}

function pickFromOptions(raw, options = []) {
  const trimmed = String(raw || '').replace(/^["']|["']$/g, '').trim();
  if (!trimmed) return '';
  if (!options.length) return trimmed;
  const lower = trimmed.toLowerCase();
  const exact = options.find((opt) => String(opt).toLowerCase() === lower);
  if (exact) return exact;
  const partial = options.find((opt) => {
    const o = String(opt).toLowerCase();
    return o.includes(lower) || lower.includes(o);
  });
  return partial || trimmed;
}

/**
 * Parse and validate one structured LLM field decision.
 * Option controls accept exact live DOM options only; unsupported answers return null.
 * @param {string} raw
 * @param {{question?: string, fieldType?: string, options?: string[]}} context
 * @returns {string|null}
 */
export function validateLlmFieldDecision(raw, context = {}) {
  const options = (context.options || [])
    .map((option) => String(option || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const code = fieldTypeToCode(context.fieldType || 'text');
  let decision;

  try {
    const clean = String(raw || '').replace(/```(?:json)?|```/gi, '').trim();
    decision = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || '');
  } catch {
    return null;
  }

  const rawAnswerPreview = Array.isArray(decision.answer)
    ? decision.answer.join(' ')
    : String(decision.answer ?? '');
  const honestMiss = /^(0|na|n\/a|no)\b|do not have|have not used|no (professional )?experience|not used/i
    .test(rawAnswerPreview.trim());
  if (!decision || (decision.grounded !== true && !honestMiss)) return null;
  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < (honestMiss ? 0.45 : 0.65)) return null;

  const rawAnswers = Array.isArray(decision.answer)
    ? decision.answer
    : String(decision.answer ?? '').split(code === 5 ? /[,;\n|]+/ : /\n/);
  const answers = rawAnswers
    .map((answer) => String(answer ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim())
    .filter((answer) => answer && !/^(unknown|not sure|unsure)$/i.test(answer));
  if (!answers.length) return null;

  if (options.length && code >= 2) {
    const exact = answers.map((answer) =>
      options.find((option) => option.toLowerCase() === answer.toLowerCase())
    );
    if (exact.some((answer) => !answer)) return null;
    if (code !== 5 && exact.length !== 1) return null;
    return code === 5 ? [...new Set(exact)].join(', ') : exact[0];
  }

  if (code === 5) return [...new Set(answers)].join(', ');
  return answers[0];
}

function applicantSnapshot(profile = {}) {
  const p = profile.personal || {};
  const e = profile.eeo || {};
  const w = profile.work_auth || {};
  const exp = profile.experience || {};
  const edu = profile.education || {};
  const awQa = profile._applyWizzQa && typeof profile._applyWizzQa === 'object'
    ? Object.fromEntries(
      Object.entries(profile._applyWizzQa)
        .filter(([, v]) => v != null && String(v).trim() !== '')
        .slice(0, 60),
    )
    : {};
  const qaSample = profile.qa_answers && typeof profile.qa_answers === 'object'
    ? Object.fromEntries(
      Object.entries(profile.qa_answers)
        .filter(([k, v]) => v != null && String(v).trim() !== '' && !String(k).includes('::'))
        .slice(0, 40),
    )
    : {};
  return {
    name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    email: p.email || '',
    phone: p.phone || '',
    city: p.city || '',
    state: p.state || '',
    country: p.country || '',
    address: p.address_line1 || '',
    postal_code: p.postal_code || '',
    phone_code: p.country_phone_code || '',
    source: p.source || 'LinkedIn',
    linkedin: p.linkedin || '',
    gender: e.gender || 'Male',
    hispanic_latino: e.hispanic_latino || 'No',
    race: e.race || 'Asian',
    veteran: e.veteran_status || 'I am not a protected veteran',
    disability: e.disability_status || 'No, I do not have a disability and have not had one in the past',
    authorized_us: w.authorized_us || 'Yes',
    sponsorship_needed: w.sponsorship_needed || 'No',
    visa_type: w.visa_type || '',
    willing_to_relocate: w.willing_to_relocate || awQa[normalizeLabel('willing to relocate')] || '',
    job_title: exp.current_title || '',
    company: exp.current_company || '',
    years_experience: exp.years || awQa[normalizeLabel('years of experience')] || '',
    from_date: exp.from_date || '05/2025',
    to_date: exp.to_date || '06/2026',
    location: exp.location || p.city || '',
    description: exp.description || '',
    alternate_roles: Array.isArray(profile._applyWizzAlternateRoles) ? profile._applyWizzAlternateRoles : [],
    work_preferences: Array.isArray(profile._applyWizzWorkPreferences) ? profile._applyWizzWorkPreferences : [],
    university: edu.university || 'Other',
    degree: edu.degree || "Bachelor's",
    major: edu.major || 'Computer Science',
    education_from: edu.from_year || '2020',
    education_to: edu.to_year || edu.graduation_year || '2024',
    graduation_year: edu.graduation_year || edu.to_year || '2024',
    gpa: edu.gpa || '',
    compensation: profile.compensation || profile.salary || '',
    compensation_hourly: profile.compensation_hourly || '',
    desired_start_date: profile._desiredStartDate || '',
    skills: Array.isArray(profile.skills) ? profile.skills.filter(Boolean).slice(0, 20) : [],
    apply_wizz_answers: awQa,
    apply_wizz_client_context: profile._applyWizzClientContext || {},
    known_qa_answers: qaSample,
  };
}

function factValuesContain(applicant, needle) {
  const values = Object.values(applicant || {}).flat().join(' ').toLowerCase();
  const tokens = String(needle || '').toLowerCase().match(/[a-z0-9+#.]{3,}/g) || [];
  const skip = new Set(['you', 'have', 'years', 'year', 'experience', 'with', 'this', 'the', 'and', 'for']);
  return tokens.filter((t) => !skip.has(t)).some((token) => values.includes(token));
}

/** Keep a required-field answer Playwright can type. Never leave UNKNOWN. */
function coerceRequiredAnswer(question, answer, options = [], applicant = {}, profile = null) {
  const list = (options || []).map((o) => String(o || '').trim()).filter(Boolean);
  let value = String(answer || '').replace(/^["']|["']$/g, '').trim();
  if (/^unknown$/i.test(value)) value = '';

  if (isSalaryQuestion(question) && !list.length) {
    if (/hourly|per\s*hour/i.test(question) && profile?.compensation_hourly) {
      return String(profile.compensation_hourly);
    }
    return value && !/unknown/i.test(value) ? value : 'Negotiable';
  }

  if (isYesNoQuestionLabel(question) && list.length) {
    const yn = extractYesNoAnswer(value);
    if (yn) {
      const hit = list.find((opt) => extractYesNoAnswer(opt) === yn);
      if (hit) return hit;
    }
  }

  // Years / describe-experience: never keep Yes/No; use profile analysis rules.
  if (isYearsQuantityQuestion(question) || isDescribeExperienceQuestion(question)) {
    if (isYearsQuantityQuestion(question) && (isInvalidYearsAnswer(value) || !value)) {
      const resolved = resolveExperienceQuestionAnswer(question, profile || { experience: { years: applicant.years_experience }, skills: applicant.skills }, { options: list });
      return resolved?.answer || (list.length ? list[0] : '0');
    }
    if (isDescribeExperienceQuestion(question) && (!value || /^(yes|no|na|n\/a)$/i.test(value))) {
      const resolved = resolveExperienceQuestionAnswer(question, profile || { experience: { years: applicant.years_experience }, skills: applicant.skills }, { options: list });
      return resolved?.answer || profileBackedEssay(question, profile);
    }
    return sanitizeExperienceAnswer(question, value, profile, { options: list });
  }

  if (/(how many years|years?\s+of\s+)/i.test(question) && !value) {
    return list.length ? (localNearestOption('0', list)?.option || list[0]) : '0';
  }
  if (!value && list.length) {
    const yesNo = list.filter((o) => /^(yes|no)$/i.test(o));
    if (yesNo.length) return yesNo.find((o) => /^no$/i.test(o)) || yesNo[0];
    return list[0];
  }
  if (!value && isYesNoQuestionLabel(question)) {
    const reloc = applicant.willing_to_relocate || profile?.work_auth?.willing_to_relocate;
    if (/relocat|reside in/i.test(question) && reloc) return extractYesNoAnswer(reloc) || reloc;
  }
  if (!value && isHighRiskPersonalFactQuestion(question) && !factValuesContain(applicant, question)) {
    return /^(are you|do you|have you|will you|did you)/i.test(question) ? 'No' : 'N/A';
  }
  return value || 'N/A';
}

async function persistUnknownToTenant(label, answer, opts = {}, field = {}) {
  const tenant = String(opts.tenant || '').trim().toLowerCase();
  if (!tenant || tenant === 'unknown' || !label || answer == null || answer === '') return;
  try {
    const { saveAnswerToTenantYaml } = await import('./tenantQuestionYaml.mjs');
    await saveAnswerToTenantYaml(tenant, {
      label,
      answer: String(answer),
      fieldType: field?.fieldType || field?.type || 'input',
      options: Array.isArray(field?.options) ? field.options : (opts.options || []),
      step: opts.step || '',
    });
    console.log(`    💾 Tenant YAML ← "${String(label).slice(0, 45)}" = "${String(answer).slice(0, 40)}"`);
  } catch (err) {
    console.log(`    ⚠️  Tenant YAML save skipped: ${err.message?.slice(0, 80) || err}`);
  }
}

async function loadProfileSnapshot(profile) {
  if (profile && typeof profile === 'object' && (profile.personal || profile.eeo)) {
    return applicantSnapshot(profile);
  }
  try {
    if (!existsSync(PROFILE_PATH)) return applicantSnapshot({});
    const doc = yaml.load(await readFile(PROFILE_PATH, 'utf-8')) || {};
    return applicantSnapshot(doc);
  } catch {
    return applicantSnapshot({});
  }
}

/**
 * Read the live Workday control for this question via Playwright/DOM
 * so the LLM answers against the real label, type, and options on screen.
 * @param {import('playwright').Page|null} page
 * @param {string} label
 * @param {object} field
 * @returns {Promise<object>}
 */
export async function gatherPlaywrightFieldContext(page, label, field = {}) {
  const base = {
    label: String(label || field?.label || '').trim(),
    fieldType: field?.fieldType || field?.type || '',
    required: Boolean(field?.required),
    options: (field?.options || [])
      .map((o) => (typeof o === 'string' ? o : o?.text))
      .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 40),
    nearbyLabels: [],
    currentValue: field?.currentValue || field?.value || '',
  };
  if (!page) return base;

  try {
    const live = await page.evaluate((needle) => {
      const norm = (s) => (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      const target = norm(needle);
      if (!target) return null;

      const containers = Array.from(document.querySelectorAll(
        '[data-automation-id*="formField"], fieldset, [role="group"], [role="radiogroup"]'
      ));
      let best = null;
      let bestScore = 0;
      for (const el of containers) {
        const labelEl = el.querySelector('label, legend, [data-automation-id*="richText"], [data-automation-id*="label"]');
        const text = (labelEl?.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const n = norm(text);
        if (!n || n.length < 3) continue;
        let score = 0;
        if (n === target) score = 1;
        else if (n.includes(target) || target.includes(n)) score = 0.85;
        else {
          const a = new Set(n.split(' '));
          const b = target.split(' ');
          const hit = b.filter((t) => t.length > 3 && a.has(t)).length;
          score = hit / Math.max(b.length, 1);
        }
        if (score > bestScore) {
          bestScore = score;
          const hasDropdown = Boolean(el.querySelector(
            'button[aria-haspopup="listbox"], [role="combobox"], select, [data-automation-id="selectOne"] button'
          ));
          const hasRadio = Boolean(el.querySelector('input[type="radio"]'));
          const checkboxCount = el.querySelectorAll('input[type="checkbox"]').length;
          const hasCheckbox = checkboxCount > 0;
          const hasText = Boolean(el.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea'));
          let fieldType = 'text';
          if (hasDropdown) fieldType = 'dropdown';
          else if (hasRadio) fieldType = 'radio';
          else if (checkboxCount > 1) fieldType = 'checkbox-group';
          else if (hasCheckbox) fieldType = 'checkbox';
          else if (hasText) fieldType = 'text';
          const required = Boolean(
            el.querySelector('abbr[title*="required" i], [aria-required="true"]')
            || /\*/.test(text)
            || el.getAttribute('aria-required') === 'true'
          );
          const selected = el.querySelector('[data-automation-id="selectedItem"]');
          const input = el.querySelector('input:not([type="hidden"]), textarea');
          const currentValue = (selected?.textContent || input?.value || '').replace(/\s+/g, ' ').trim();
          best = { label: text.replace(/\*+$/, '').trim(), fieldType, required, currentValue, score };
        }
      }

      const nearby = [];
      for (const el of document.querySelectorAll('label, legend, [data-automation-id*="richText"]')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().replace(/\*+$/, '');
        if (t.length >= 8 && t.length < 160 && !/indicates a required field/i.test(t)) nearby.push(t);
        if (nearby.length >= 12) break;
      }
      return best ? { ...best, nearbyLabels: nearby } : { nearbyLabels: nearby };
    }, label).catch(() => null);

    if (live) {
      if (live.label) base.label = live.label;
      if (live.fieldType) base.fieldType = live.fieldType;
      if (live.required != null) base.required = Boolean(live.required);
      if (live.currentValue) base.currentValue = live.currentValue;
      if (Array.isArray(live.nearbyLabels)) base.nearbyLabels = live.nearbyLabels;
    }

    if ((!base.options || base.options.length === 0) && page) {
      try {
        const { collectLiveFieldOptions } = await import('./workdayDom.mjs');
        const opts = await collectLiveFieldOptions(page, base.label || label, base.fieldType || '');
        if (opts?.length) base.options = opts.slice(0, 40);
      } catch { /* optional */ }
    }
  } catch { /* DOM optional */ }

  return base;
}

/**
 * Analyse the full client profile with the LLM once per process.
 * Later unknown fields reuse this brief instead of re-explaining the whole profile.
 * @param {object} profile
 * @param {{ resumePath?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function analyzeClientProfileOnce(profile = {}, opts = {}) {
  if (profile?._llmProfileAnalyzed && profile._llmProfileBrief) {
    return profile._llmProfileBrief;
  }

  const applicant = await loadProfileSnapshot(profile);
  let resumeExcerpt = '';
  try {
    const resumePath = opts.resumePath || profile?._resumePath;
    if (resumePath) {
      const { loadResumeText } = await import('./resumeParser.mjs');
      resumeExcerpt = String(await loadResumeText(resumePath) || '').slice(0, 3500);
    }
  } catch { /* resume optional */ }

  if (!isOpenRouterEnabled()) {
    const offline = [
      `Name: ${applicant.name}`,
      `Contact: ${applicant.email} | ${applicant.phone} | ${applicant.city}, ${applicant.state}`,
      `Work: ${applicant.job_title} @ ${applicant.company} (${applicant.from_date}–${applicant.to_date})`,
      `Education: ${applicant.university} / ${applicant.degree} / ${applicant.major}`,
      `Work auth: ${applicant.authorized_us}; sponsorship: ${applicant.sponsorship_needed}`,
      `Skills: ${(applicant.skills || []).join(', ')}`,
    ].filter(Boolean).join('\n');
    if (profile) {
      profile._llmProfileBrief = offline;
      profile._llmProfileAnalyzed = true;
    }
    console.log('  🧠 Client profile brief built offline (no OPENROUTER_API_KEY) — used for unknown fields');
    return offline;
  }

  try {
    console.log(`  🧠 Analysing client profile once via LLM (${getModel()}) — give this time; reused for all unknown fields...`);
    const data = await openRouterChat({
      max_tokens: 600,
      timeoutMs: 60000,
      messages: [
        {
          role: 'system',
          content: `You analyse a job applicant for Workday form auto-fill.
Return a compact plain-text brief (no markdown) with short bullets covering:
identity/contact, location, work history (role + total years from facts), education, skills,
work authorization / visa, EEO defaults if present, compensation preference,
and how to answer experience questions:
- domain years questions: use total years only when the domain matches role/skills; otherwise 0
- describe-experience prompts: short fact if matched; otherwise a honest "no experience with X" sentence
- typical yes/no employer questions (prior employee, relatives, contractor → No unless facts say otherwise).
Do not invent phone, email, name, salary, degree, or work-auth facts not in the input.`,
        },
        {
          role: 'user',
          content: `Applicant facts JSON:\n${JSON.stringify(applicant, null, 2)}\n\nResume excerpt:\n${resumeExcerpt || '(none)'}`,
        },
      ],
    });
    const brief = String(data?.choices?.[0]?.message?.content || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    if (profile) {
      profile._llmProfileBrief = brief || JSON.stringify(applicant).slice(0, 2000);
      profile._llmProfileAnalyzed = true;
    }
    console.log(`  ✓ Client profile analysed once (${(profile._llmProfileBrief || '').length} chars) — Playwright will use this for unknown labels`);
    return profile._llmProfileBrief;
  } catch (err) {
    const fallback = JSON.stringify(applicant).slice(0, 2000);
    if (profile) {
      profile._llmProfileBrief = fallback;
      profile._llmProfileAnalyzed = true;
    }
    console.log(`  ⚠️  Profile LLM analysis skipped: ${err.message?.slice(0, 100) || err}`);
    return fallback;
  }
}

async function callOpenRouter({
  question,
  options,
  fieldType,
  applicant,
  company,
  nearest = false,
  profileBrief = '',
  domContext = null,
  profile = null,
}) {
  const key = getApiKey();
  if (!key) return null;
  const model = getModel();
  const optionBlock = options.length
    ? `Allowed options (pick the closest one; copy the option text exactly):\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : 'No option list. Type a short realistic answer.';

  const expCtx = buildExperienceContext(profile || {});
  const typeCode = fieldTypeToCode(fieldType || domContext?.fieldType || 'text');
  const typeDesc = describeFieldTypeCode(typeCode);
  const system = `You fill one Workday job application field for this applicant.
Return ONLY valid JSON, with no markdown:
{"answer":"exact value or text","confidence":0.0,"grounded":true}
For MULTI_CHECKBOX, answer must be an array of exact option strings.
Set grounded=false when the answer is not supported by the supplied applicant facts.

FIELD TYPE CODE (must honour): ${typeDesc}
- Code 1 INPUT: type a number or short human text. Years questions → number or 0. Describe → short fact or NA. Do NOT answer Yes for everything.
- Code 2 DROPDOWN / 3 RADIO: copy one listed option EXACTLY.
- Code 4 CHECKBOX: Yes/check only if true for this applicant; otherwise No.
- Code 5 MULTI_CHECKBOX: only options that truly apply — never select all by default.

PRIORITY:
1) Client profile brief + Applicant facts (Apply Wizz + YAML + resume) — be humanic and accurate.
2) Playwright DOM context (label, type code, live options).
3) If options are listed, answer using only exact listed option text. Never invent an option.
4) Never invent a different name, phone, email, salary, degree, school, or work-auth fact.
5) NEVER default to Yes for every question. Read the profile. If unsure and options include No, prefer No for prior-employer / relatives / misconduct; for skills not in profile use No or 0 / NA as appropriate.

Rules:
- REQUIRED field — never return UNKNOWN or empty.
- Years of experience in domain X: years if profile supports X, else 0. Never Yes/No for years inputs.
- Describe / tell-us / why-looking / which-areas essays: 2–4 honest sentences from the profile. If the domain is not in the profile, say so and describe the actual role/skills. Never leave empty and do not answer Yes/No.
- Salary: compensation from facts or Negotiable.
- Age 16/18+: Yes. Terms/consent: Yes.`;

  const domBlock = domContext
    ? `Playwright live field:
- On-screen label: ${domContext.label || question}
- Field type: ${domContext.fieldType || fieldType || 'text'}
- Required: ${domContext.required ? 'yes' : 'no'}
- Current value: ${domContext.currentValue || '(empty)'}
- Nearby labels: ${(domContext.nearbyLabels || []).slice(0, 8).join(' | ') || '(none)'}`
    : 'Playwright live field: (not available)';

  const user = `Company: ${company || 'unknown'}
Field type code: ${typeCode}
Field type: ${fieldType || domContext?.fieldType || 'text'}
Question: ${question}

${domBlock}

${optionBlock}

Experience analysis (from Apply Wizz + profile):
- Total years: ${expCtx.yearsText}
- Role: ${expCtx.role || '(none)'}
- Skills: ${(expCtx.skills || []).join(', ') || '(none)'}
- Summary: ${expCtx.summary || '(none)'}

Client profile brief (analysed once):
${profileBrief || '(use JSON facts below)'}

Complete applicant profile (Apply Wizz + YAML + resume-derived facts):
${JSON.stringify(applicant, null, 2)}`;

  const data = await openRouterChat({
    max_tokens: nearest ? 120 : 400,
    timeoutMs: 45000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const text = data?.choices?.[0]?.message?.content;
  const validated = validateLlmFieldDecision(text, { question, fieldType, options });
  if (!validated) return null;
  return coerceRequiredAnswer(question, validated, options, applicant, profile);
}

/**
 * Analyse an INPUT / textarea question with the LLM against the full client profile
 * (Apply Wizz + YAML brief). Used for years, describe-experience, and other free-text fields.
 * @param {object} args
 * @returns {Promise<string|null>}
 */
export async function answerInputFieldWithLlm({
  question,
  fieldType = 'text',
  profile = null,
  company = '',
  profileBrief = '',
  domContext = null,
  applicant = null,
  options = [],
} = {}) {
  const key = getApiKey();
  if (!key) return null;

  const label = String(question || '').trim();
  if (!label) return null;

  const snap = applicant || await loadProfileSnapshot(profile);
  const expCtx = buildExperienceContext(profile || {});
  const brief = profileBrief || profile?._llmProfileBrief || '';

  const system = `You answer ONE Workday application field for this applicant.
Return ONLY valid JSON, with no markdown:
{"answer":"value to type","confidence":0.0,"grounded":true}
Set grounded=false when the answer is not supported by the supplied applicant facts.

FIELD TYPE CODE: ${describeFieldTypeCode(fieldTypeToCode(fieldType))}
Be humanic: read the full profile. Do NOT answer Yes to everything.

Rules:
1) Code 1 / years INPUT: if domain matches role/skills → years (${expCtx.yearsText}); else 0. Never Yes/No.
2) Describe / tell-us / why-looking / which-areas: 2–4 honest sentences from the profile. If the domain is not in the profile, say so and describe the actual role. Never Yes/No and never empty.
3) Dropdown/radio: exact option text only.
4) Checkbox/multi: only what is true for this applicant.
5) Other inputs: matching facts only — never invent identity/salary/work-auth.

Applicant total years: ${expCtx.yearsText}
Role: ${expCtx.role || '(none)'}
Skills: ${(expCtx.skills || []).join(', ') || '(none)'}
Summary: ${expCtx.summary || '(none)'}`;

  const domBlock = domContext
    ? `On-screen label: ${domContext.label || label}
Field type: ${domContext.fieldType || fieldType}
Required: ${domContext.required ? 'yes' : 'no'}`
    : `Field type: ${fieldType}`;

  const optionList = (options.length ? options : (domContext?.options || []))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const optionBlock = optionList.length
    ? `Allowed options (copy one exactly):\n${optionList.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : 'No option list — type a number or a short human sentence.';

  const data = await openRouterChat({
    max_tokens: isDescribeExperienceQuestion(label) ? 700 : 400,
    timeoutMs: 45000,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Company: ${company || 'unknown'}
${domBlock}
${optionBlock}

Question to analyse and answer:
${label}

Client profile brief:
${brief || '(see JSON)'}

Complete applicant profile JSON:
${JSON.stringify(snap, null, 2)}`,
      },
    ],
  });
  const text = String(data?.choices?.[0]?.message?.content || '');
  const validated = validateLlmFieldDecision(text, {
    question: label,
    fieldType,
    options: optionList,
  });
  if (!validated) return null;
  return coerceRequiredAnswer(label, validated, optionList, snap, profile);
}

/**
 * Resolve an unknown Workday field: cache first, then OpenRouter, then persist.
 */
function identityAnswerFromApplicant(label, applicant = {}) {
  const n = normalizeLabel(label);
  if (/email/.test(n)) return applicant.email || null;
  if (/phone|mobile|cell/.test(n) && !/code/.test(n)) return applicant.phone || null;
  if (/phone\s*code/.test(n)) return applicant.phone_code || null;
  if (/name/.test(n)) return applicant.name || null;
  return null;
}

/**
 * Pick the closest live dropdown option so the wizard can advance.
 */
export async function pickNearestSelectOption({
  question,
  options = [],
  preferred = '',
  profile = null,
  company = '',
  page = null,
  domContext = null,
} = {}) {
  const list = (options || []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!list.length) return preferred || null;

  if (isSalaryQuestion(question)) {
    const picked = pickCompensationFromOptions(list, profile, preferred);
    if (picked) return picked;
  }

  const local = localNearestOption(preferred, list);
  if (local && local.score >= 0.8) return local.option;

  if (isOpenRouterEnabled()) {
    try {
      if (profile) {
        await analyzeClientProfileOnce(profile, { resumePath: profile._resumePath });
      }
      const applicant = await loadProfileSnapshot(profile);
      const liveDom = domContext || await gatherPlaywrightFieldContext(page, question, { options: list, fieldType: 'dropdown' });
      console.log(`    🤖 Nearest-select: "${String(question).slice(0, 55)}" preferred="${String(preferred || '').slice(0, 30)}"`);
      const answer = await callOpenRouter({
        question: `${question}\nPreferred value: ${preferred || '(none)'}\nPick the CLOSEST option so the form can continue.`,
        options: list,
        fieldType: 'dropdown',
        applicant,
        company,
        nearest: true,
        profileBrief: profile?._llmProfileBrief || '',
        domContext: liveDom,
        profile,
      });
      const matched = pickFromOptions(answer, list);
      if (matched && list.some((o) => o.toLowerCase() === String(matched).toLowerCase())) {
        return matched;
      }
    } catch (err) {
      console.log(`    ⚠️  Nearest-select API failed: ${err.message?.slice(0, 100) || err}`);
    }
  }

  // Without a meaningful preferred value, selecting the first option fabricates an
  // answer. Leave it unresolved so the caller can require a human-sourced answer.
  return preferred && local?.score >= 0.5 ? local.option : null;
}

/**
 * Fill work/education from OpenRouter using resume + profile facts.
 * Never overwrites name, phone, or email.
 */
export async function hydrateExperienceFromLlm(profile = {}) {
  if (!profile || profile._experienceHydrated) return profile;
  profile._experienceHydrated = true;
  if (!isOpenRouterEnabled()) return profile;

  let resumeExcerpt = '';
  try {
    const { getResumePathForApply, loadResumeText } = await import('./resumeParser.mjs');
    const resumePath = profile._resumePath || await getResumePathForApply(profile).catch(() => null);
    if (resumePath) {
      const text = await loadResumeText(resumePath);
      resumeExcerpt = String(text || '').slice(0, 4000);
    }
  } catch { /* resume optional */ }

  const applicant = await loadProfileSnapshot(profile);
  const key = getApiKey();
  if (!key) return profile;

  try {
    console.log('    🤖 OpenRouter collecting My Experience (work + education) — personal details unchanged');
    const data = await openRouterChat({
      max_tokens: 400,
      timeoutMs: 45000,
      messages: [
        {
          role: 'system',
          content: `Extract Workday My Experience fields. Return JSON only, no markdown.
Keys: job_title, company, location, from_date, to_date, description, university, degree, major, from_year, to_year.
Dates: work MM/YYYY, education YYYY.
Do not include name, phone, email, or mobile.
If a key is unknown, omit it.
School should be Other when the university is not a listed Workday school.
Degree should be a Bachelor's variant. Major should be Computer Science if that is the field.`,
        },
        {
          role: 'user',
          content: `Applicant facts:\n${JSON.stringify(applicant, null, 2)}\n\nResume excerpt:\n${resumeExcerpt || '(none)'}`,
        },
      ],
    });
    const raw = String(data?.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!parsed || typeof parsed !== 'object') return profile;

    profile.experience = { ...(profile.experience || {}) };
    profile.education = { ...(profile.education || {}) };
    if (parsed.job_title) profile.experience.current_title = String(parsed.job_title);
    if (parsed.company) profile.experience.current_company = String(parsed.company);
    if (parsed.location) profile.experience.location = String(parsed.location);
    // Dates: only fill a gap, and only with something parseable. A configured
    // date must never be replaced by a date the model read off the resume.
    for (const [key, value] of [['from_date', parsed.from_date], ['to_date', parsed.to_date]]) {
      if (!value || profile.experience[key]) continue;
      if (!parseMonthYear(value)) {
        console.log(`    ⚠️  Ignored unparseable ${key} "${String(value).slice(0, 20)}" from resume analysis`);
        continue;
      }
      profile.experience[key] = String(value);
    }
    if (parsed.description) profile.experience.description = String(parsed.description);
    profile.education.university = 'Other';
    profile.education.degree = parsed.degree && /bachelor/i.test(String(parsed.degree))
      ? String(parsed.degree)
      : "Bachelor's";
    profile.education.major = 'Computer Science';
    profile.education.field_of_study_hierarchy = ['Computer Science'];
    for (const [key, value] of [['from_year', parsed.from_year], ['to_year', parsed.to_year]]) {
      if (!value || profile.education[key]) continue;
      if (!parseYear(value)) {
        console.log(`    ⚠️  Ignored unparseable ${key} "${String(value).slice(0, 20)}" from resume analysis`);
        continue;
      }
      profile.education[key] = String(parseYear(value));
    }
    console.log(`    💾 Experience API: ${profile.experience.current_title || ''} @ ${profile.experience.current_company || ''} | school Other | ${profile.education.degree} | Computer Science`);
  } catch (err) {
    console.log(`    ⚠️  Experience API skipped: ${err.message?.slice(0, 120) || err}`);
  }
  return profile;
}

export async function resolveUnknownWithLlm(questionText, field = {}, opts = {}) {
  const label = String(questionText || '').trim();
  if (!label) return null;

  const safeAnswer = lookupSensitiveSafeAnswer(label);
  if (safeAnswer) return safeAnswer;

  // Compliance answers may be reused from YAML/profile/Apply Wizz, but an unknown
  // compliance answer must never be invented by an LLM.
  if (isComplianceSensitive(label)) {
    console.log(`    🛑 Compliance answer not on file — LLM blocked for "${label.slice(0, 65)}"`);
    return null;
  }

  // Ensure client profile was analysed once before any unknown-field LLM call.
  if (opts.profile) {
    await analyzeClientProfileOnce(opts.profile, {
      resumePath: opts.resumePath || opts.profile._resumePath,
    });
  }

  if (isPersonalIdentityQuestion(label)) {
    const applicant = await loadProfileSnapshot(opts.profile);
    const fromProfile = identityAnswerFromApplicant(label, {
      ...applicant,
      email: opts.profile?.personal?.email,
      phone: opts.profile?.personal?.phone,
    });
    if (fromProfile) {
      console.log(`    👤 Personal details stay on profile: "${label.slice(0, 40)}" ← "${String(fromProfile).slice(0, 30)}"`);
      return fromProfile;
    }
    return null;
  }

  // Playwright: identify the live on-screen label, type, and options for this question.
  const domContext = await gatherPlaywrightFieldContext(opts.page || null, label, field);
  let options = (domContext.options?.length ? domContext.options : (field?.options || []))
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (opts.page && options.length === 0) {
    try {
      const { collectLiveFieldOptions } = await import('./workdayDom.mjs');
      const live = await collectLiveFieldOptions(opts.page, domContext.label || label, domContext.fieldType || field?.fieldType || field?.type || '');
      if (live?.length) options = live;
    } catch {
      /* ignore live option scrape failures */
    }
  }

  const effectiveLabel = domContext.label || label;
  const fieldType = domContext.fieldType || field?.fieldType || field?.type || 'text';

  const finish = async (answer, source = 'openrouter') => {
    const applicant = await loadProfileSnapshot(opts.profile);
    let finalAnswer = coerceRequiredAnswer(effectiveLabel, answer, options, applicant, opts.profile);
    finalAnswer = sanitizeExperienceAnswer(effectiveLabel, finalAnswer, opts.profile, {
      options,
      fieldType,
    });
    if (!finalAnswer) return null;
    await saveLlmAnswer({
      label: effectiveLabel,
      answer: finalAnswer,
      options,
      fieldType: fieldType || (options.length ? 'dropdown' : 'input'),
      model: getModel(),
      company: opts.company || opts.tenant || '',
    });
    await persistUnknownToTenant(effectiveLabel, finalAnswer, { ...opts, options }, field);
    if (source !== 'cache') {
      console.log(`    💾 LLM ${source} ← "${String(finalAnswer).slice(0, 50)}"`);
    }
    return finalAnswer;
  };

  // Profile heuristic for experience Qs — only when LLM is off OR field is not a free-text input.
  // Input fields: LLM analyses the question against the full Apply Wizz profile first.
  const inputLike = isInputLikeField(fieldType, options)
    || isYearsQuantityQuestion(effectiveLabel)
    || isDescribeExperienceQuestion(effectiveLabel);

  if (!inputLike || !isOpenRouterEnabled()) {
    const fromExperience = resolveExperienceQuestionAnswer(effectiveLabel, opts.profile, {
      options,
      fieldType,
    });
    if (fromExperience?.answer != null) {
      console.log(`    📊 [experience/${fromExperience.source}] "${effectiveLabel.slice(0, 55)}" ← "${String(fromExperience.answer).slice(0, 40)}" (topic ${fromExperience.matched ? 'matched' : 'no match'})`);
      return finish(fromExperience.answer, fromExperience.source);
    }
  }

  // Concept synonyms before fuzzy/LLM (education ↔ graduation, salary ↔ compensation, …)
  try {
    const { resolveByConcept } = await import('./answerConcepts.mjs');
    // Skip broad years concept for domain years input — LLM handles those.
    const fromConcept = resolveByConcept(effectiveLabel, opts.profile);
    if (fromConcept?.answer) {
      if (isYearsQuantityQuestion(effectiveLabel) && inputLike && isOpenRouterEnabled()) {
        /* fall through to LLM input analysis */
      } else {
        console.log(`    🔎 [LLM→concept/${fromConcept.concept}] "${effectiveLabel.slice(0, 55)}" ← "${String(fromConcept.answer).slice(0, 40)}"`);
        return finish(fromConcept.answer, fromConcept.source);
      }
    }
  } catch { /* ignore */ }

  const tenant = opts.tenant || '';
  const semanticDb = await lookupSemanticAnswer(effectiveLabel, opts.profile, tenant, { threshold: 0.52 });
  if (semanticDb?.answer) {
    if (isYearsQuantityQuestion(effectiveLabel) && isInvalidYearsAnswer(semanticDb.answer)) {
      console.log(`    ⛔ [LLM→DB] rejected Yes/No for years input "${effectiveLabel.slice(0, 50)}"`);
    } else if (inputLike && isOpenRouterEnabled() && (isYearsQuantityQuestion(effectiveLabel) || isDescribeExperienceQuestion(effectiveLabel))) {
      /* prefer live LLM analysis for experience input fields */
    } else {
      console.log(`    🔎 [LLM→DB/${semanticDb.source}] "${effectiveLabel.slice(0, 55)}" ← "${String(semanticDb.answer).slice(0, 40)}"`);
      return finish(semanticDb.answer, semanticDb.source || 'semantic_db');
    }
  }

  const cached = await lookupLlmAnswer(effectiveLabel, { threshold: isSalaryQuestion(effectiveLabel) ? 0.55 : 0.88 });
  if (cached) {
    const badYearsCache = isYearsQuantityQuestion(effectiveLabel) && isInvalidYearsAnswer(cached);
    const openEnded = String(effectiveLabel).length > 55
      || /^(briefly|describe|explain|tell us|please explain|why (are|do|would))/i.test(effectiveLabel);
    const tooShortForEssay = openEnded && String(cached).trim().length < 40;
    const inList = !options.length || options.some((o) => o.toLowerCase() === String(cached).toLowerCase());
    if (inList && !tooShortForEssay && !badYearsCache) {
      console.log(`    ♻️  LLM cache: "${effectiveLabel.slice(0, 55)}" ← "${String(cached).slice(0, 50)}"`);
      return finish(cached, 'cache');
    }
  }

  if (options.length) {
    const nearest = await pickNearestSelectOption({
      question: effectiveLabel,
      options,
      preferred: opts.preferred || cached || '',
      profile: opts.profile,
      company: opts.company || opts.tenant || '',
      page: opts.page,
      domContext,
    });
    if (nearest) return finish(nearest, 'nearest');
  }

  if (!isOpenRouterEnabled()) {
    const offlineExp = resolveExperienceQuestionAnswer(effectiveLabel, opts.profile, { options, fieldType });
    if (offlineExp?.answer != null) return finish(offlineExp.answer, offlineExp.source);
    const offline = isSalaryQuestion(effectiveLabel)
      ? lookupSemanticCompensationAnswer(effectiveLabel, opts.profile, opts.tenant || '')
      : null;
    return finish(offline || opts.preferred || cached || '', 'fallback');
  }

  const applicant = await loadProfileSnapshot(opts.profile);
  const company = opts.company || opts.tenant || '';
  const profileBrief = opts.profile?._llmProfileBrief || '';

  try {
    if (inputLike) {
      console.log(`    🤖 LLM analysing INPUT question vs full profile: "${effectiveLabel.slice(0, 70)}"`);
      const inputAnswer = await answerInputFieldWithLlm({
        question: effectiveLabel,
        fieldType,
        profile: opts.profile,
        company,
        profileBrief,
        domContext,
        applicant,
        options,
      });
      if (inputAnswer) return finish(inputAnswer, 'input_llm');
    }

    console.log(`    🤖 OpenRouter (${getModel()}) + Playwright label → auto answer: "${effectiveLabel.slice(0, 70)}"`);
    const answer = await callOpenRouter({
      question: effectiveLabel,
      options,
      fieldType,
      applicant,
      company,
      nearest: Boolean(options.length),
      profileBrief,
      domContext,
      profile: opts.profile,
    });
    return finish(answer, 'api');
  } catch (err) {
    console.log(`    ⚠️  OpenRouter failed: ${err.message?.slice(0, 120) || err}`);
    const offlineExp = resolveExperienceQuestionAnswer(effectiveLabel, opts.profile, { options, fieldType });
    if (offlineExp?.answer != null) return finish(offlineExp.answer, offlineExp.source);
    const offline = isSalaryQuestion(effectiveLabel)
      ? lookupSemanticCompensationAnswer(effectiveLabel, opts.profile, opts.tenant || '')
      : null;
    return finish(offline || opts.preferred || cached || '', 'fallback');
  }
}

/**
 * One LLM call for leftover unknown questions on the current page.
 * Must not invent personal facts. Returns structured rows for the question engine.
 * @param {Array<object>} questions
 * @param {object} profile
 * @param {object} [opts]
 */
export async function analyzeUnknownQuestionsBatch(questions = [], profile = {}, opts = {}) {
  const rows = (questions || []).filter((q) => q?.questionId && q?.label);
  if (!rows.length) return [];
  if (!isOpenRouterEnabled()) {
    return rows.map((q) => ({
      questionId: q.questionId,
      answer: null,
      confidence: 0,
      grounded: false,
      requiresReview: true,
      reason: 'llm_disabled',
    }));
  }

  await analyzeClientProfileOnce(profile, {
    resumePath: opts.resumePath || profile?._resumePath,
  });
  const applicant = await loadProfileSnapshot(profile);

  try {
    const data = await openRouterChat({
      temperature: 0.05,
      max_tokens: 1200,
      timeoutMs: 60000,
      messages: [
        {
          role: 'system',
          content: `You map Workday questions to applicant FACTS only.
Never invent years, salary, visa, sponsorship, clearance, licenses, skills, dates, or education.
If a fact is missing or the question is ambiguous, answer must be null and requiresReview true.
If options are provided, answer must be exactly one of those strings.
Return JSON only: {"answers":[{"questionId":"","answer":null,"confidence":0,"grounded":false,"requiresReview":true,"reason":""}]}`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            facts: applicant,
            brief: String(profile?._llmProfileBrief || '').slice(0, 1500),
            questions: rows.map((q) => ({
              questionId: q.questionId,
              question: q.label,
              intent: q.intent,
              options: q.options || [],
              answerType: q.elementType || q.answerType || '',
              required: q.required === true,
            })),
          }),
        },
      ],
    });
    const raw = String(data?.choices?.[0]?.message?.content || '');
    const parsed = JSON.parse(raw.replace(/```(?:json)?|```/gi, '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    return rows.map((q) => {
      const hit = answers.find((a) => a.questionId === q.questionId) || {};
      const grounded = hit.grounded === true;
      const answer = hit.answer == null ? null : String(hit.answer).trim();
      const confidence = Number(hit.confidence);
      const requiresReview = hit.requiresReview === true || !grounded || !answer
        || !Number.isFinite(confidence) || confidence < 0.70;
      return {
        questionId: q.questionId,
        answer: requiresReview ? null : answer,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        grounded,
        requiresReview,
        reason: hit.reason || (requiresReview ? 'ungrounded_or_missing' : 'llm_page_batch'),
      };
    });
  } catch (err) {
    console.log(`    ⚠️  Page-batch LLM failed: ${err.message?.slice(0, 120) || err}`);
    return rows.map((q) => ({
      questionId: q.questionId,
      answer: null,
      confidence: 0,
      grounded: false,
      requiresReview: true,
      reason: 'llm_batch_failed',
    }));
  }
}
