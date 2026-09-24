/**
 * pageAnswerEngine.mjs — Decide WHAT to answer for every normalized field on a page.
 * Playwright decides HOW to type/click. This module never touches the browser.
 */

import { hydrateProfileFromApplyWizz, resolveDomQuestionFromApplyWizz, isApplyWizzConfigured } from '../applyWizzClient.mjs';
import { peekClientAnswer, acceptClientValue, resolveClientAnswer } from '../clientAnswer.mjs';
import { lookupSupabaseAnswerSync, upsertSupabaseAnswer, recordSupabaseAnswerInMemory } from '../supabaseClient.mjs';
import { resolveMinimumAgeAnswer } from '../minimumAge.mjs';
import { isMandatoryField } from '../scanFieldFilter.mjs';
import { findBestMatch, normalizeLabel, isComplianceSensitive } from '../qaStore.mjs';
import { toTitleCase } from '../personName.mjs';
import { isApiOnlyAnswerMode } from '../apiOnlyProfile.mjs';
import {
  lookupSensitiveSafeAnswer,
  isYesNoQuestionLabel,
  isYesNoAnswer,
  extractYesNoAnswer,
  isWorkEligibilityQuestion,
  matchDegreeToOptions,
} from '../workdayDefaults.mjs';
import { analyzeUnknownQuestionsBatch, isOpenRouterEnabled, openRouterChat } from '../openRouterLlm.mjs';
import { resolveExperienceQuestionAnswer } from '../experienceAnswer.mjs';
import { normalizeDiscoveredField } from '../interaction/fieldSchema.mjs';
import {
  classifyQuestionIntent,
  isHighRiskIntent,
  intentsAreCompatible,
  isSignatureOrFullNameQuestion,
  isShiftOrScheduleQuestion,
  pickShiftOption,
  isSpecificManagerOrLocationQuestion,
  isTodaysDateField,
} from './intents.mjs';
import { mapToExactOption, answerTypeFromField } from './optionMap.mjs';
import { buildAnswerRecord, reviewRecord, REASON, SOURCE } from './answerRecord.mjs';
import {
  applyWizzStatus,
  explicitEeo,
  explicitSalary,
  explicitSponsorship,
  explicitWorkAuth,
  explicitYears,
  profileMentionsTopic,
} from './profileFacts.mjs';
import { buildLlmDateContext } from '../date-utils.mjs';
import { validateBeforeFill } from '../orchestrator/preFillValidator.mjs';
import { pickCompensationFromOptions, isCurrencyRequiredQuestion, formatSalaryWithCurrency } from '../compensationPick.mjs';

function isAvailabilityDropdown(field, intent) {
  const type = String(field?.fieldType || field?.elementType || '').toLowerCase();
  return intent === 'availability'
    && optionsOf(field).length > 0
    && /dropdown|select|radio|combobox/.test(type);
}

