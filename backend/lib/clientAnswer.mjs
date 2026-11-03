/**
 * clientAnswer.mjs — Single answer path for every Workday question.
 *
 * Fast-path (synchronous):
 *   peekClientAnswer(label, profile, opts) — identity/name/email/phone from profile
 *
 * Full waterfall (async):
 *   resolveClientAnswer(field, profile, opts) — invokes the 6-tier tierResolver
 *
 * Tier 0 (pre-resolution):
 *   lookupResolvedAnswerFromProfile — JSON pre-resolved answers from job_distributions
 *
 * Tiers 1-6 delegated to: ./tierResolver.mjs
 *   Tier 1: Supabase client_questions + clients table
 *   Tier 2: Resume parsing facts
 *   Tier 3: Apply Wizz CRM Profile API
 *   Tier 4: Universal Q&A Bank (qa_store)
 *   Tier 5: Semantic + fuzzy composite context match
 *   Tier 6: LLM (Claude) with bound context + auto Q&A bank cache
 */

import {
  hydrateProfileFromApplyWizz,
  resolveDomQuestionFromApplyWizz,
  isApplyWizzConfigured,
  alignAnswerToWorkdayOptions,
  stripWorkdayQuestionLabel,
} from './applyWizzClient.mjs';
import { tokenSetRatio, fuzzyScore } from './fields.mjs';
import { formatPlainUsPhone, normalizePhoneForCountry, workdayPhoneCodeForCountry, isValidCityName, isValidStateName } from './clientContact.mjs';
import { isPersonalIdentityQuestion } from './claudeLlm.mjs';
import {
  resolveExperienceQuestionAnswer,
  sanitizeExperienceAnswer,
  isYearsQuantityQuestion,
  isDescribeExperienceQuestion,
  isProceedQuestion,
  isInvalidYearsAnswer,
} from './experienceAnswer.mjs';
import { isYesNoQuestionLabel, extractYesNoAnswer, lookupSensitiveSafeAnswer } from './workdayDefaults.mjs';
import { isMinimumAgeQuestion, resolveMinimumAgeAnswer } from './minimumAge.mjs';
import { trace } from './trace.mjs';
import { normalizeLabel } from './qaStore.mjs';
import { enrichFieldWithTypeCode, fieldTypeToCode } from './fieldTypeCodes.mjs';
import {
  lookupSupabaseAnswer,
  lookupSupabaseAnswerSync,
  isSupabaseConfigured,
  upsertSupabaseAnswer,
  recordSupabaseAnswerInMemory,
} from './supabaseClient.mjs';
import { explicitSalary } from './questionEngine/profileFacts.mjs';
import {
  isSignatureOrFullNameQuestion,
  isShiftOrScheduleQuestion,
  pickShiftOption,
  isSpecificManagerOrLocationQuestion,
} from './questionEngine/intents.mjs';
import { toTitleCase } from './personName.mjs';
import { formatToMMDDYYYY } from './fillHandlers.mjs';
import { extractDobFromResumeText } from './resumeParser.mjs';
import { resolveAnswer } from './tierResolver.mjs';

// ─── Field helpers ────────────────────────────────────────────────────────────

