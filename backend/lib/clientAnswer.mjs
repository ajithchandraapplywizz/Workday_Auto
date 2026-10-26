/**
 * clientAnswer.mjs — Single answer path for every Workday question.
 *
 *   0. 16+/18+ working-age questions → Yes (DOB years if present; jobs are 18+)
 *   1. Apply Wizz client API (hydrated profile + Q&A index)
 *   2. Facts on that API profile (identity, work auth, EEO, dates, salary)
 *   3. Resume-backed experience answers
 *   4. LLM + live Playwright options
 *
 * Default: API-only mode — no profile.yml qa_answers or local qa-store (USE_LOCAL_PROFILE_QA=1 to restore).
 */

import { hydrateProfileFromApplyWizz, resolveDomQuestionFromApplyWizz, isApplyWizzConfigured, saveApplyWizzClientAnswer } from './applyWizzClient.mjs';
import { formatPlainUsPhone, normalizePhoneForCountry, workdayPhoneCodeForCountry, isValidCityName, isValidStateName } from './clientContact.mjs';
import { resolveUnknownWithLlm, isOpenRouterEnabled, isPersonalIdentityQuestion } from './openRouterLlm.mjs';
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
import { fuzzyScore } from './fields.mjs';
import {
  lookupSupabaseAnswer,
  lookupSupabaseAnswerSync,
  lookupQaBankAnswerSync,
  upsertQaBankAnswer,
  isSupabaseConfigured,
  upsertSupabaseAnswer,
  recordSupabaseAnswerInMemory,
  getScannedJob,
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

function fieldOptions(field = {}) {
  return (field.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function fieldLabel(field = {}, fallback = '') {
  return String(field.questionLabel || field.label || field.id || field.name || fallback || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAvailabilityTimingQuestion(label = '') {
  return /available\s*to\s*start|when\s*(are|can)\s*you\s*start|how\s*soon\s*can\s*you\s*start|desired\s*start|earliest\s*start/i.test(label);
}

export function isReferralSourceQuestion(label = '') {
  return /how\s*did\s*you\s*hear|where\s*did\s*you\s*(hear|find)|referral\s*source|^source$/i.test(String(label || ''));
}

export function pickDeterministicSourceOption(options = []) {
  const list = (options || []).map((o) => String(o?.text || o || '').trim()).filter(Boolean);
  if (!list.length) return 'LinkedIn';

  const findOpt = (regex) => list.find((o) => regex.test(o));

  return findOpt(/^linkedin\b/i)
    || findOpt(/linkedin/i)
    || findOpt(/company\s*website|corporate\s*website|careers?\s*(page|site|portal)/i)
    || findOpt(/external\s*career\s*(sites?|sources?|portal|web)/i)
    || findOpt(/job\s*boards?/i)
    || findOpt(/^indeed\b/i)
    || findOpt(/^glassdoor\b/i)
    || findOpt(/internet|online|website/i)
    || findOpt(/other/i)
    || list[0];
}

export function pickDeterministicRaceOption(requestedRace = '', options = []) {
  const list = (options || []).map((o) => String(o?.text || o || '').trim()).filter(Boolean);
  const target = String(requestedRace || 'Asian').trim().toLowerCase();

  if (list.length > 0) {
    if (target) {
      const exactOrIncludes = list.find((o) => o.toLowerCase() === target || o.toLowerCase().includes(target));
      if (exactOrIncludes) return exactOrIncludes;
    }
    const asian = list.find((o) => /asian/i.test(o));
    if (asian) return asian;
    const decline = list.find((o) => /decline|prefer not|choose not|not wish|two or more/i.test(o));
    if (decline) return decline;
    return list[0];
  }
  return requestedRace || 'Asian';
}

export async function lookupScannedJobAnswer(label, profile = {}, opts = {}) {
  const jobUrl = opts.jobUrl || profile?._jobUrl || profile?._canonicalJobUrl || '';
  if (!jobUrl) return null;

  if (isPersonalIdentityQuestion(label)) return null;
  const n = normalizeLabel(label);
  if (/^(first|last|middle|full|legal)?\s*name$|^email|^phone|^address|postal|zip|^dob\b|date\s*of\s*birth|resume/i.test(n)) {
    return null;
  }

  try {
    let resolvedAnswers = profile?._scannedJobAnswers || null;
    if (!resolvedAnswers) {
      const scannedJob = await getScannedJob(jobUrl);
      if (scannedJob && Array.isArray(scannedJob.resolved_answers)) {
        resolvedAnswers = scannedJob.resolved_answers;
        if (profile) profile._scannedJobAnswers = resolvedAnswers;
      }
    }

    if (Array.isArray(resolvedAnswers) && resolvedAnswers.length > 0) {
      const hit = resolvedAnswers.find((item) => {
        const itemQ = item.question || item.question_normalized || item.label || '';
        return normalizeLabel(itemQ) === n && item.answer != null && String(item.answer).trim() !== '';
      });
      if (hit && hit.answer) {
        return { answer: String(hit.answer), source: 'scanned_jobs_shared', tier: 1 };
      }
    }
  } catch {}
  return null;
}

/**
 * Facts that already live on the hydrated client profile — never a hardcoded Yes/No.
 */
function profileFactForLabel(label, profile = {}) {
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

/**
 * Reject a candidate that cannot be the answer for this question shape.
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

/**
 * Sync peek: age/safety first, then Tier 1 (Supabase clients table -> client_questions table) -> Tier 2 (Resume parsing).
 * Never calls the LLM.
 */

/**
 * Tier 4: Fuzzy Match Cross-Check
 * Cross-checks Supabase DB (client_questions), Resume parsed facts/text, and QA Bank table.
 * Approximate/fuzzy matches (0.55 <= score < 1.0). Exact matches are reserved for Tier 1 / Tier 5.
 * @returns {{ answer: string, source: string, score: number, matchedKey?: string, tier: number }|null}
 */
export function fuzzyMatchCrossCheck(rawLabel, profile = {}, opts = {}) {
  const norm = normalizeLabel(rawLabel);
  if (!norm || norm.length < 3) return null;

  const options = opts.options || [];
  const fieldType = opts.fieldType || '';

  const align = (val) => {
    return acceptClientValue(rawLabel, val, { options, fieldType, profile });
  };

  let best = null;
  let bestScore = 0;

  // 1. Cross-check Supabase client_questions (_supabaseQa) for fuzzy matches
  const qa = profile._supabaseQa || {};
  for (const [k, v] of Object.entries(qa)) {
    if (!v || typeof v !== 'string' || v.length > 500) continue;
    const normK = normalizeLabel(k);
    if (normK === norm) continue; // Exact matches handled in Tier 1
    const score = fuzzyScore(norm, normK);
    if (score > bestScore && score >= 0.55 && score < 1.0) {
      const aligned = align(v);
      if (aligned) {
        bestScore = score;
        best = { answer: aligned, source: 'fuzzy_supabase_db', score, matchedKey: k, tier: 4 };
      }
    }
  }

  // 2. Cross-check QA Bank table (_supabaseQaBank) for fuzzy matches
  const qaBank = profile._supabaseQaBank || {};
  for (const [k, v] of Object.entries(qaBank)) {
    if (!v || typeof v !== 'string' || v.length > 500) continue;
    const normK = normalizeLabel(k);
    if (normK === norm) continue; // Exact matches handled in Tier 5 QA Bank
    const score = fuzzyScore(norm, normK);
    if (score > bestScore && score >= 0.55 && score < 1.0) {
      const aligned = align(v);
      if (aligned) {
        bestScore = score;
        best = { answer: aligned, source: 'fuzzy_qa_bank', score, matchedKey: k, tier: 4 };
      }
    }
  }

  // 3. Cross-check Resume parsed text & facts (for skill/experience fuzzy matches)
  if (profile._resumeText && options.length && !best) {
    const lowerResume = (profile._resumeText || '').toLowerCase();
    const words = norm.split(/\s+/).filter(w => w.length >= 4 && !/^(have|years|experience|with|about|role|please|select|indicate|your)\b/i.test(w));
    if (words.length > 0) {
      const matchCount = words.filter(w => lowerResume.includes(w)).length;
      const ratio = matchCount / words.length;
      if (ratio >= 0.6) {
        const yesOpt = options.find(o => /^yes\b/i.test(o));
        if (yesOpt) {
          best = { answer: yesOpt, source: 'fuzzy_resume_skills', score: ratio, tier: 4 };
        }
      }
    }
  }

  // 4. Cross-check ApplyWizz QA for fuzzy matches
  const awQa = profile._applyWizzQa || {};
  for (const [k, v] of Object.entries(awQa)) {
    if (!v || typeof v !== 'string') continue;
    const normK = normalizeLabel(k);
    if (normK === norm) continue;
    const score = fuzzyScore(norm, normK);
    if (score > bestScore && score >= 0.55 && score < 1.0) {
      const aligned = align(v);
      if (aligned) {
        bestScore = score;
        best = { answer: aligned, source: 'fuzzy_crm_api', score, matchedKey: k, tier: 4 };
      }
    }
  }

  return best;
}

export function peekClientAnswer(label, profile = {}, opts = {}) {
  const question = String(label || '').replace(/\s+/g, ' ').trim();
  if (!question || !profile) return null;
  const options = opts.options || [];
  const fieldType = opts.fieldType || '';

  const priorEmployer = priorEmployerAnswer(question, profile);
  if (priorEmployer) return acceptClientValue(question, priorEmployer, { options, fieldType, profile }) || priorEmployer;

  const ageYes = resolveMinimumAgeAnswer(question, profile);
  if (ageYes) return acceptClientValue(question, ageYes, { options, fieldType, profile }) || ageYes;

  const sensitive = lookupSensitiveSafeAnswer(question);
  if (sensitive) return acceptClientValue(question, sensitive, { options, fieldType, profile }) || sensitive;

  const fromProfileIdentity = isPersonalIdentityQuestion(question) ? profileFactForLabel(question, profile) : null;
  if (fromProfileIdentity) return acceptClientValue(question, fromProfileIdentity, { options, fieldType, profile }) || fromProfileIdentity;

  const currentStep = profile?._currentStepIndex || 2;

  // ─── TIER 1: Supabase Direct Answer (clients table -> client_questions table) ───
  // 1a. Check Supabase client_questions table with respective AWL ID
  const fromSupabase = lookupSupabaseAnswerSync(question, profile, { options, fieldType });
  const supabaseOk = acceptClientValue(question, fromSupabase?.answer, { options, fieldType, profile });
  if (supabaseOk) return supabaseOk;

  // 1b. Check Supabase clients table facts
  const fromProfile = profileFactForLabel(question, profile);
  const profileOk = acceptClientValue(question, fromProfile, { options, fieldType, profile });
  if (profileOk) return profileOk;

  // ─── TIER 2: Resume Parsing (Primary Source of Truth for Experience & Skills) ───
  const fromExperience = resolveExperienceQuestionAnswer(question, profile, { options, fieldType });
  const expOk = acceptClientValue(question, fromExperience?.answer, { options, fieldType, profile });
  if (expOk) return expOk;

  // ─── TIER 3: CRM API (Apply Wizz Candidate Context) ────────────────────────
  const fromApi = resolveDomQuestionFromApplyWizz(question, profile, {
    options,
    fieldType,
    threshold: 0.75,
  });
  const apiOk = acceptClientValue(question, fromApi?.answer, { options, fieldType, profile });
  if (apiOk && !/fuzzy|substring/.test(String(fromApi?.source || ''))) return apiOk;

  // ─── TIER 4: Fuzzy Match Cross-Check (Supabase DB + Resume + QA Bank) ───────
  const fromFuzzy = fuzzyMatchCrossCheck(question, profile, { options, fieldType });
  const fuzzyOk = acceptClientValue(question, fromFuzzy?.answer, { options, fieldType, profile });
  if (fuzzyOk) return fuzzyOk;

  // ─── TIER 5: QA Bank Table in Supabase (1,839+ curated Q&A records) ─────────
  const fromQaBank = lookupQaBankAnswerSync(question, profile, { options, fieldType });
  const qaBankOk = acceptClientValue(question, fromQaBank?.answer, { options, fieldType, profile });
  if (qaBankOk) return qaBankOk;

  return null;
}

/**
 * Resolve one question across the strict 3-tier hierarchy:
 *   Tier 1: Supabase direct answer (clients table facts -> client_questions table)
 *   Tier 2: Resume parsing (experience facts and resume text)
 *   Tier 3: LLM human-like analysis using live Playwright DOM options
 *           (persisted directly to Supabase client_questions table with AWL ID)
 * @returns {Promise<{ answer: string, source: string, field_type_code?: number }|null>}
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
  const availabilityTiming = isAvailabilityTimingQuestion(label);

  const finish = (answer, source, tier = 1) => {
    const value = acceptClientValue(label, answer, { options, fieldType, profile });
    if (!value) return null;
    return { answer: value, source, field_type_code: code, field_type: fieldType, tier };
  };

  // 0. Legal & safety guards
  if (/password/i.test(label) || fieldType === 'password') {
    const pwd = profile.password || process.env.WORKDAY_PASSWORD || '';
    console.log(`    🔑 [Password] "${label.slice(0, 55)}" ← (auto-filled workday password)`);
    return { answer: pwd, source: 'workday_password', field_type_code: code, field_type: fieldType, tier: 1 };
  }

  const ageYes = resolveMinimumAgeAnswer(label, profile);
  if (ageYes) {
    const hit = { answer: ageYes, source: 'minimum_age', field_type_code: code, field_type: fieldType, tier: 1 };
    console.log(`    🎂 [Age] "${label.slice(0, 55)}" ← "Yes"`);
    return hit;
  }


  const currentStep = profile?._currentStepIndex || 2;

  // ─── TIER 1: Supabase Direct Answer (clients table -> client_questions table) ───
  // 1a. Core Identity from Supabase clients table (name, phone, email, address)
  const fromProfileIdentity = isPersonalIdentityQuestion(label) ? profileFactForLabel(label, profile) : null;
  if (fromProfileIdentity) {
    const hit = finish(fromProfileIdentity, 'supabase_client_fact', 1);
    if (hit) {
      console.log(`    👤 [Identity] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Identity Match] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // 1b. Exact question-and-answer from Supabase client_questions table for this client (AWL ID)
  const fromSupabase = await lookupSupabaseAnswer(label, profile, { options, fieldType });
  if (fromSupabase?.answer) {
    const supabaseHit = finish(fromSupabase.answer, fromSupabase.source || 'supabase_client_questions', 1);
    if (supabaseHit) {
      console.log(`    🗄️  [Supabase Tier 1 client_questions] "${label.slice(0, 55)}" ← "${supabaseHit.answer.slice(0, 40)}" (${fromSupabase.source})`);
      profile?._onLog?.(currentStep, `[Tier 1 Supabase Match] "${label.slice(0, 50)}" ← "${supabaseHit.answer.slice(0, 45)}"`);
      return supabaseHit;
    }
  }

  // 1c. Other attributes from Supabase clients table (education, degree, skills, dates)
  const fromProfile = profileFactForLabel(label, profile);
  const domainQuestion = isYearsQuantityQuestion(label)
    || isDescribeExperienceQuestion(label)
    || isProceedQuestion(label);
  if (fromProfile && !domainQuestion) {
    const hit = finish(fromProfile, 'supabase_clients_table', 1);
    if (hit) {
      console.log(`    🗄️  [Supabase Tier 1 clients table] "${label.slice(0, 55)}" ← "${hit.answer.slice(0, 40)}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Profile Match] "${label.slice(0, 50)}" ← "${hit.answer.slice(0, 45)}"`);
      return hit;
    }
  }

  const priorEmployer = priorEmployerAnswer(label, profile);
  if (priorEmployer) {
    const hit = finish(priorEmployer, 'supabase_clients_table', 1);
    if (hit) {
      console.log(`    🧾 [Supabase Tier 1 Prior Employer] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Prior Employer] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // 1d. Universal General Question: "How Did You Hear About Us?" / Referral Source (NEVER LLM)
  if (isReferralSourceQuestion(label)) {
    const fromScannedJob = await lookupScannedJobAnswer(label, profile, opts);
    let chosenSource = fromScannedJob?.answer || null;
    if (chosenSource && options.length > 0) {
      const match = options.find((o) => o.toLowerCase().includes(chosenSource.toLowerCase()));
      if (match) chosenSource = match;
    }
    if (!chosenSource) {
      chosenSource = pickDeterministicSourceOption(options);
    }
    const hit = finish(chosenSource, fromScannedJob ? 'scanned_jobs_shared' : 'deterministic_common_source', 1);
    if (hit) {
      console.log(`    📢 [Tier 1 Referral Source] "${label.slice(0, 55)}" ← "${hit.answer}" (${hit.source})`);
      profile?._onLog?.(currentStep, `[Tier 1 Referral Source] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // 1e. Protected EEO Demographic Question: Race / Ethnicity (NEVER LLM)
  if (/\b(race|ethnicity)\b/i.test(label) && !/hispanic|latino/i.test(label)) {
    const clientRace = profile?.eeo?.race || profileFactForLabel(label, profile);
    let chosenRace = clientRace;
    if (!chosenRace) {
      const fromScannedJob = await lookupScannedJobAnswer(label, profile, opts);
      if (fromScannedJob?.answer) chosenRace = fromScannedJob.answer;
    }
    chosenRace = pickDeterministicRaceOption(chosenRace || 'Asian', options);
    const hit = finish(chosenRace, clientRace ? 'client_profile_race' : 'deterministic_common_race', 1);
    if (hit) {
      console.log(`    🤝 [Tier 1 EEO Race/Ethnicity] "${label.slice(0, 55)}" ← "${hit.answer}" (${hit.source})`);
      profile?._onLog?.(currentStep, `[Tier 1 Demographic Match] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // 1f. Shared Non-Personal Answers from scanned_jobs (Lead Blueprint Candidate)
  const fromScannedJob = await lookupScannedJobAnswer(label, profile, opts);
  if (fromScannedJob?.answer) {
    const hit = finish(fromScannedJob.answer, 'scanned_jobs_shared', 1);
    if (hit) {
      console.log(`    📋 [Tier 1 scanned_jobs Shared] "${label.slice(0, 55)}" ← "${hit.answer.slice(0, 40)}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Blueprint Shared] "${label.slice(0, 50)}" ← "${hit.answer.slice(0, 45)}"`);
      return hit;
    }
  }

  const clientId = profile?._applyWizzId || profile?.applywizz_id || profile?.client_id || process.env.APPLYWIZZ_ID || '';
  const tenant = opts.tenant || profile?._tenant || '';

  // ─── TIER 2: Resume Parsing (Primary Source of Truth for Experience & Skills) ───
  const fromExperience = resolveExperienceQuestionAnswer(label, profile, { options, fieldType });
  let expHit = finish(fromExperience?.answer, `experience/${fromExperience?.source || 'resume'}`, 2);
  
  if (!expHit && profile._resumeText) {
    // Check if question asks about specific skill / experience in resume
    const { inferAnswerFromResume } = await import('./resumeParser.mjs');
    const directInfer = inferAnswerFromResume(label, profile._resumeText, { options, fieldType });
    if (directInfer) {
      let inferVal = directInfer;
      if (isYesNoQuestionLabel(label) && options.length) {
        inferVal = options.find(o => /^yes\b/i.test(o)) || 'Yes';
      }
      expHit = finish(inferVal, 'resume_direct_infer', 2);
    } else if (isYesNoQuestionLabel(label) && options.length) {
      // If asking "Do you have at least X years experience in <tech>", check if tech is in resume
      const lowerResume = (profile._resumeText || '').toLowerCase();
      const topicTokens = (label.toLowerCase().match(/[a-z0-9+#.]{3,}/g) || [])
        .filter(t => !/^(have|least|years|experience|with|systems|distributed|the|for|you|and|are)\b/i.test(t));
      const hasTopic = topicTokens.length > 0 && topicTokens.some(t => lowerResume.includes(t));
      if (hasTopic) {
        const yesOpt = options.find(o => /^yes\b/i.test(o)) || 'Yes';
        expHit = finish(yesOpt, 'resume_keyword_match', 2);
      }
    }
  }

  // DOB resolution in Tier 2: Resume text extraction -> Required adult derivation
  if (!expHit && /date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(label)) {
    if (profile._resumeText) {
      const fromResume = extractDobFromResumeText(profile._resumeText);
      if (fromResume) {
        expHit = finish(fromResume, 'resume_extracted_dob', 2);
        if (expHit && profile._applyWizzId) {
          recordSupabaseAnswerInMemory(profile, 'date of birth', fromResume);
          upsertSupabaseAnswer({
            applywizzId: profile._applyWizzId,
            question: label,
            questionNormalized: 'date of birth',
            answer: fromResume,
            fieldType: 'date',
            source: 'resume',
          }).catch(() => {});
        }
      }
    }

    if (!expHit && (required || opts.forceLlm === true)) {
      const derivedDob = deriveAdultDobFromProfile(profile);
      if (derivedDob) {
        expHit = finish(derivedDob, 'derived_adult_dob', 2);
        if (expHit && profile._applyWizzId) {
          recordSupabaseAnswerInMemory(profile, 'date of birth', derivedDob);
          upsertSupabaseAnswer({
            applywizzId: profile._applyWizzId,
            question: label,
            questionNormalized: 'date of birth',
            answer: derivedDob,
            fieldType: 'date',
            source: 'ai',
          }).catch(() => {});
        }
      }
    }

    // If NOT required and not found in Supabase or Resume, do NOT fill optional DOB
    if (!required && opts.forceLlm !== true && !expHit) {
      return null;
    }
  }

  if (expHit) {
    trace({
      stage: 'tier2',
      clientId,
      tenant,
      query: normalizeLabel(label),
      hit: true,
      source: expHit.source || fromExperience?.source || 'resume',
      answer: expHit.answer,
    });
    console.log(`    📄 [Resume Tier 2 Match] "${label.slice(0, 55)}" ← "${expHit.answer.slice(0, 40)}"`);
    profile?._onLog?.(currentStep, `[Tier 2 Resume Extraction] "${label.slice(0, 50)}" ← "${expHit.answer.slice(0, 45)}"`);
    return expHit;
  }
  trace({ stage: 'tier2', clientId, tenant, query: normalizeLabel(label), hit: false });

  // ─── TIER 3: CRM API (Apply Wizz Candidate Context) ────────────────────────
  const fromApi = resolveDomQuestionFromApplyWizz(label, profile, {
    options,
    fieldType,
    threshold: 0.75,
  });
  const apiIsFuzzy = /fuzzy|substring/.test(String(fromApi?.source || ''));
  if (fromApi?.answer && !apiIsFuzzy) {
    const apiHit = finish(fromApi.answer, fromApi.source || 'applywizz_api', 3);
    if (apiHit) {
      trace({
        stage: 'tier3',
        clientId,
        tenant,
        query: normalizeLabel(label),
        hit: true,
        source: fromApi.source,
        answer: apiHit.answer,
      });
      console.log(`    🌐 [CRM API Tier 3] "${label.slice(0, 55)}" ← "${apiHit.answer.slice(0, 40)}"`);
      profile?._onLog?.(currentStep, `[Tier 3 CRM Match] "${label.slice(0, 50)}" ← "${apiHit.answer.slice(0, 45)}"`);
      return apiHit;
    }
  }
  trace({ stage: 'tier3', clientId, tenant, query: normalizeLabel(label), hit: false });

  // ─── TIER 4: Fuzzy Match Cross-Check (Supabase DB + Resume + QA Bank) ───────
  const fromFuzzy = fuzzyMatchCrossCheck(label, profile, { options, fieldType });
  if (fromFuzzy?.answer) {
    const fuzzyHit = finish(fromFuzzy.answer, fromFuzzy.source || 'fuzzy_cross_check', 4);
    if (fuzzyHit) {
      trace({
        stage: 'tier4',
        clientId,
        tenant,
        query: normalizeLabel(label),
        hit: true,
        source: fuzzyHit.source,
        answer: fuzzyHit.answer,
      });
      console.log(`    🔍 [Fuzzy Tier 4 Match] "${label.slice(0, 55)}" ← "${fuzzyHit.answer.slice(0, 40)}" (${fromFuzzy.source}, score ${(fromFuzzy.score || 0).toFixed(2)})`);
      profile?._onLog?.(currentStep, `[Tier 4 Fuzzy Match] "${label.slice(0, 50)}" ← "${fuzzyHit.answer.slice(0, 45)}"`);
      return fuzzyHit;
    }
  }
  trace({ stage: 'tier4', clientId, tenant, query: normalizeLabel(label), hit: false });

  // ─── TIER 5: QA Bank Table in Supabase (1,839+ curated Q&A records) ─────────
  const fromQaBank = lookupQaBankAnswerSync(label, profile, { options, fieldType });
  if (fromQaBank?.answer) {
    const qaHit = finish(fromQaBank.answer, fromQaBank.source || 'qa_bank', 5);
    if (qaHit) {
      trace({
        stage: 'tier5',
        clientId,
        tenant,
        query: normalizeLabel(label),
        hit: true,
        source: fromQaBank.source,
        answer: qaHit.answer,
      });
      console.log(`    🏦 [QA Bank Tier 5 Table] "${label.slice(0, 55)}" ← "${qaHit.answer.slice(0, 40)}" (${fromQaBank.source})`);
      profile?._onLog?.(currentStep, `[Tier 5 QA Bank Match] "${label.slice(0, 50)}" ← "${qaHit.answer.slice(0, 45)}"`);
      return qaHit;
    }
  }
  trace({ stage: 'tier5', clientId, tenant, query: normalizeLabel(label), hit: false });

  // ─── Safe Legal & Compliance Fallbacks (when not answered in Tier 1, 2, or 3) ───
  const sensitive = lookupSensitiveSafeAnswer(label);
  if (sensitive) {
    const hit = finish(sensitive, 'sensitive_safe');
    if (hit) {
      trace({
        stage: 'sensitive_safe',
        clientId,
        tenant,
        query: normalizeLabel(label),
        hit: true,
        answer: hit.answer,
      });
      console.log(`    🛡️  [Sensitive Safe] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      profile?._onLog?.(currentStep, `[Tier 1 Compliance Safe] "${label.slice(0, 50)}" ← "${hit.answer}"`);
      return hit;
    }
  }


  // Only mandatory/required questions proceed to LLM unless forceLlm is set
  if (!required && opts.forceLlm !== true && !domainQuestion && !availabilityTiming) {
    return null;
  }

  // ─── TIER 6: Semantic Analysis & LLM AI with Live Playwright DOM Context ───────────────────
  // Referral source and demographic questions must NEVER enter LLM tier
  if (isReferralSourceQuestion(label)) {
    const fallbackSource = pickDeterministicSourceOption(options);
    const hit = finish(fallbackSource, 'deterministic_common_source', 1);
    if (hit) return hit;
  }
  if (/\b(race|ethnicity)\b/i.test(label) && !/hispanic|latino/i.test(label)) {
    const fallbackRace = pickDeterministicRaceOption(profile?.eeo?.race || 'Asian', options);
    const hit = finish(fallbackRace, 'deterministic_common_race', 1);
    if (hit) return hit;
  }

  // (4) Tier 4 LLM must never answer work-auth, sponsorship, or EEO questions.
  const isProtectedCompliance = /authorized to work|authori[sz]ed|work auth|visa|sponsor|veteran|disability|gender|sex|race|ethnicity|hispanic|latino|eeo/i.test(label);
  if (isProtectedCompliance) {
    trace({
      stage: 'tier6',
      clientId,
      tenant,
      query: normalizeLabel(label),
      hit: false,
      rejectionReason: 'llm_blocked_for_compliance',
    });
    console.log(`    🛑 [LLM Tier 6 blocked] Work-auth, sponsorship, and EEO questions cannot be answered by LLM: "${label.slice(0, 50)}"`);
    profile?._onLog?.(currentStep, `[Compliance Blocked] "${label.slice(0, 50)}" — protected question, manual answer needed`);
    return null;
  }

  console.log(`    🤖 [LLM Tier 6] Playwright DOM → "${label.slice(0, 50)}" (${fieldType || 'input'}, ${options.length} option(s))`);
  const llmAnswer = await resolveUnknownWithLlm(label, {
    ...enriched,
    fieldType,
    type: fieldType,
    field_type_code: code,
    required,
    options,
  }, {
    page: opts.page || null,
    profile,
    tenant: opts.tenant || profile._tenant || '',
    company: opts.company || profile._company || '',
    step: opts.step || '',
    resumePath: opts.resumePath || profile._resumePath,
    fieldTypeCode: code,
    preferred: isProceedQuestion(label) ? 'Yes' : '',
  });

  // Check if LLM answer contradicts a stored profile fact (for free-text inputs)
  if (llmAnswer) {
    const pFact = profileFactForLabel(label, profile);
    if (pFact && options.length === 0 && String(pFact).toLowerCase() !== String(llmAnswer).toLowerCase()) {
      trace({
        stage: 'tier6',
        clientId,
        tenant,
        query: normalizeLabel(label),
        hit: false,
        rejectionReason: 'llm_contradicts_profile_fact',
        llmAnswer,
        profileFact: pFact,
      });
      console.log(`    🛑 [LLM Tier 6 rejected] Contradicts stored profile fact (${pFact} vs ${llmAnswer})`);
      return null;
    }
  }

  const llmHit = finish(llmAnswer, 'llm_profile', 6);

  if (llmHit) {
    trace({
      stage: 'tier6',
      clientId,
      tenant,
      query: normalizeLabel(label),
      hit: true,
      llmChoice: llmHit.answer,
      allowedOptions: options,
      dryRun: opts.dryRun === true,
    });
    profile?._onLog?.(currentStep, `[Tier 6 AI LLM Prediction] "${label.slice(0, 50)}" ← "${llmHit.answer.slice(0, 45)}"`);

    const awlId = profile._applyWizzId || profile.applywizz_id || profile.client_id || process.env.APPLYWIZZ_ID || '';
    if (awlId && isSupabaseConfigured() && opts.dryRun !== true) {
      upsertSupabaseAnswer({
        applywizzId: awlId,
        question: label,
        questionNormalized: normalizeLabel(label),
        answer: llmHit.answer,
        fieldType,
        options,
        source: 'llm',
        unknownQuestion: true,
        jobUrl: opts.jobUrl || profile._jobUrl || '',
        company: opts.company || profile._company || '',
      }).catch((e) => console.log(`    ⚠️  Supabase write error: ${e.message?.slice(0, 80)}`));
      recordSupabaseAnswerInMemory(profile, label, llmHit.answer);
    }
    console.log(`    🤖 [LLM Tier 6${opts.dryRun ? ' (dry-run)' : ' → Supabase saved'}] "${label.slice(0, 55)}" ← "${llmHit.answer.slice(0, 40)}"`);
    return llmHit;
  }
  trace({ stage: 'tier6', clientId, tenant, query: normalizeLabel(label), hit: false, allowedOptions: options });

  if (isProceedQuestion(label)) {
    const yes = options.find((opt) => /^yes\b/i.test(opt)) || 'Yes';
    const proceed = finish(yes, 'proceed_continue');
    if (proceed) {
      console.log(`    ✅ [Proceed] "${label.slice(0, 55)}" ← "${proceed.answer}"`);
      return proceed;
    }
  }

  console.log(`    ⚠️  No answer found across Tier 1 (Supabase), Tier 2 (Resume), Tier 3 (CRM API), Tier 4 (Fuzzy Match), Tier 5 (QA Bank), Tier 6 (LLM AI) for "${label.slice(0, 55)}"`);
  return null;
}

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

export { normalizeLabel };