function optionsOf(field) {
  return (field.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function finish(field, intent, answer, source, reasonCode, confidence) {
  const answerType = answerTypeFromField(field);
  if ((isYesNoQuestionLabel(field.label) || intent === 'yes_no') && !isYesNoAnswer(answer)) {
    const yn = extractYesNoAnswer(answer);
    if (!yn) {
      const safe = lookupSensitiveSafeAnswer(field.label);
      if (safe) answer = safe;
      else return reviewRecord(field, intent, REASON.NO_VALID_OPTION, { answerType });
    } else {
      answer = yn;
    }
  }
  const mapped = mapToExactOption(answer, optionsOf(field), field.elementType || answerType);
  if (!mapped.ok) {
    return reviewRecord(field, intent, mapped.reasonCode || REASON.NO_VALID_OPTION, { answerType });
  }
  return buildAnswerRecord({
    questionId: field.questionId || field.id || '',
    intent,
    normalizedQuestion: field.label,
    answer: mapped.answer,
    answerType,
    confidence,
    source,
    reasonCode,
    requiresReview: confidence < 0.70,
  });
}

function inferSource(label, profile, value) {
  const n = normalizeLabel(label);
  if (profile?._applyWizzQa?.[n] && String(profile._applyWizzQa[n]) === String(value)) {
    return SOURCE.APPLYWIZZ;
  }
  if (profile?._applyWizzQa && Object.values(profile._applyWizzQa).some((v) => String(v) === String(value))) {
    return SOURCE.APPLYWIZZ;
  }
  if (profile?.qa_answers?.[n]) return SOURCE.MEMORY;
  return SOURCE.USER;
}

function deterministicSpecial(field, profile) {
  const label = field.label || '';
  const intent = classifyQuestionIntent(label, field);

  if (isSignatureOrFullNameQuestion(label) || intent === 'identity_name') {
    const p = profile.personal || {};
    const fullName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || profile.name || '';
    if (fullName) {
      return finish(field, 'identity_name', toTitleCase(fullName), SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.99);
    }
    // Fallback: use ApplyWizz profile name keys
    const nameFromApi = profile._applyWizzRaw?.full_name
      || profile._applyWizzRaw?.name
      || profile._applyWizzRaw?.first_name && `${profile._applyWizzRaw.first_name} ${profile._applyWizzRaw.last_name || ''}`.trim()
      || '';
    if (nameFromApi) {
      return finish(field, 'identity_name', toTitleCase(nameFromApi), SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.98);
    }
  }

  // Today's date for signature-companion date fields
  if (isTodaysDateField(label) || intent === 'date') {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yyyy = today.getFullYear();
    const todayStr = `${mm}/${dd}/${yyyy}`;
    return finish(field, 'date', todayStr, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.99);
  }

  if (isShiftOrScheduleQuestion(label) || intent === 'work_schedule') {
    const opts = optionsOf(field);
    if (opts.length) {
      const picked = pickShiftOption(opts);
      if (picked) {
        return finish(field, 'work_schedule', picked, SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.95);
      }
    } else {
      return finish(field, 'work_schedule', 'Flexible', SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.90);
    }
  }

  if (isSpecificManagerOrLocationQuestion(label) || intent === 'location_preference') {
    const opts = optionsOf(field);
    if (opts.length) {
      const picked = opts.find((o) => /\b(no\s*preference|any|all|none|n\/?a)\b/i.test(o)) || opts[0];
      return finish(field, 'location_preference', picked, SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.92);
    }
    return finish(field, 'location_preference', 'N/A', SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.95);
  }

  // lookupSensitiveSafeAnswer covers adverse-history (criminal, felony, misconduct etc.) → 'No'.
  // Do NOT exclude criminal_history here — the deterministic 'No' is the correct safe answer.
  const safe = lookupSensitiveSafeAnswer(label);
  if (safe && !isWorkEligibilityQuestion(label) && intent !== 'years_experience' && intent !== 'technology_years_experience' && intent !== 'identity_name' && intent !== 'date') {
    return finish(field, intent, safe, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.94);
  }

  if (intent === 'minimum_age') {
    const yes = resolveMinimumAgeAnswer(label, profile);
    if (yes) return finish(field, intent, yes, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.99);
  }

  if (intent === 'proceed_confirmation') {
    const yes = optionsOf(field).find((o) => /^yes\b/i.test(o)) || 'Yes';
    return finish(field, intent, yes, SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.90);
  }

  if (intent === 'work_authorization') {
    const val = explicitWorkAuth(profile);
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.98);
  }
  if (intent === 'sponsorship') {
    const val = explicitSponsorship(profile);
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.98);
  }
  if (intent === 'clearance') {
    return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
  }
  if (intent === 'professional_license' || intent === 'criminal_history') {
    // Check profile first
    const fromProfile = profile?.personal?.[intent] || profile?.work_auth?.[intent];
    if (fromProfile) {
      return finish(field, intent, fromProfile, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.95);
    }
    // Criminal/conviction questions: deterministic 'No' if the label matches adverse history
    if (intent === 'criminal_history') {
      const safeCriminal = lookupSensitiveSafeAnswer(label);
      if (safeCriminal) {
        return finish(field, intent, safeCriminal, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.95);
      }
      // Fallback: dropdown option matching — pick the 'No' option
      const opts = optionsOf(field);
      const noOpt = opts.find((o) => /^no\b/i.test(o.trim()));
      if (noOpt) {
        return finish(field, intent, noOpt, SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.93);
      }
      // Last resort: answer 'No' unconditionally — criminal history defaults to No
      return finish(field, intent, 'No', SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.90);
    }
    // professional_license: needs review
    return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
  }
  const eeoKind = {
    eeo_gender: 'gender',
    eeo_hispanic: 'hispanic',
    eeo_race: 'race',
    eeo_veteran: 'veteran',
    eeo_disability: 'disability',
  }[intent];
  if (eeoKind) {
    let val = explicitEeo(profile, eeoKind);
    if (!val && eeoKind === 'veteran') {
      val = profile?.eeo?.veteran_status || 'I am not a veteran';
    }
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.97);
  }
  if (intent === 'availability_limitations') {
    const isText = /textarea|text|free-text/i.test(String(field.elementType || field.controlType || field.fieldType || ''));
    const val = isText ? 'No limitations' : 'No';
    return finish(field, intent, val, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.96);
  }

  if (intent === 'commute_ability') {
    const opts = optionsOf(field);
    const yes = opts.find((o) => /^yes\b/i.test(o)) || 'Yes';
    return finish(field, intent, yes, SOURCE.DETERMINISTIC, REASON.OPTION_MATCH, 0.96);
  }

  if (intent === 'education_degree') {
    const deg = profile?.education?.highest_level
      || profile?.education?.degree
      || profile?._applyWizzRaw?.highest_education
      || profile?._applyWizzRaw?.education
      || '';
    if (deg) {
      const opts = optionsOf(field);
      if (opts.length) {
        const matchedOpt = matchDegreeToOptions(deg, opts);
        if (matchedOpt) {
          return finish(field, intent, matchedOpt, SOURCE.APPLYWIZZ, REASON.OPTION_MATCH, 0.98);
        }
      }
      return finish(field, intent, deg, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.98);
    }
  }
  if (intent === 'salary' || intent === 'salary_hourly') {
    const opts = optionsOf(field);
    if (opts.length > 0) {
      const picked = pickCompensationFromOptions(opts, profile);
      if (picked) {
        return finish(field, intent, picked, SOURCE.APPLYWIZZ, REASON.OPTION_MATCH, 0.96);
      }
    }
    let val = explicitSalary(profile, intent === 'salary_hourly');
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    if (isCurrencyRequiredQuestion(label)) {
      val = formatSalaryWithCurrency(val, profile, label);
    }
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.96);
  }

  if (intent === 'technology_years_experience') {
    const years = explicitYears(profile);
    const fromExp = resolveExperienceQuestionAnswer(label, profile, { options: optionsOf(field) });
    if (years && fromExp?.answer && fromExp.matched) {
      return finish(field, intent, fromExp.answer, SOURCE.RESUME || 'resume', REASON.EXPLICIT_PROFILE_MATCH, 0.92);
    }
    if (years) {
      return finish(field, intent, years, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.90);
    }
    return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
  }

  if (intent === 'years_experience') {
    const years = explicitYears(profile);
    if (!years) {
      const fromExp = resolveExperienceQuestionAnswer(label, profile, { options: optionsOf(field) });
      if (fromExp?.answer) {
        return finish(field, intent, fromExp.answer, SOURCE.RESUME || 'resume', REASON.EXPLICIT_PROFILE_MATCH, 0.92);
      }
      return null;
    }
    return finish(field, intent, years, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.96);
  }

  if (intent === 'technology_experience') {
    if (profileMentionsTopic(profile, label)) {
      return finish(field, intent, 'Yes', SOURCE.APPLYWIZZ, REASON.SEMANTIC_PROFILE_MATCH, 0.88);
    }
    return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType: answerTypeFromField(field) });
  }

  return null;
}