export function fieldOptions(field = {}) {
  return (field.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function fieldLabel(field = {}, fallback = '') {
  return String(field.questionLabel || field.label || field.id || field.name || fallback || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Profile fact mapping ──────────────────────────────────────────────────────

/**
 * Facts that already live on the hydrated client profile — never a hardcoded Yes/No.
 * Returns the value for a label if it can be answered directly from the profile object.
 */
export function profileFactForLabel(label, profile = {}) {
  const n = normalizeLabel(label);
  const p = profile.personal || {};
  const e = profile.education || {};
  const x = profile.experience || {};
  const w = profile.work_auth || {};
  const eeo = profile.eeo || {};

  const priorEmployer = priorEmployerAnswer(label, profile);
  if (priorEmployer) return priorEmployer;

  if (/^(legal\s*)?(first|given)\s*name/.test(n) || n === 'first name') return toTitleCase(p.first_name) || null;
  if (/^(legal\s*)?(middle)\s*name/.test(n) || n === 'middle name') return toTitleCase(p.middle_name) || null;
  if (/^(legal\s*)?(last|family|surname)\s*name/.test(n) || n === 'last name') return toTitleCase(p.last_name) || null;
  if (isSignatureOrFullNameQuestion(label) || /^full\s*name$|^name$|^legal\s*name$/.test(n) || /enter.*your.*name/i.test(n)) return toTitleCase(p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || profile.name) || null;
  if (/date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(n)) {
    const rawDob = p.date_of_birth
      || p.dob
      || profile._supabaseQa?.['date of birth']
      || profile._supabaseQa?.['date_of_birth']
      || profile._supabaseQa?.['dob']
      || profile._supabaseQa?.['birth date']
      || profile._applyWizzQa?.['date of birth']
      || profile._applyWizzQa?.['birth date']
      || profile._applyWizzQa?.['dob']
      || profile._applyWizzClientContext?.additional_information?.date_of_birth
      || profile._applyWizzRaw?.date_of_birth
      || profile.date_of_birth
      || '';
    if (rawDob) {
      return formatToMMDDYYYY(rawDob) || rawDob;
    }
  }
  if (/^email/.test(n)) return p.email || null;
  if (/^(phone|mobile|cell)(\s*number)?$|phone\s*number/.test(n)) {
    const hint = `${p.country || ''} ${p.country_phone_code || ''}`;
    return p.phone ? normalizePhoneForCountry(p.phone, hint) : null;
  }
  if (/country\s*(\/\s*territory\s*)?phone\s*code/i.test(n)) {
    return p.country_phone_code || workdayPhoneCodeForCountry(p.country) || null;
  }
  if (/^country$/i.test(n) && !/phone/i.test(n)) return p.country || null;
  if (/^district$|^county$/i.test(n)) {
    const candidate = p.city || p.state || null;
    return (isValidCityName(candidate) || isValidStateName(candidate)) ? candidate : null;
  }
  if (/^city$|^address--city$/.test(n)) {
    if (isValidCityName(p.city)) return p.city;
    if (isValidCityName(profile._supabaseQa?.['city'])) return profile._supabaseQa['city'];
    if (isValidCityName(profile._applyWizzQa?.['city'])) return profile._applyWizzQa['city'];
    return null;
  }
  if (/address\s*line\s*1|^address--addressline1$/.test(n)) return p.address_line1 || null;
  if (/^state$|^address--countryregion$/.test(n)) {
    if (isValidStateName(p.state)) return p.state;
    if (isValidStateName(profile._supabaseQa?.['state'])) return profile._supabaseQa['state'];
    if (isValidStateName(profile._applyWizzQa?.['state'])) return profile._applyWizzQa['state'];
    return null;
  }
  if (/postal|zip/.test(n)) return p.postal_code || null;
  if (/^country$/.test(n) && !/authorized|eligib|citizen/.test(n)) return p.country || null;
  if (/linkedin/.test(n)) return p.linkedin || null;

  if (/authorized to work|legally authorized|eligible to work/.test(n)) return w.authorized_us || null;
  if (/sponsor|visa sponsorship/.test(n)) return w.sponsorship_needed || null;
  if (/visa type/.test(n)) return w.visa_type || null;

  if (/please select your gender|^gender$|^sex$/.test(n) || (/\bgender\b/.test(n) && /identify|select|please/.test(n))) {
    return eeo.gender || null;
  }
  if (/hispanic|latino/.test(n)) return eeo.hispanic_latino || null;
  if (/\b(race|ethnicity)\b/.test(n) && !/hispanic|latino/.test(n)) return eeo.race || null;
  if (/veteran/.test(n)) {
    return eeo.veteran_status
      || profile._applyWizzQa?.['veteran status']
      || lookupSensitiveSafeAnswer(label)
      || 'I am not a veteran';
  }
  if (/disability/.test(n)) return eeo.disability_status || null;

  if (/^job\s*title$|^title$|current title/.test(n)) return x.current_title || null;
  if (/^company$/.test(n)) return x.current_company || null;
  if (/years of experience|total years/.test(n)) return x.years || null;

  if (/highest level of education|highest education/.test(n)) return e.highest_level || e.degree || null;
  if (/^degree$/.test(n)) return e.degree || null;
  if (/field of study|^major$/.test(n)) return e.major || null;
  if (/school or university|^school$|^university$/.test(n)) return e.university || null;
  if (/gpa/.test(n)) return e.gpa || null;

  if (/relocat|reside in nebraska|reside in iowa|\bne or ia\b/.test(n)) {
    const state = String(p.state || '').toLowerCase();
    if (/\bnebraska\b|\biowa\b/.test(state) || /\b(ne|ia)\b/.test(state)) return 'Yes';
    return w.willing_to_relocate || null;
  }

  if (/hourly|wage/.test(n)) {
    return explicitSalary(profile, true);
  }
  if (/(salary|compensation|pay|minimum salary)/.test(n) && !/hourly|wage/.test(n)) {
    return explicitSalary(profile, false);
  }
  if (/available.*start|when.*start|desired.*start|willing.*join|available.*join|earliest.*start|target.*start|start.*date/i.test(n)) {
    const explicit = profile._desiredStartDate
      || profile._supabaseQa?.['available to start']
      || profile._supabaseQa?.['when can you start']
      || profile._supabaseQa?.['start date']
      || profile._supabaseQa?.['willing to join']
      || profile.personal?.available_date;
    if (explicit && /\d/.test(String(explicit))) {
      const formatted = formatToMMDDYYYY(explicit);
      if (formatted && /^\d{2}\/\d{2}\/\d{4}$/.test(formatted)) return formatted;
    }
    const now = new Date();
    const target = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    const yyyy = target.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }
  return null;
}

// ─── Prior employer answer ────────────────────────────────────────────────────

/** Resolve named prior-employer questions from the complete hydrated profile. */
export function priorEmployerAnswer(label, profile = {}) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!/\b(ever\s+been\s+employed|previously\s+employed|worked\s+(for|at)|prior\s+(employment|employee)|former\s+employee)/i.test(text)) {
    return null;
  }

  const target = text
    .replace(/^.*?\b(?:by|for|at|with)\s+(?:the\s+)?/i, '')
    .replace(/[?*].*$/g, '')
    .replace(/\b(organisation|organization|company|employer|corporation|incorporated|particular)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!target || target.length < 3 || /^(this|that|the|any|another)$/i.test(target)) return null;

  const targetTokens = target.toLowerCase().split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length >= 3 && !/^(ever|been|employed|working|worked|family|group|team)$/.test(token));
  if (!targetTokens.length) return null;

  const evidence = [
    profile.experience?.current_company,
    profile.experience?.previous_company,
    profile._resumeText,
    JSON.stringify(profile._applyWizzClientContext || {}),
  ].filter(Boolean).join(' ').toLowerCase();

  return targetTokens.some((token) => evidence.includes(token)) ? 'Yes' : 'No';
}

// ─── Answer validation / sanitization ────────────────────────────────────────

/**
 * Reject a candidate answer that cannot be the answer for this question shape.
 * @returns {string|null}
 */
export function acceptClientValue(label, value, { options = [], fieldType = '', profile = null } = {}) {
  if (value == null) return null;
  const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value).trim();
  if (!text) return null;
  // Stored YAML / fuzzy Apply Wizz "No" must never win on 16+/18+ working-age questions.
  if (isMinimumAgeQuestion(label) && extractYesNoAnswer(text) === 'No') return null;
  if (isYearsQuantityQuestion(label) && isInvalidYearsAnswer(text)) return null;
  if (isYesNoQuestionLabel(label) && !/checkbox-group|text|input|textarea/i.test(fieldType)) {
    const yn = extractYesNoAnswer(text);
    if (!yn) return null;
    if (options.length) {
      const hit = options.find((opt) => extractYesNoAnswer(opt) === yn);
      return hit || yn;
    }
    return yn;
  }
  if (/date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(label)) {
    return formatToMMDDYYYY(text) || text;
  }
  const normLabel = normalizeLabel(label);
  if (/^city$|^address--city$|\bcity\b/i.test(normLabel) && !/citizenship|capacity/i.test(normLabel)) {
    if (!isValidCityName(text)) return null;
  }
  if (/^state$|^address--countryregion$|\bstate\b/i.test(normLabel) && !/statement|status/i.test(normLabel)) {
    if (!isValidStateName(text)) return null;
  }
  return sanitizeExperienceAnswer(label, text, profile, { options, fieldType }) || text;
}

