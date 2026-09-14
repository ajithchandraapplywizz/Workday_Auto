/**
 * Dry-run answer pack: profile + deterministic truthful fallbacks.
 * Never invents license numbers, visa facts, or years of a technology.
 */

import { resolveFieldWithoutLlm } from '../../lib/questionEngine/pageAnswerEngine.mjs';
import { classifyQuestionIntent } from '../../lib/questionEngine/intents.mjs';
import { mapToExactOption } from '../../lib/questionEngine/optionMap.mjs';
import { reviewRecord, buildAnswerRecord, REASON, SOURCE } from '../../lib/questionEngine/answerRecord.mjs';

export function decisionFromProfile(field, profile) {
  const label = field.label || '';
  const existing = resolveFieldWithoutLlm(field, profile);
  if (existing) {
    if (isYearOnlyDate(field, existing.answer)) {
      return reviewRecord(field, existing.intent || classifyQuestionIntent(label, field), REASON.UNKNOWN_INFORMATION);
    }
    return existing;
  }
  const intent = classifyQuestionIntent(label, field);
  const opts = field.options || [];

  if (/first name/i.test(label) && profile.personal?.first_name) {
    return pack(field, intent, profile.personal.first_name, SOURCE.APPLYWIZZ);
  }
  if (/last name|family name/i.test(label) && profile.personal?.last_name) {
    return pack(field, intent, profile.personal.last_name, SOURCE.APPLYWIZZ);
  }
  if (/university|school/i.test(label) && profile.education?.university) {
    return pack(field, intent, profile.education.university, SOURCE.APPLYWIZZ);
  }
  if (/degree/i.test(label) && profile.education?.degree) {
    const mapped = mapToExactOption(profile.education.degree, opts, field.elementType);
    if (mapped.ok) return pack(field, intent, mapped.answer, SOURCE.APPLYWIZZ);
    return reviewRecord(field, intent, REASON.NO_VALID_OPTION);
  }
  if (/skills \(select all/i.test(label) && Array.isArray(profile.skills)) {
    const picked = (opts.length ? opts : profile.skills).filter((o) =>
      profile.skills.some((s) => String(s).toLowerCase() === String(o).toLowerCase()),
    );
    if (picked.length) return pack(field, intent, picked.join(', '), SOURCE.APPLYWIZZ);
  }
  if (/driver'?s license\?/i.test(label) && !/number/i.test(label)) {
    const mapped = mapToExactOption('No', opts, field.elementType);
    if (mapped.ok) return pack(field, intent, mapped.answer, SOURCE.DETERMINISTIC, 0.8);
    return pack(field, intent, 'No', SOURCE.DETERMINISTIC, 0.8);
  }
  if (/driver'?s license number/i.test(label)) {
    return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION);
  }
  if (/certify that my answers are true/i.test(label)) {
    const mapped = mapToExactOption('Yes', opts, field.elementType);
    return pack(field, intent, mapped.ok ? mapped.answer : 'Yes', SOURCE.DETERMINISTIC, 0.9);
  }
  if (/i agree to the terms/i.test(label)) {
    return pack(field, intent, 'Yes', SOURCE.DETERMINISTIC, 0.85);
  }
  if (/preferred name|additional comments|anything else/i.test(label)) {
    return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION);
  }

  return reviewRecord(field, intent, REASON.UNKNOWN_INFORMATION);
}

export async function dryRunAnswerFn(fields, profile, opts = {}) {
  return {
    pageNumber: opts.pageNumber || 1,
    stepName: opts.stepName || '',
    answers: fields.map((field) => decisionFromProfile(field, profile)),
  };
}

function isYearOnlyDate(field, answer) {
  const type = field.elementType || field.controlType || '';
  if (!/date/i.test(type)) return false;
  const text = String(answer || '').trim();
  return /^\d{4}$/.test(text);
}

function pack(field, intent, answer, source, confidence = 0.95) {
  return buildAnswerRecord({
    questionId: field.questionId,
    intent,
    normalizedQuestion: field.label,
    answer,
    answerType: field.elementType || 'text',
    confidence,
    source,
    reasonCode: REASON.EXPLICIT_PROFILE_MATCH,
    requiresReview: confidence < 0.7,
  });
}
