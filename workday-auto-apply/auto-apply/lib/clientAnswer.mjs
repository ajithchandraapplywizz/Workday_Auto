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
import { formatPlainUsPhone, normalizePhoneForCountry, workdayPhoneCodeForCountry } from './clientContact.mjs';
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
  isAvailabilityCheckboxQuestion,
  resolveWorkScheduleCheckboxAnswer,
} from './questionEngine/intents.mjs';
import { isAvailabilityStartDateLabel, getTodayMMDDYYYY } from './date-utils.mjs';

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
  return isAvailabilityStartDateLabel(label)
    || /available\s*to\s*start|when\s*(are|can)\s*you\s*start|how\s*soon\s*can\s*you\s*start|desired\s*start|earliest\s*start/i.test(label);
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

  if (/^(legal\s*)?(first|given)\s*name/.test(n) || n === 'first name') return p.first_name || null;
  if (/^(legal\s*)?(last|family|surname)\s*name/.test(n) || n === 'last name') return p.last_name || null;
  if (isSignatureOrFullNameQuestion(label) || /^full\s*name$|^name$/.test(n)) return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || profile.name || null;
  if (/^email/.test(n)) return p.email || null;
  if (/^(phone|mobile|cell)(\s*number)?$|phone\s*number/.test(n)) {
    const hint = `${p.country || ''} ${p.country_phone_code || ''}`;
    return p.phone ? normalizePhoneForCountry(p.phone, hint) : null;
  }
  if (/country\s*(\/\s*territory\s*)?phone\s*code/i.test(n)) {
    return p.country_phone_code || workdayPhoneCodeForCountry(p.country) || null;
  }
  if (/^country$/i.test(n) && !/phone/i.test(n)) return p.country || null;
  if (/^district$|^county$/i.test(n)) return p.city || p.state || null;
  if (/^city$|^address--city$/.test(n)) return p.city || null;
  if (/address\s*line\s*1|^address--addressline1$/.test(n)) return p.address_line1 || null;
  if (/^state$|^address--countryregion$/.test(n)) return p.state || null;
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
  if (profile._desiredStartDate && /available.*start|when.*start|desired.*start/.test(n)) {
    return profile._desiredStartDate;
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
  const ft = String(fieldType || '').toLowerCase();
  if (/checkbox-group|multi-checkbox|multi.?check/.test(ft)) {
    const optTexts = (options || []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const yn = extractYesNoAnswer(text);
    if (yn && optTexts.length && !optTexts.some((o) => extractYesNoAnswer(o))) {
      if (isAvailabilityCheckboxQuestion(label)) {
        const mapped = resolveWorkScheduleCheckboxAnswer(label, text, optTexts);
        if (mapped) return mapped;
      }
      return null;
    }
  }
  if (isYesNoQuestionLabel(label) && !/checkbox-group|text|input|textarea/i.test(fieldType)) {
    const yn = extractYesNoAnswer(text);
    if (!yn) return null;
    if (options.length) {
      const hit = options.find((opt) => extractYesNoAnswer(opt) === yn);
      return hit || yn;
    }
    return yn;
  }
  return sanitizeExperienceAnswer(label, text, profile, { options, fieldType }) || text;
}

/**
 * Sync peek: age/safety first, then Tier 1 (Supabase clients table -> client_questions table) -> Tier 2 (Resume parsing).
 * Never calls the LLM.
 */
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

  // ─── TIER 1: Supabase Direct Answer (clients table -> client_questions table) ───
  // 1a. Check Supabase client_questions table with respective AWL ID
  const fromSupabase = lookupSupabaseAnswerSync(question, profile, { options, fieldType });
  const supabaseOk = acceptClientValue(question, fromSupabase?.answer, { options, fieldType, profile });
  if (supabaseOk) return supabaseOk;

  // 1b. Check Supabase clients table facts
  const fromProfile = profileFactForLabel(question, profile);
  const profileOk = acceptClientValue(question, fromProfile, { options, fieldType, profile });
  if (profileOk) return profileOk;

  const fromApi = resolveDomQuestionFromApplyWizz(question, profile, {
    options,
    fieldType,
    threshold: 0.48,
  });
  const apiOk = acceptClientValue(question, fromApi?.answer, { options, fieldType, profile });
  if (apiOk) return apiOk;

  // ─── TIER 2: Resume Parsing ──────────────────────────────────────────────────
  const fromExperience = resolveExperienceQuestionAnswer(question, profile, { options, fieldType });
  return acceptClientValue(question, fromExperience?.answer, { options, fieldType, profile });
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
    await hydrateProfileFromApplyWizz(profile);
  }

  const fieldType = enriched.fieldType || enriched.type || opts.fieldType || '';
  let options = fieldOptions(enriched).length ? fieldOptions(enriched) : (opts.options || []);
  if (!options.length && opts.page && /dropdown|select|combobox|radio|checkbox-group|multi-checkbox/i.test(fieldType)) {
    try {
      const { collectLiveFieldOptions } = await import('./workdayDom.mjs');
      options = await collectLiveFieldOptions(opts.page, label, fieldType) || [];
    } catch { /* live option discovery is optional */ }
  }
  const code = enriched.field_type_code || fieldTypeToCode(fieldType);
  const required = enriched.required === true || opts.required === true || /\*/.test(label) || enriched.hasRequiredMarker === true;
  const availabilityTiming = isAvailabilityTimingQuestion(label);

  const finish = (answer, source) => {
    const value = acceptClientValue(label, answer, { options, fieldType, profile });
    if (!value) return null;
    return { answer: value, source, field_type_code: code, field_type: fieldType };
  };

  // 0. Legal & safety guards
  const ageYes = resolveMinimumAgeAnswer(label, profile);
  if (ageYes) {
    const hit = { answer: ageYes, source: 'minimum_age', field_type_code: code, field_type: fieldType };
    console.log(`    🎂 [Age] "${label.slice(0, 55)}" ← "Yes"`);
    return hit;
  }

  const sensitive = lookupSensitiveSafeAnswer(label);
  if (sensitive) {
    const hit = finish(sensitive, 'sensitive_safe');
    if (hit) {
      console.log(`    🛡️  [Sensitive] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  if (isAvailabilityStartDateLabel(label, enriched)) {
    const today = getTodayMMDDYYYY('Asia/Kolkata');
    const hit = finish(today, 'availability_start_date');
    if (hit) {
      console.log(`    📅 [Availability date] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  if (isShiftOrScheduleQuestion(label) || isAvailabilityCheckboxQuestion(label)) {
    const mapped = resolveWorkScheduleCheckboxAnswer(label, 'Yes', options);
    if (mapped) {
      const hit = finish(mapped, 'work_schedule');
      if (hit) {
        console.log(`    📋 [Schedule] "${label.slice(0, 55)}" ← "${hit.answer.slice(0, 40)}"`);
        return hit;
      }
    }
    if (!options.length) {
      const flex = finish('Flexible', 'work_schedule');
      if (flex) return flex;
    }
  }

  // ─── TIER 1: Supabase Direct Answer (clients table -> client_questions table) ───
  // 1a. Core Identity from Supabase clients table (name, phone, email, address)
  const fromProfileIdentity = isPersonalIdentityQuestion(label) ? profileFactForLabel(label, profile) : null;
  if (fromProfileIdentity) {
    const hit = finish(fromProfileIdentity, 'supabase_client_fact');
    if (hit) {
      console.log(`    👤 [Identity] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  // 1b. Exact question-and-answer from Supabase client_questions table for this client (AWL ID)
  const fromSupabase = await lookupSupabaseAnswer(label, profile, { options, fieldType });
  if (fromSupabase?.answer) {
    const supabaseHit = finish(fromSupabase.answer, fromSupabase.source || 'supabase_client_questions');
    if (supabaseHit) {
      console.log(`    🗄️  [Supabase Tier 1 client_questions] "${label.slice(0, 55)}" ← "${supabaseHit.answer.slice(0, 40)}" (${fromSupabase.source})`);
      return supabaseHit;
    }
  }

  // 1c. Other attributes from Supabase clients table (education, degree, skills, dates)
  const fromProfile = profileFactForLabel(label, profile);
  const domainQuestion = isYearsQuantityQuestion(label)
    || isDescribeExperienceQuestion(label)
    || isProceedQuestion(label);
  if (fromProfile && !domainQuestion) {
    const hit = finish(fromProfile, 'supabase_clients_table');
    if (hit) {
      console.log(`    🗄️  [Supabase Tier 1 clients table] "${label.slice(0, 55)}" ← "${hit.answer.slice(0, 40)}"`);
      return hit;
    }
  }

  const priorEmployer = priorEmployerAnswer(label, profile);
  if (priorEmployer) {
    const hit = finish(priorEmployer, 'supabase_clients_table');
    if (hit) {
      console.log(`    🧾 [Supabase Tier 1 Prior Employer] "${label.slice(0, 55)}" ← "${hit.answer}"`);
      return hit;
    }
  }

  const fromApi = resolveDomQuestionFromApplyWizz(label, profile, {
    options,
    fieldType,
    threshold: 0.48,
  });
  const apiIsFuzzy = /fuzzy|substring/.test(String(fromApi?.source || ''));
  if (fromApi?.answer && !(apiIsFuzzy && domainQuestion)) {
    const apiHit = finish(fromApi.answer, fromApi.source || 'supabase_clients_table');
    if (apiHit) {
      console.log(`    🗄️  [Supabase Tier 1 API facts] "${label.slice(0, 55)}" ← "${apiHit.answer.slice(0, 40)}"`);
      return apiHit;
    }
  }

  // ─── TIER 2: Resume Parsing ──────────────────────────────────────────────────
  const fromExperience = resolveExperienceQuestionAnswer(label, profile, { options, fieldType });
  const expHit = finish(fromExperience?.answer, `experience/${fromExperience?.source || 'resume'}`);
  if (expHit) {
    console.log(`    📄 [Resume Tier 2] "${label.slice(0, 55)}" ← "${expHit.answer.slice(0, 40)}"`);
    return expHit;
  }

  // Only mandatory/required questions proceed to LLM unless forceLlm is set
  if (!required && opts.forceLlm !== true && !domainQuestion && !availabilityTiming) {
    return null;
  }

  // ─── TIER 3: LLM Analysis with Live Playwright DOM Context + Persist to Supabase ─
  console.log(`    🤖 [LLM Tier 3] Playwright DOM → "${label.slice(0, 50)}" (${fieldType || 'input'}, ${options.length} option(s))`);
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

  const llmHit = finish(llmAnswer, 'llm_profile');
  if (llmHit) {
    const awlId = profile._applyWizzId || profile.applywizz_id || profile.client_id || process.env.APPLYWIZZ_ID || '';
    if (awlId && isSupabaseConfigured()) {
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
    console.log(`    🤖 [LLM Tier 3 → Supabase saved] "${label.slice(0, 55)}" ← "${llmHit.answer.slice(0, 40)}"`);
    return llmHit;
  }

  if (isProceedQuestion(label)) {
    const yes = options.find((opt) => /^yes\b/i.test(opt)) || 'Yes';
    const proceed = finish(yes, 'proceed_continue');
    if (proceed) {
      console.log(`    ✅ [Proceed] "${label.slice(0, 55)}" ← "${proceed.answer}"`);
      return proceed;
    }
  }

  console.log(`    ⚠️  No answer found across Tier 1 (Supabase), Tier 2 (Resume), Tier 3 (LLM) for "${label.slice(0, 55)}"`);
  return null;
}


export { normalizeLabel };