// ─── Tier 0: Pre-Resolved JSON lookup ────────────────────────────────────────

/**
 * Tier 0: Direct JSON lookup for pre-resolved answers from job_distributions.
 * During scanning all questions were answered and stored in job_distributions.resolved_answers.
 * Applications in ready_for_review have 100% complete answers in this JSON.
 */
export function lookupResolvedAnswerFromProfile(rawLabel, profile = {}, opts = {}) {
  if (!rawLabel || !profile) return null;
  const stripped = stripWorkdayQuestionLabel(rawLabel);
  const norm = normalizeLabel(stripped || rawLabel);
  if (!norm) return null;

  const options = opts.options || [];
  const fieldType = opts.fieldType || '';

  // 1. Direct Map lookup if initialized on profile
  const map = profile._resolvedAnswersMap;
  if (map instanceof Map && map.size > 0) {
    const entry = map.get(norm)
      || map.get(rawLabel)
      || map.get(String(rawLabel).toLowerCase().trim())
      || map.get(stripped)
      || map.get(normalizeLabel(rawLabel));
    if (entry && entry.answer !== undefined && entry.answer !== null && String(entry.answer).trim() !== '') {
      let aligned = entry.answer;
      if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
        aligned = alignAnswerToWorkdayOptions(entry.answer, options, fieldType) || entry.answer;
      }
      return {
        answer: aligned,
        source: 'job_distributions_resolved_answers',
        field_type: fieldType,
        tier: 0,
        matched_question: entry.rawQ || rawLabel,
      };
    }
  }

  // 2. Scan array profile._resolvedAnswersJson
  const list = profile._resolvedAnswersJson
    || profile._resolvedAnswers
    || (Array.isArray(profile.resolved_answers) ? profile.resolved_answers : null);

  if (Array.isArray(list) && list.length > 0) {
    // First pass: Exact or normalized match
    for (const item of list) {
      if (!item) continue;
      const ans = item.answer ?? item.value;
      if (ans === undefined || ans === null || String(ans).trim() === '') continue;
      const q = String(item.question || item.label || item.question_label || '').trim();
      const itemNorm = item.question_normalized || normalizeLabel(stripWorkdayQuestionLabel(q));
      if (itemNorm === norm || normalizeLabel(q) === norm || q.toLowerCase() === String(rawLabel).toLowerCase().trim()) {
        let aligned = ans;
        if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
          aligned = alignAnswerToWorkdayOptions(ans, options, fieldType) || ans;
        }
        return {
          answer: aligned,
          source: 'job_distributions_resolved_answers',
          field_type: fieldType,
          tier: 0,
          matched_question: q,
        };
      }
    }

    // Second pass: Token set / Fuzzy match (threshold 0.85)
    for (const item of list) {
      if (!item) continue;
      const ans = item.answer ?? item.value;
      if (ans === undefined || ans === null || String(ans).trim() === '') continue;
      const q = String(item.question || item.label || item.question_label || '').trim();
      const itemNorm = item.question_normalized || normalizeLabel(stripWorkdayQuestionLabel(q));
      if (!itemNorm) continue;

      const sim = Math.max(tokenSetRatio(itemNorm, norm), fuzzyScore(itemNorm, norm));
      if (sim >= 0.85) {
        let aligned = ans;
        if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
          aligned = alignAnswerToWorkdayOptions(ans, options, fieldType) || ans;
        }
        return {
          answer: aligned,
          source: 'job_distributions_resolved_answers',
          field_type: fieldType,
          tier: 0,
          matched_question: q,
          similarity: sim,
        };
      }
    }
  }

  return null;
}

