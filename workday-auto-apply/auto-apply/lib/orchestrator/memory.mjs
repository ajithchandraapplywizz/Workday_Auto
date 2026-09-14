/**
 * Verified long-term knowledge for this application run.
 * Stored on the profile; persisted answers still go through qaStore after verify.
 */

import { normalizeLabel } from '../qaStore.mjs';
import { extractYesNoAnswer } from '../workdayDefaults.mjs';
import { isHighRiskIntent } from '../questionEngine/intents.mjs';

function bucket(profile) {
  if (!profile._verifiedMemory || typeof profile._verifiedMemory !== 'object') {
    profile._verifiedMemory = { byId: {}, byIntent: {}, byNorm: {} };
  }
  return profile._verifiedMemory;
}

export function rememberVerified(profile, { questionId, intent, label, answer } = {}) {
  if (!profile || !answer) return;
  const mem = bucket(profile);
  const entry = {
    questionId: questionId || '',
    intent: intent || '',
    label: label || '',
    answer: String(answer),
    verifiedAt: new Date().toISOString(),
  };
  if (questionId) mem.byId[questionId] = entry;
  if (intent) mem.byIntent[intent] = entry;
  const norm = normalizeLabel(label || '');
  if (norm) mem.byNorm[norm] = entry;
}

export function recallVerified(profile, { questionId, intent, label } = {}) {
  const mem = profile?._verifiedMemory;
  if (!mem) return null;
  if (questionId && mem.byId[questionId]) return mem.byId[questionId];
  const norm = normalizeLabel(label || '');
  if (norm && mem.byNorm[norm]) return mem.byNorm[norm];
  if (intent && mem.byIntent[intent]) return mem.byIntent[intent];
  return null;
}

/**
 * Same high-risk intent with an opposite Yes/No is a contradiction.
 * Generic yes/no questions do not share one global answer.
 */
export function contradictsVerified(profile, intent, answer) {
  if (!intent || !answer) return false;
  if (!isHighRiskIntent(intent)) return false;
  const prev = recallVerified(profile, { intent });
  if (!prev?.answer) return false;
  const a = extractYesNoAnswer(prev.answer);
  const b = extractYesNoAnswer(answer);
  if (a && b) return a !== b;
  return normalizeLabel(prev.answer) !== normalizeLabel(answer)
    && Boolean(a || b);
}