/**
 * Phase 2 fallback: Apply Wizz + Playwright live options + per-field LLM.
 * @returns {object|null} answer record
 */
export async function llmAnswerWithPlaywrightContext(field, profile = {}, opts = {}) {
  const label = field?.label || '';
  if (!label) return null;
  const intent = classifyQuestionIntent(label, field);

  const hit = await resolveClientAnswer(field, profile, {
    page: opts.page || null,
    forceLlm: true,
    required: field.required !== false,
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
    resumePath: opts.resumePath || profile._resumePath,
    step: opts.stepName || profile._currentStep || '',
    tenant: opts.tenant || profile._tenant || '',
  });
  if (!hit?.answer) return null;
  return finish(field, intent, hit.answer, SOURCE.LLM, REASON.SEMANTIC_PROFILE_MATCH, 0.78);
}

/**
 * Resolve one normalized field without LLM.
 * @returns {object|null} answer record or null if still unknown
 */
export function resolveFieldWithoutLlm(field, profile = {}) {
  const label = field.label || '';
  const intent = classifyQuestionIntent(label, field);
  const answerType = answerTypeFromField(field);

  const special = deterministicSpecial(field, profile);
  if (special) return special;

  // Apply Wizz stores a calendar date, while this control expects a relative
  // option such as Immediately or 1 week. Let the LLM map date to live options.
  // ─── Tier 1: Supabase Direct Answer ──────────────────────────────
  const fromSupabase = lookupSupabaseAnswerSync(label, profile, {
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
  });
  if (fromSupabase?.answer) {
    const supabaseAccepted = acceptClientValue(label, fromSupabase.answer, {
      options: optionsOf(field),
      fieldType: field.fieldType || field.elementType || '',
      profile,
    });
    if (supabaseAccepted) {
      return finish(
        field,
        intent,
        supabaseAccepted,
        'supabase',
        REASON.EXPLICIT_PROFILE_MATCH,
        0.98,
      );
    }
  }

  // Apply Wizz stores a calendar date, while this control expects a relative
  // option such as Immediately or 1 week. Let the LLM map date to live options.
  if (isAvailabilityDropdown(field, intent)) return null;

  // ─── Tier 2: ApplyWizz API Profile Facts ─────────────────────────
  const fromApi = resolveDomQuestionFromApplyWizz(label, profile, {
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
    threshold: 0.62,
  });
  if (fromApi?.answer) {
    const apiAccepted = acceptClientValue(label, fromApi.answer, {
      options: optionsOf(field),
      fieldType: field.fieldType || field.elementType || '',
      profile,
    });
    if (apiAccepted) {
      return finish(
        field,
        intent,
        apiAccepted,
        SOURCE.APPLYWIZZ,
        /fuzzy|substring/.test(String(fromApi.source || '')) ? REASON.SEMANTIC_PROFILE_MATCH : REASON.EXPLICIT_PROFILE_MATCH,
        /fuzzy|substring/.test(String(fromApi.source || '')) ? 0.86 : 0.97,
      );
    }
  }

  const peeked = peekClientAnswer(label, profile, {
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
  });
  if (peeked) {
    if (isHighRiskIntent(intent) && !explicitWorkAuth(profile) && intent === 'work_authorization') {
      return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType });
    }
    return finish(field, intent, peeked, inferSource(label, profile, peeked), REASON.EXPLICIT_PROFILE_MATCH, 0.93);
  }

  // ─── Tier 3: Resume Parsing Facts ─────────────────────────────────
  const fromExperience = resolveExperienceQuestionAnswer(label, profile, {
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
  });
  if (fromExperience?.answer) {
    const expAccepted = acceptClientValue(label, fromExperience.answer, {
      options: optionsOf(field),
      fieldType: field.fieldType || field.elementType || '',
      profile,
    });
    if (expAccepted) {
      return finish(
        field,
        intent,
        expAccepted,
        `experience/${fromExperience.source || 'resume'}`,
        REASON.EXPLICIT_PROFILE_MATCH,
        0.92,
      );
    }
  }

  if (isHighRiskIntent(intent) || isComplianceSensitive(label)) {
    return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType });
  }

  return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType });
}