// ─── Fast-path (synchronous) peek ─────────────────────────────────────────────

/**
 * Synchronous fast-path check for obvious answers (name, email, phone from profile)
 * without hitting any async tiers. Safe to call in synchronous contexts.
 *
 * @param {string} label       - question label
 * @param {object} profile     - hydrated client profile
 * @param {object} [opts]      - { options, fieldType }
 * @returns {string|null}
 */
export function peekClientAnswer(label, profile = {}, opts = {}) {
  const question = String(label || '').replace(/\s+/g, ' ').trim();
  if (!question || !profile) return null;
  const options = opts.options || [];
  const fieldType = opts.fieldType || '';

  // ─── Tier 0: Pre-Resolved JSON Lookup (PRIMARY) ───
  const fromResolvedJson = lookupResolvedAnswerFromProfile(question, profile, { options, fieldType });
  if (fromResolvedJson?.answer) {
    const jsonOk = acceptClientValue(question, fromResolvedJson.answer, { options, fieldType, profile });
    if (jsonOk) return jsonOk;
  }

  const priorEmployer = priorEmployerAnswer(question, profile);
  if (priorEmployer) return acceptClientValue(question, priorEmployer, { options, fieldType, profile }) || priorEmployer;

  const ageYes = resolveMinimumAgeAnswer(question, profile);
  if (ageYes) return acceptClientValue(question, ageYes, { options, fieldType, profile }) || ageYes;

  const sensitive = lookupSensitiveSafeAnswer(question);
  if (sensitive) return acceptClientValue(question, sensitive, { options, fieldType, profile }) || sensitive;

  // Identity fast-path (name, email, phone) — synchronous only
  const fromProfileIdentity = isPersonalIdentityQuestion(question) ? profileFactForLabel(question, profile) : null;
  if (fromProfileIdentity) return acceptClientValue(question, fromProfileIdentity, { options, fieldType, profile }) || fromProfileIdentity;

  // ─── Supabase in-memory sync lookup ───
  const fromSupabase = lookupSupabaseAnswerSync(question, profile, { options, fieldType });
  const supabaseOk = acceptClientValue(question, fromSupabase?.answer, { options, fieldType, profile });
  if (supabaseOk) return supabaseOk;

  // ─── Direct profile facts ───
  const fromProfile = profileFactForLabel(question, profile);
  const profileOk = acceptClientValue(question, fromProfile, { options, fieldType, profile });
  if (profileOk) return profileOk;

  return null;
}

