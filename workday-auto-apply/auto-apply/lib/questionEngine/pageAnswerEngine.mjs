/**
 * pageAnswerEngine.mjs — Decide WHAT to answer for every normalized field on a page.
 * Playwright decides HOW to type/click. This module never touches the browser.
 */

import { hydrateProfileFromApplyWizz, resolveDomQuestionFromApplyWizz, isApplyWizzConfigured } from '../applyWizzClient.mjs';
import { peekClientAnswer } from '../clientAnswer.mjs';
import { resolveMinimumAgeAnswer } from '../minimumAge.mjs';
import { findBestMatch, normalizeLabel, isComplianceSensitive } from '../qaStore.mjs';
import {
  lookupSensitiveSafeAnswer,
  isYesNoQuestionLabel,
  isYesNoAnswer,
  extractYesNoAnswer,
  isWorkEligibilityQuestion,
} from '../workdayDefaults.mjs';
import { analyzeUnknownQuestionsBatch, isOpenRouterEnabled } from '../openRouterLlm.mjs';
import { normalizeDiscoveredField } from '../interaction/fieldSchema.mjs';
import { validateBeforeFill } from '../orchestrator/preFillValidator.mjs';
import { classifyQuestionIntent, isHighRiskIntent, intentsAreCompatible } from './intents.mjs';
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
    questionId: field.questionId,
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

  const safe = lookupSensitiveSafeAnswer(label);
  if (safe && !isWorkEligibilityQuestion(label) && intent !== 'years_experience' && intent !== 'technology_years_experience') {
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
  if (intent === 'clearance' || intent === 'professional_license') {
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
    const val = explicitEeo(profile, eeoKind);
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.97);
  }
  if (intent === 'salary' || intent === 'salary_hourly') {
    const val = explicitSalary(profile, intent === 'salary_hourly');
    if (!val) return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType: answerTypeFromField(field) });
    return finish(field, intent, val, SOURCE.APPLYWIZZ, REASON.EXPLICIT_PROFILE_MATCH, 0.96);
  }

  if (intent === 'technology_years_experience') {
    const mentioned = profileMentionsTopic(profile, label);
    const years = explicitYears(profile);
    if (mentioned && !years) {
      return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType: answerTypeFromField(field) });
    }
    if (!mentioned) {
      return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType: answerTypeFromField(field) });
    }
    return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType: answerTypeFromField(field) });
  }

  if (intent === 'years_experience') {
    const years = explicitYears(profile);
    if (!years) return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION, { answerType: answerTypeFromField(field) });
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
 * Resolve one normalized field without LLM.
 * @returns {object|null} answer record or null if still unknown
 */
export function resolveFieldWithoutLlm(field, profile = {}) {
  const label = field.label || '';
  const intent = classifyQuestionIntent(label, field);
  const answerType = answerTypeFromField(field);

  const special = deterministicSpecial(field, profile);
  if (special) return special;

  const fromApi = resolveDomQuestionFromApplyWizz(label, profile, {
    options: optionsOf(field),
    fieldType: field.fieldType || field.elementType || '',
    threshold: 0.62,
  });
  if (fromApi?.answer) {
    return finish(
      field,
      intent,
      fromApi.answer,
      SOURCE.APPLYWIZZ,
      /fuzzy|substring/.test(String(fromApi.source || '')) ? REASON.SEMANTIC_PROFILE_MATCH : REASON.EXPLICIT_PROFILE_MATCH,
      /fuzzy|substring/.test(String(fromApi.source || '')) ? 0.86 : 0.97,
    );
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

  if (isHighRiskIntent(intent) || isComplianceSensitive(label)) {
    return reviewRecord(field, intent, REASON.HIGH_RISK_MISSING_DATA, { answerType });
  }

  return null;
}

async function resolveVerifiedMemory(field, profile, qaStore) {
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
    await hydrateProfileFromApplyWizz(profile);
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
    const intent = classifyQuestionIntent(field.label, field);
    let record = resolveFieldWithoutLlm(field, profile);
    if (!record) {
      record = await resolveVerifiedMemory(field, profile, opts.qaStore);
    }
    if (record) {
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
      if (!llm || llm.requiresReview || !llm.answer) {
        const ambiguous = /ambiguous|unclear|meaning/i.test(String(llm?.reason || ''));
        answers.push(reviewRecord(item.field, item.intent, ambiguous ? REASON.AMBIGUOUS_QUESTION : REASON.UNKNOWN_INFORMATION, {
          answerType: answerTypeFromField(item.field),
          confidence: llm?.confidence || 0,
          source: SOURCE.LLM,
        }));
        continue;
      }
      answers.push(finish(
        item.field,
        item.intent,
        llm.answer,
        SOURCE.LLM,
        REASON.SEMANTIC_PROFILE_MATCH,
        llm.confidence,
      ));
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
    await hydrateProfileFromApplyWizz(profile);
  } else if (!profile._applyWizzWarned) {
    profile._applyWizzWarned = true;
    console.log(`  ⚠️  ${applyWizzStatus(profile).missing}`);
  }

  const normalized = normalizeDiscoveredField(
    { ...rawField, label },
    { pageNumber: opts.pageNumber || 1, stepName: opts.stepName || profile._currentStep || '' },
  );
  const intent = classifyQuestionIntent(normalized.label, normalized);
  const qaStore = opts.qaStore;

  let record = resolveFieldWithoutLlm(normalized, profile);
  if (!record) {
    record = await resolveVerifiedMemory(normalized, profile, qaStore);
  }

  if (!record && opts.allowLlm !== false && isOpenRouterEnabled()) {
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
    });
    const llm = batch[0];
    if (llm?.answer && !llm.requiresReview) {
      record = finish(
        normalized,
        intent,
        llm.answer,
        SOURCE.LLM,
        REASON.SEMANTIC_PROFILE_MATCH,
        llm.confidence ?? 0.82,
      );
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