async function resolveVerifiedMemory(field, profile, qaStore) {
  if (isApiOnlyAnswerMode()) return null;
  const label = field.label || '';
  const intent = classifyQuestionIntent(label, field);
  const match = await findBestMatch(label, profile, qaStore, 0.92).catch(() => null);
  if (!match?.answer) return null;
  const storedIntent = classifyQuestionIntent(match.matchedKey || label, field);
  if (!intentsAreCompatible(intent, storedIntent)) return null;
  if (match.source === 'minimum_age') {
    return finish(field, intent, match.answer, SOURCE.DETERMINISTIC, REASON.EXPLICIT_PROFILE_MATCH, 0.99);
  }
  return finish(field, intent, match.answer, SOURCE.MEMORY, REASON.VERIFIED_PREVIOUS_ANSWER, 0.95);
}

/**
 * Analyze every normalized field on the current page.
 * @param {object[]} fields  Prompt 1 normalized fields
 * @param {object} profile
 * @param {{ pageNumber?: number, stepName?: string, qaStore?: object, resumePath?: string }} [opts]
 */
export async function answerPageQuestions(fields = [], profile = {}, opts = {}) {
  if (isApplyWizzConfigured()) {
    if (!profile._applyWizzHydrated) await hydrateProfileFromApplyWizz(profile);
  } else if (!profile._applyWizzWarned) {
    profile._applyWizzWarned = true;
    console.log(`  ⚠️  ${applyWizzStatus(profile).missing}`);
  }

  const pageNumber = opts.pageNumber || 1;
  const answers = [];
  const unknown = [];

  for (const field of fields) {
    if (!field?.label || field.elementType === 'button' || field.elementType === 'file') {
      continue;
    }
    const isMandatory = field.required === true || isMandatoryField(field.label, field, opts.stepName);
    if (profile?._fillOptionalFields !== true && !isMandatory) {
      continue;
    }
    const intent = classifyQuestionIntent(field.label, field);
    const availabilityDropdown = isAvailabilityDropdown(field, intent);
    let record = resolveFieldWithoutLlm(field, profile);
    const hasResolvedAnswer = Boolean(record && record.answer != null && String(record.answer).trim() !== '' && !record.requiresReview);
    if (!hasResolvedAnswer) {
      const mem = availabilityDropdown ? null : await resolveVerifiedMemory(field, profile, opts.qaStore);
      if (mem && !mem.requiresReview && mem.answer != null && String(mem.answer).trim() !== '') {
        record = mem;
      }
    }
    if (record && !record.requiresReview && record.answer != null && String(record.answer).trim() !== '') {
      answers.push(record);
      continue;
    }
    if (record && record.requiresReview && (isHighRiskIntent(intent) || isComplianceSensitive(field.label))) {
      answers.push(record);
      continue;
    }
    unknown.push({
      questionId: field.questionId,
      label: field.label,
      intent,
      options: optionsOf(field),
      elementType: field.elementType,
      required: field.required === true,
      field,
    });
  }

  if (unknown.length) {
    console.log(`  🧠 Question engine: ${unknown.length} unknown field(s) on page ${pageNumber} → ${isOpenRouterEnabled() ? 'one LLM batch' : 'review (LLM off)'}`);
    const batch = await analyzeUnknownQuestionsBatch(unknown, profile, {
      resumePath: opts.resumePath || profile._resumePath,
    });
    const byId = new Map(batch.map((row) => [row.questionId, row]));
    for (const item of unknown) {
      const llm = byId.get(item.questionId);
      if (llm?.answer && !llm.requiresReview) {
        answers.push(finish(
          item.field,
          item.intent,
          llm.answer,
          SOURCE.LLM,
          REASON.SEMANTIC_PROFILE_MATCH,
          Math.max(Number(llm.confidence) || 0, 0.75),
        ));
        continue;
      }
      const playwrightLlm = await llmAnswerWithPlaywrightContext(item.field, profile, {
        page: opts.page,
        resumePath: opts.resumePath,
        stepName: opts.stepName,
      });
      if (playwrightLlm?.answer && !playwrightLlm.requiresReview) {
        console.log(`    🤖 [LLM+DOM] "${item.label.slice(0, 55)}" ← "${String(playwrightLlm.answer).slice(0, 40)}"`);
        answers.push(playwrightLlm);
        continue;
      }
      if (llm?.answer) {
        answers.push(finish(
          item.field,
          item.intent,
          llm.answer,
          SOURCE.LLM,
          REASON.SEMANTIC_PROFILE_MATCH,
          Math.max(Number(llm.confidence) || 0, 0.70),
        ));
        continue;
      }
      const ambiguous = /ambiguous|unclear|meaning/i.test(String(llm?.reason || ''));
      answers.push(reviewRecord(item.field, item.intent, ambiguous ? REASON.AMBIGUOUS_QUESTION : REASON.UNKNOWN_INFORMATION, {
        answerType: answerTypeFromField(item.field),
        confidence: llm?.confidence || 0,
        source: SOURCE.LLM,
      }));
    }
  }

  const pack = {
    pageNumber,
    stepName: opts.stepName || '',
    applyWizz: applyWizzStatus(profile),
    answers,
  };
  const reviewCount = answers.filter((a) => a.requiresReview).length;
  console.log(`  📋 Question engine: ${answers.length} decision(s), ${reviewCount} require review (no invented facts)`);
  return pack;
}