// ─── Adult DOB derivation ──────────────────────────────────────────────────────

/**
 * Derives a valid adult Date of Birth (MM/DD/YYYY) when the field is strictly REQUIRED
 * and missing from Supabase, CRM, and Resume.
 * Uses candidate's graduation year (grad_year - 22) or experience milestones.
 */
export function deriveAdultDobFromProfile(profile = {}) {
  const gradYear = profile.education?.graduation_year
    || profile.education?.to_year
    || profile.education?.from_year
    || '';
  const gradNum = parseInt(String(gradYear).match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '', 10);
  if (gradNum && gradNum >= 1970 && gradNum <= 2030) {
    const birthYear = gradNum - 22;
    return `06/15/${birthYear}`;
  }

  const fromDate = profile.experience?.from_date || profile.experience?.start_date || '';
  const workStartNum = parseInt(String(fromDate).match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '', 10);
  if (workStartNum && workStartNum >= 1970 && workStartNum <= 2030) {
    const birthYear = workStartNum - 22;
    return `06/15/${birthYear}`;
  }

  const currentYear = new Date().getFullYear();
  return `06/15/${currentYear - 25}`;
}

// ─── Main async resolver ──────────────────────────────────────────────────────

/**
 * Resolve one question using the full 6-tier hierarchy via tierResolver.mjs.
 *
 * Resolution order:
 *   Tier 0: Pre-resolved JSON from job_distributions (fast skip)
 *   Tier 1: Supabase client_questions + clients table  (via tierResolver)
 *   Tier 2: Resume parsing facts                       (via tierResolver)
 *   Tier 3: Apply Wizz CRM Profile API                 (via tierResolver)
 *   Tier 4: Universal Q&A Bank                         (via tierResolver)
 *   Tier 5: Semantic + fuzzy composite match           (via tierResolver)
 *   Tier 6: LLM with bound context + auto-cache        (via tierResolver)
 *
 * @param {object|string} field   - Workday field descriptor or bare label string
 * @param {object} profile        - hydrated client profile
 * @param {object} [opts]         - { page, tenant, company, required, dryRun, jobUrl, isScanOnly, forceLlm, ... }
 * @returns {Promise<{ answer: string, source: string, field_type_code?: number, field_type?: string }|null>}
 */
