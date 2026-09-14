/**
 * clientAnswer.mjs — Single answer path for every Workday question.
 *
 *   0. 16+/18+ working-age questions → Yes (DOB years if present; jobs are 18+)
 *   1. Apply Wizz client API (hydrated profile + Q&A index)
 *   2. Facts already on that profile (identity, work auth, EEO, dates, salary)
 *   3. Resume text belonging to the same client
 *   4. LLM analyses the same profile and picks the closest live option
 *
 * Other questions are never invented. Cached YAML/LLM "No" cannot win on age.
 */

import { hydrateProfileFromApplyWizz, resolveDomQuestionFromApplyWizz } from './applyWizzClient.mjs';
import { resolveUnknownWithLlm, isOpenRouterEnabled } from './openRouterLlm.mjs';
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

  if (/^(legal\s*)?(first|given)\s*name/.test(n) || n === 'first name') return p.first_name || null;
  if (/^(legal\s*)?(last|family|surname)\s*name/.test(n) || n === 'last name') return p.last_name || null;
  if (/^full\s*name$|^name$/.test(n)) return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
  if (/^email/.test(n)) return p.email || null;
  if (/^(phone|mobile|cell)(\s*number)?$|phone\s*number/.test(n)) return p.phone || null;
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
  if (/veteran/.test(n)) return eeo.veteran_status || null;
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

  if (/hourly|wage/.test(n) && profile.compensation_hourly) {
    return String(profile.compensation_hourly);
  }
  if (profile.compensation != null && /(salary|compensation|pay|minimum salary)/.test(n) && !/hourly|wage/.test(n)) {
    return String(profile.compensation);
  }
  if (profile._desiredStartDate && /available.*start|when.*start|desired.*start/.test(n)) {
    return profile._desiredStartDate;
  }
  return null;
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
  return sanitizeExperienceAnswer(label, text, profile, { options, fieldType }) || text;
}

/**
 * Sync peek: age Yes first, then Apply Wizz + profile facts. Never calls the LLM.
 */
export function peekClientAnswer(label, profile = {}, opts = {}) {
  const question = String(label || '').replace(/\s+/g, ' ').trim();
  if (!question || !profile) return null;
  const options = opts.options || [];
  const fieldType = opts.fieldType || '';

  const ageYes = resolveMinimumAgeAnswer(question, profile);
  if (ageYes) return acceptClientValue(question, ageYes, { options, fieldType, profile }) || ageYes;

  const sensitive = lookupSensitiveSafeAnswer(question);
  if (sensitive) return acceptClientValue(question, sensitive, { options, fieldType, profile }) || sensitive;

  const fromApi = resolveDomQuestionFromApplyWizz(question, profile, {
    options,
    fieldType,
    threshold: 0.48,
  });
  const apiOk = acceptClientValue(question, fromApi?.answer, { options, fieldType, profile });
  if (apiOk) return apiOk;

  const fromProfile = profileFactForLabel(question, profile);
  const profileOk = acceptClientValue(question, fromProfile, { options, fieldType, profile });
  if (profileOk) return profileOk;

  const fromExperience = resolveExperienceQuestionAnswer(question, profile, { options, fieldType });
  return acceptClientValue(question, fromExperience?.answer, { options, fieldType, profile });
}

/**
 * Resolve one question: Apply Wizz → profile/resume facts → LLM closest match.
 * @returns {Promise<{ answer: string, source: string, field_type_code?: number }|null>}
 */
export async function resolveClientAnswer(field = {}, profile = {}, opts = {}) {
  const enriched = enrichFieldWithTypeCode(typeof field === 'object' ? field : { label: field });
  const label = fieldLabel(enriched, typeof field === 'string' ? field : '');
  if (!label) return null;

  if (profile && !profile._applyWizzHydrated) {
    await hydrateProfileFromApplyWizz(profile);
  }

  const options = fieldOptions(enriched).length ? fieldOptions(enriched) : (opts.options || []);
  const fieldType = enriched.fieldType || enriched.type || opts.fieldType || '';
  const code = enriched.field_type_code || fieldTypeToCode(fieldType);
  const required = enriched.required === true || opts.required === true || /\*/.test(label);

  const finish = (answer, source) => {
    const value = acceptClientValue(label, answer, { options, fieldType, profile });
    if (!value) return null;
    return { answer: value, source, field_type_code: code, field_type: fieldType };
  };

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

  const fromApi = resolveDomQuestionFromApplyWizz(label, profile, {
    options,
    fieldType,
    threshold: 0.48,
  });
  const apiIsFuzzy = /fuzzy|substring/.test(String(fromApi?.source || ''));
  const domainQuestion = isYearsQuantityQuestion(label)
    || isDescribeExperienceQuestion(label)
    || isProceedQuestion(label);
  if (fromApi?.answer && !(apiIsFuzzy && domainQuestion)) {
    const apiHit = finish(fromApi.answer, fromApi.source || 'applywizz');
    if (apiHit) {
      console.log(`    🌐 [ApplyWizz] "${label.slice(0, 55)}" ← "${apiHit.answer.slice(0, 40)}"`);
      return apiHit;
    }
  }

  const fromProfile = profileFactForLabel(label, profile);
  const profileHit = finish(fromProfile, 'client_profile');
  if (profileHit && !domainQuestion) {
    console.log(`    👤 [Profile] "${label.slice(0, 55)}" ← "${profileHit.answer.slice(0, 40)}"`);
    return profileHit;
  }

  const llmOn = isOpenRouterEnabled();
  if (!llmOn) {
    const fromExperience = resolveExperienceQuestionAnswer(label, profile, { options, fieldType });
    const expHit = finish(fromExperience?.answer, `experience/${fromExperience?.source || 'profile'}`);
    if (expHit) {
      console.log(`    📊 [Experience] "${label.slice(0, 55)}" ← "${expHit.answer.slice(0, 40)}"`);
      return expHit;
    }
  }

  if (!required && opts.forceLlm !== true && !domainQuestion) return null;

  console.log(`    🤖 [LLM] Playwright → label + type code ${code} + ${options.length} option(s) → "${label.slice(0, 50)}"`);
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
  if (llmHit) return llmHit;

  if (isProceedQuestion(label)) {
    const yes = options.find((opt) => /^yes\b/i.test(opt)) || 'Yes';
    const proceed = finish(yes, 'proceed_continue');
    if (proceed) {
      console.log(`    ✅ [Proceed] "${label.slice(0, 55)}" ← "${proceed.answer}"`);
      return proceed;
    }
  }

  console.log(`    ⚠️  No ApplyWizz/profile/LLM answer for "${label.slice(0, 55)}" — leaving empty`);
  return null;
}

export { normalizeLabel };