/**
 * Intent → evidence retrieval → answer validation for one live Workday question.
 * Used by Application Questions sweeps and any path that is not the full page orchestrator.
 *
 * @param {object} rawField — DOM-discovered field (label, fieldType, options, …)
 * @param {object} profile
 * @param {{ stepName?: string, pageNumber?: number, qaStore?: object, resumePath?: string, allowLlm?: boolean }} [opts]
 * @returns {Promise<{ answer: string, record: object, intent: string, source: string, confidence: number }|null>}
 */
export async function resolveDynamicAnswer(rawField = {}, profile = {}, opts = {}) {
  const label = String(rawField.label || rawField.questionLabel || '').replace(/\s+/g, ' ').trim();
  if (!label) return null;

  if (isApplyWizzConfigured()) {
    if (!profile._applyWizzHydrated) await hydrateProfileFromApplyWizz(profile);
  } else if (!profile._applyWizzWarned) {
    profile._applyWizzWarned = true;
    console.log(`  ⚠️  ${applyWizzStatus(profile).missing}`);
  }

  const normalized = normalizeDiscoveredField(
    { ...rawField, label },
    { pageNumber: opts.pageNumber || 1, stepName: opts.stepName || profile._currentStep || '' },
  );
  const intent = classifyQuestionIntent(normalized.label, normalized);
  const availabilityDropdown = isAvailabilityDropdown(normalized, intent);
  const qaStore = opts.qaStore;

  let record = resolveFieldWithoutLlm(normalized, profile);
  const hasResolvedAnswer = Boolean(record && record.answer != null && String(record.answer).trim() !== '');
  if (!hasResolvedAnswer) {
    record = availabilityDropdown ? null : await resolveVerifiedMemory(normalized, profile, qaStore);
  }

  const hasMemoryAnswer = Boolean(record && record.answer != null && String(record.answer).trim() !== '');
  if (!hasMemoryAnswer && opts.allowLlm !== false && isOpenRouterEnabled()) {
    const unknown = {
      questionId: normalized.questionId,
      label: normalized.label,
      intent,
      options: optionsOf(normalized),
      elementType: normalized.elementType,
      required: normalized.required === true,
      field: normalized,
    };
    const batch = await analyzeUnknownQuestionsBatch([unknown], profile, {
      resumePath: opts.resumePath || profile._resumePath,
      page: opts.page || null,
    });
    const llm = batch[0];
    if (llm?.answer && !llm.requiresReview) {
      record = finish(
        normalized,
        intent,
        llm.answer,
        SOURCE.LLM,
        REASON.SEMANTIC_PROFILE_MATCH,
        Math.max(Number(llm.confidence) || 0, 0.75),
      );
    }
  }

  const hasLlmBatchAnswer = Boolean(record && record.answer != null && String(record.answer).trim() !== '');
  if (!hasLlmBatchAnswer && opts.allowLlm !== false) {
    record = await llmAnswerWithPlaywrightContext(normalized, profile, {
      page: opts.page,
      resumePath: opts.resumePath || profile._resumePath,
      stepName: opts.stepName,
    });
  }

  // ─── Layer 4: Live Best-Fit Fallback for Required Degree Dropdown ───────
  if (
    !record
    && intent === 'education_degree'
    && normalized.required === true
  ) {
    const liveOptions = optionsOf(normalized);
    if (!liveOptions.length) {
      return reviewRecord(normalized, intent, REASON.NO_VALID_OPTION, {
        answerType: answerTypeFromField(normalized),
        confidence: 0,
        source: SOURCE.LLM,
      });
    }

    if (opts.allowLlm !== false && isOpenRouterEnabled()) {
      const classification = profile._degreeClassification || {};
      const canonicalDegree = classification.canonical_degree || profile.education?.degree || profile.education?.level || '';
      const major = profile.education?.field_of_study || profile.education?.major || '';
      const sourceRaw = classification.source_raw || '';
      const educationSummary = [
        canonicalDegree ? `Degree: ${canonicalDegree}` : '',
        major ? `Major/Field of Study: ${major}` : '',
        sourceRaw ? `Raw Education: ${sourceRaw}` : '',
      ].filter(Boolean).join(', ') || 'Not specified';

      const prompt = `Given this candidate's full education record (${educationSummary}) and this exact list of real dropdown options:
${liveOptions.map((opt, i) => `${i + 1}. "${opt}"`).join('\n')}

Instruction:
Pick the single closest matching option. You must return one of the given options verbatim, or 'NONE' if nothing is even loosely related. Do not fabricate or alter any option. Respond with ONLY the exact option string or NONE.`;

      try {
        const completion = await openRouterChat({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.0,
          max_tokens: 150,
        });
        let rawAnswer = completion?.choices?.[0]?.message?.content?.trim() || '';
        rawAnswer = rawAnswer.replace(/^["'`]+|["'`]+$/g, '').trim();

        const exactOption = liveOptions.find((opt) => opt.toLowerCase() === rawAnswer.toLowerCase());
        if (exactOption && exactOption !== 'NONE') {
          console.log(`    🎓 [Layer 4 Best-Fit] "${normalized.label.slice(0, 45)}" ← "${exactOption}"`);
          record = finish(
            normalized,
            intent,
            exactOption,
            SOURCE.LLM,
            REASON.SEMANTIC_PROFILE_MATCH,
            0.88,
          );
          if (profile._applyWizzId) {
            recordSupabaseAnswerInMemory(profile, normalized.label, exactOption);
            await upsertSupabaseAnswer({
              applywizzId: profile._applyWizzId,
              question: normalized.label,
              questionNormalized: normalizeLabel(normalized.label),
              answer: exactOption,
              fieldType: normalized.fieldType || normalized.elementType || 'dropdown',
              options: liveOptions,
              source: 'ai',
              company: opts.tenant || profile._tenant || '',
            }).catch((err) => {
              console.log(`  ⚠️ Failed to cache Layer 4 degree answer to Supabase: ${err.message?.slice(0, 100)}`);
            });
          }
        } else {
          return reviewRecord(normalized, intent, REASON.NO_VALID_OPTION, {
            answerType: answerTypeFromField(normalized),
            confidence: 0,
            source: SOURCE.LLM,
          });
        }
      } catch (err) {
        console.log(`  ⚠️ Layer 4 degree matching failed: ${err.message?.slice(0, 100)}`);
        return reviewRecord(normalized, intent, REASON.NO_VALID_OPTION, {
          answerType: answerTypeFromField(normalized),
          confidence: 0,
          source: SOURCE.LLM,
        });
      }
    } else {
      return reviewRecord(normalized, intent, REASON.NO_VALID_OPTION, {
        answerType: answerTypeFromField(normalized),
        confidence: 0,
        source: SOURCE.UNKNOWN,
      });
    }
  }

  if (!record) return null;

  const gate = validateBeforeFill(normalized, record, profile);
  if (!gate.ok) {
    return null;
  }

  return {
    answer: gate.answer,
    record,
    intent: record.intent || intent,
    source: record.source,
    confidence: record.confidence,
  };
}

export function decisionForField(pack, field) {
  if (!pack?.answers?.length || !field) return null;
  const id = field.questionId;
  if (id) {
    const byId = pack.answers.find((a) => a.questionId === id);
    if (byId) return byId;
  }
  const n = normalizeLabel(field.label || field.questionLabel || '');
  return pack.answers.find((a) => normalizeLabel(a.normalizedQuestion) === n) || null;
}