export async function resolveClientAnswer(field = {}, profile = {}, opts = {}) {
  const enriched = enrichFieldWithTypeCode(typeof field === 'object' ? field : { label: field });
  const label = fieldLabel(enriched, typeof field === 'string' ? field : '');
  if (!label) return null;

  if (profile && isApplyWizzConfigured() && !profile._applyWizzHydrated) {
    await hydrateProfileFromApplyWizz(profile, opts);
  }

  const fieldType = enriched.fieldType || enriched.type || opts.fieldType || '';
  let options = fieldOptions(enriched).length ? fieldOptions(enriched) : (opts.options || []);
  if (!options.length && opts.page && /dropdown|select|combobox|radio/i.test(fieldType)) {
    try {
      const { collectLiveFieldOptions } = await import('./workdayDom.mjs');
      options = await collectLiveFieldOptions(opts.page, label, fieldType) || [];
    } catch { /* live option discovery is optional */ }
  }

  const code = enriched.field_type_code || fieldTypeToCode(fieldType);
  const required = enriched.required === true || opts.required === true || /\*/.test(label) || enriched.hasRequiredMarker === true;
  const currentStep = profile?._currentStepIndex || 2;
  const clientId = profile?._applyWizzId || profile?.applywizz_id || profile?.client_id || process.env.APPLYWIZZ_ID || '';
  const tenant = opts.tenant || profile?._tenant || '';

  const finish = (answer, source) => {
    const value = acceptClientValue(label, answer, { options, fieldType, profile });
    if (!value) return null;
    return { answer: value, source, field_type_code: code, field_type: fieldType };
  };

  // ─── Special: Password ───────────────────────────────────────────────────
  if (/password/i.test(label) || fieldType === 'password') {
    const pwd = profile.password || process.env.WORKDAY_PASSWORD || 'Applywizz@2026789';
    console.log(`    🔑 [Password] "${label.slice(0, 55)}" ← (auto-filled workday password)`);
    return { answer: pwd, source: 'workday_password', field_type_code: code, field_type: fieldType };
  }

  // ─── Tier 0: Pre-Resolved JSON from job_distributions ───────────────────
  const preResolvedHit = lookupResolvedAnswerFromProfile(label, profile, { options, fieldType });
  if (preResolvedHit?.answer) {
    const validated = finish(preResolvedHit.answer, preResolvedHit.source);
    if (validated) {
      console.log(`    ⚡ [Tier 0 Pre-Resolved JSON] "${label.slice(0, 55)}" ← "${validated.answer}" (${preResolvedHit.matched_question || 'exact'})`);
      profile?._onLog?.(currentStep, `[Tier 0 JSON Match] "${label.slice(0, 50)}" ← "${validated.answer}"`);
      return validated;
    }
  }

  // ─── Age / Safety guards ─────────────────────────────────────────────────
  const ageYes = resolveMinimumAgeAnswer(label, profile);
  if (ageYes) {
    console.log(`    🎂 [Age] "${label.slice(0, 55)}" ← "Yes"`);
    return { answer: ageYes, source: 'minimum_age', field_type_code: code, field_type: fieldType };
  }

  // ─── Fast-path: profile identity facts (name, email, phone) ──────────────
  const fromProfileIdentity = isPersonalIdentityQuestion(label) ? profileFactForLabel(label, profile) : null;
  if (fromProfileIdentity) {
    const hit = finish(fromProfileIdentity, 'supabase_client_fact');
    if (hit) {
      console.log(`    👤 [Identity] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Identity] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // ─── Profile facts (Tier 1 fast-path before async waterfall) ─────────────
  const domainQuestion = isYearsQuantityQuestion(label)
    || isDescribeExperienceQuestion(label)
    || isProceedQuestion(label);
  const fromProfile = profileFactForLabel(label, profile);
  if (fromProfile && !domainQuestion) {
    const hit = finish(fromProfile, 'supabase_clients_table');
    if (hit) {
      console.log(`    🗄️  [Profile Fact] "${label.slice(0, 55)}" ← "${hit.answer.slice(0, 40)}"`);
      profile?._onLog?.(currentStep, `[Profile Fact] "${label.slice(0, 50)}" ← "${hit.answer.slice(0, 45)}"`);
      return hit;
    }
  }

  // ─── Sensitive safe fallback (before full waterfall) ──────────────────────
  const sensitive = lookupSensitiveSafeAnswer(label);
  if (sensitive) {
    const hit = finish(sensitive, 'sensitive_safe');
    if (hit) {
      console.log(`    🛡️  [Sensitive Safe] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      profile?._onLog?.(currentStep, `[Compliance Safe] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // ─── Tiers 1-6: Full waterfall via tierResolver.mjs ──────────────────────
  // Only required questions, domain questions, and forceLlm=true proceed to the waterfall.
  // Optional non-domain questions return null early unless explicitly requested.
  const availabilityTiming = /available\s*to\s*start|when\s*(are|can)\s*you\s*start|how\s*soon\s*can\s*you\s*start|desired\s*start|earliest\s*start/i.test(label);
  if (!required && opts.forceLlm !== true && !domainQuestion && !availabilityTiming) {
    return null;
  }

  const qaBank = profile._qaBank || profile._supabaseQa || {};

  const tierResult = await resolveAnswer({
    question: label,
    fieldType,
    options,
    clientProfile: profile,
    clientId,
    qaBank,
    opts: {
      ...opts,
      required,
      tenant,
    },
  });

  if (tierResult?.answer) {
    const hit = finish(tierResult.answer, tierResult.sourceType);
    if (hit) {
      profile?._onLog?.(currentStep, `[Tier ${tierResult.tier} ${tierResult.sourceType}] "${label.slice(0, 50)}" ← "${hit.answer.slice(0, 45)}"`);
      return hit;
    }
  }

  // ─── Proceed questions always get Yes ────────────────────────────────────
  if (isProceedQuestion(label)) {
    const yes = options.find((opt) => /^yes\b/i.test(opt)) || 'Yes';
    const proceed = finish(yes, 'proceed_continue');
    if (proceed) {
      console.log(`    ✅ [Proceed] "${label.slice(0, 55)}" ← "${proceed.answer}"`);
      return proceed;
    }
  }

  // ─── Scan-mode placeholder ────────────────────────────────────────────────
  if (opts.isScanOnly || profile?._isScanOnly || opts.dryRun) {
    let placeholder = 'N/A';
    if (/number|numeric|spin/i.test(fieldType)) {
      placeholder = '1';
    } else if (/date/i.test(fieldType)) {
      placeholder = '01/15/2020';
    } else if (/check/i.test(fieldType)) {
      placeholder = 'true';
    } else if (options.length > 0) {
      placeholder = options.find((o) => /^yes\b/i.test(o)) || options[0];
    } else {
      const pFact = profileFactForLabel(label, profile);
      if (pFact) placeholder = String(pFact);
    }

    const placeholderHit = finish(placeholder, 'scan_placeholder');
    if (placeholderHit) {
      console.log(`    🛠️  [Scan Placeholder] "${label.slice(0, 55)}" ← "${placeholderHit.answer}"`);
      import('./masterYamlManager.mjs').then(({ saveMasterYamlTemplate }) => {
        saveMasterYamlTemplate([{
          question: label,
          field_type: fieldType,
          step: currentStep,
          options,
          value: placeholderHit.answer,
          source: 'scan_placeholder',
        }], { tenant, company: opts.company, mockAwlId: profile?._applyWizzId || 'AWL-1568' }).catch(() => {});
      }).catch(() => {});
      return placeholderHit;
    }
  }

  // ─── Submission-mode safe required fallback ───────────────────────────────
  const isSubmissionMode = Boolean(
    required
    || opts.isSubmission
    || opts.confirmSubmit
    || profile?._isSubmission
    || opts.forceLlm
    || !opts.isScanOnly,
  );

  if (isSubmissionMode) {
    let fallback = null;
    const lower = label.toLowerCase();

    // 1. Consent / Agreement / Certification / Acknowledgments
    if (/agree|accept|certify|acknowledge|consent|terms|statement|declaration|confirm|policy|understand|permission/i.test(lower)) {
      if (/check/i.test(fieldType)) {
        fallback = 'true';
      } else if (options.length > 0) {
        fallback = options.find((o) => /^yes|agree|accept|acknowledge/i.test(o)) || options[0];
      } else {
        fallback = 'Yes';
      }
    }
    // 2. Radio or Dropdown options
    else if (options.length > 0) {
      // Sensitive negative questions (criminal history, conviction, etc.) → No
      if (/convict|crime|felon|misdemeanor|discharge|fired|terminate|suspend|violation|bankrupt/i.test(lower)) {
        fallback = options.find((o) => /^no\b/i.test(o)) || options[0];
      }
      // General affirmative questions → Yes
      else if (/authoriz|eligib|permit|availab|relocat|travel|overtime|shift|willing|able|legally/i.test(lower)) {
        fallback = options.find((o) => /^yes\b/i.test(o)) || options[0];
      }
      // EEO / voluntary disclosures → Prefer not to say / Decline
      else if (/gender|race|ethnic|veteran|disability|sexual/i.test(lower)) {
        fallback = options.find((o) => /prefer\s*not|decline|do\s*not\s*wish|choose\s*not/i.test(o)) || options[0];
      }
      // Prior employment → No
      else if (/previously\s*employed|worked\s*for|former\s*employee/i.test(lower)) {
        fallback = options.find((o) => /^no\b/i.test(o)) || options[0];
      } else {
        // Safe default: Yes if available, else first option
        fallback = options.find((o) => /^yes\b/i.test(o)) || options[0];
      }
    }
    // 3. Numbers / Years
    else if (/number|numeric|spin|year|month/i.test(fieldType) || /how\s*many|years\s*of/i.test(lower)) {
      fallback = '1';
    }
    // 4. Date
    else if (/date/i.test(fieldType) || /date/i.test(lower)) {
      if (/birth|dob/i.test(lower)) {
        fallback = deriveAdultDobFromProfile(profile);
      } else {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yyyy = d.getFullYear();
        fallback = `${mm}/${dd}/${yyyy}`;
      }
    }
    // 5. Checkbox
    else if (/check/i.test(fieldType)) {
      fallback = 'true';
    }
    // 6. Text / Signature
    else {
      if (isSignatureOrFullNameQuestion(label)) {
        fallback = toTitleCase(profile?.personal?.full_name || [profile?.personal?.first_name, profile?.personal?.last_name].filter(Boolean).join(' ') || profile?.name || 'Applicant');
      } else {
        fallback = 'Yes';
      }
    }

    const safeFallbackHit = finish(fallback, 'safe_required_fallback');
    if (safeFallbackHit) {
      console.log(`    🛡️  [Safe Required Fallback] "${label.slice(0, 55)}" ← "${safeFallbackHit.answer}"`);
      return safeFallbackHit;
    }
  }

  // All tiers exhausted — unanswerable field
  console.log(`    ⚠️  No answer found (Tiers 0-6 exhausted) for "${label.slice(0, 55)}"`);
  return { answer: null, requiresReview: true, status: 'needs_answers' };
}

export { normalizeLabel };
