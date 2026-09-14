/**
 * pageLoop.mjs — Manager: scan → reason → validate → fill → verify → re-scan.
 * LLM never receives a locator. Playwright never invents an answer.
 */

import {
  answerPageQuestions,
  decisionForField,
  isHighRiskIntent,
  resolveDynamicAnswer,
} from '../questionEngine/index.mjs';
import { isSelectOnePlaceholder } from '../interaction/workdayCustomDropdown.mjs';
import { normalizeLabel, saveAnswerToYaml } from '../qaStore.mjs';
import { isMandatoryField } from '../scanFieldFilter.mjs';
import { validateBeforeFill } from './preFillValidator.mjs';
import { rememberVerified } from './memory.mjs';
import { blockedResult, STATUS } from './types.mjs';
import { logOrchestrator } from './logger.mjs';

const MAX_FIELD_RETRIES = 2;

function mergeFields(existing = [], incoming = []) {
  const byId = new Map();
  for (const field of [...existing, ...incoming]) {
    const key = field.questionId || field.label;
    if (!key) continue;
    byId.set(key, field);
  }
  return [...byId.values()];
}

function pickNext(fields, filledIds, adapter, profile, stepName) {
  return fields.find((field) => {
    if (filledIds.has(field.questionId || field.label)) return false;
    return adapter.shouldFill(field, profile, stepName);
  }) || null;
}

function fieldNeedsFill(field, adapter, profile, stepName) {
  if (!adapter.shouldFill(field, profile, stepName)) return false;
  const cur = field.currentValue;
  if (cur == null || String(cur).trim() === '') return true;
  if (isSelectOnePlaceholder(cur)) return true;
  if (/^select(\s+one)?\.?$/i.test(String(cur).trim())) return true;
  return false;
}

function releaseStaleFilledIds(fields, filledIds, adapter, profile, step) {
  for (const field of fields) {
    if (!fieldNeedsFill(field, adapter, profile, step)) continue;
    filledIds.delete(field.questionId || field.label);
  }
}

/**
 * Run one wizard page to a verified state (or a structured block).
 * @param {object} args
 */
export async function runPageOrchestrator({
  page,
  profile = {},
  plan = {},
  adapter,
  stepName = '',
  pageNumber = 1,
  maxCycles = 12,
  answerFn = answerPageQuestions,
} = {}) {
  if (!adapter) throw new Error('runPageOrchestrator requires an ATS adapter');

  await adapter.waitStable(page);
  const detected = await adapter.detectPage(page).catch(() => stepName);
  const step = detected || stepName || 'Unknown';
  logOrchestrator('page_detect', { step, page: pageNumber, adapter: adapter.name });

  let fields = (await adapter.scan(page, { pageNumber, stepName: step })).fields || [];
  logOrchestrator('scan', { step, fields: fields.length });

  const filledIds = new Set();
  const failed = [];
  let filled = 0;
  let verified = 0;
  let pack = null;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    await adapter.waitStable(page);
    const scan = await adapter.scan(page, { pageNumber, stepName: step });
    fields = mergeFields(fields, scan.fields || []);
    logOrchestrator('rescan', { step, fields: fields.length, cycle });

    pack = await answerFn(fields, profile, {
      pageNumber,
      stepName: step,
      resumePath: plan?.resume || profile._resumePath,
    });

    let field = pickNext(fields, filledIds, adapter, profile, step);
    if (!field) {
      const pageCheckEarly = await adapter.validatePage(page, profile, step);
      if (pageCheckEarly.ok === true) break;
      releaseStaleFilledIds(fields, filledIds, adapter, profile, step);
      field = pickNext(fields, filledIds, adapter, profile, step);
      if (!field) break;
    }

    let decision = decisionForField(pack, field);
    let gate = validateBeforeFill(field, decision, profile);
    const mandatory = field.required === true || isMandatoryField(field.label, field);
    if (!gate.ok && mandatory) {
      const alt = await resolveDynamicAnswer(
        { ...(field._raw || {}), ...field, label: field.label },
        profile,
        {
          stepName: step,
          pageNumber,
          resumePath: plan?.resume || profile._resumePath,
          allowLlm: true,
        },
      );
      if (alt?.record) {
        const retry = validateBeforeFill(field, alt.record, profile);
        if (retry.ok) {
          logOrchestrator('evidence_retry', { questionId: field.questionId, from: gate.reason });
          gate = retry;
          decision = alt.record;
        }
      }
    }
    if (!gate.ok) {
      const highRisk = isHighRiskIntent(decision?.intent) && mandatory;
      logOrchestrator('skip_fill', {
        questionId: field.questionId,
        reason: gate.reason,
        required: field.required,
      });
      if (highRisk || (mandatory && gate.requiresReview)) {
        profile._humanRequired = profile._humanRequired || [];
        profile._humanRequired.push({
          label: field.label,
          questionId: field.questionId,
          reason: gate.reason,
          status: 'HUMAN_REQUIRED',
        });
        if (highRisk) {
          return blockedResult({
            page: pageNumber,
            questionId: field.questionId,
            reason: gate.reason,
            requiresReview: true,
            extras: { step, filled, verified, failed, adapter: adapter.name },
          });
        }
      }
      filledIds.add(field.questionId || field.label);
      continue;
    }

    let lastFill = null;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_FIELD_RETRIES; attempt++) {
      lastFill = await adapter.fill(page, field, gate.answer, {
        profile,
        pageNumber,
        confidence: decision.confidence,
      });
      await adapter.waitStable(page);
      const read = await adapter.readValue(page, field, { pageNumber, stepName: step });
      fields = mergeFields(fields, read.all || []);
      const actual = read.current || lastFill?.verifiedValue || '';
      const matched = adapter.valuesMatch(gate.answer, actual);
      logOrchestrator('verify', {
        questionId: field.questionId,
        requested: String(gate.answer).slice(0, 40),
        actual: String(actual).slice(0, 40),
        matched,
        attempt,
      });
      if (matched) {
        ok = true;
        rememberVerified(profile, {
          questionId: field.questionId,
          intent: decision.intent,
          label: field.label,
          answer: gate.answer,
        });
        profile.qa_answers = profile.qa_answers || {};
        profile.qa_answers[normalizeLabel(field.label)] = gate.answer;
        if (profile._persistAnswers !== false) {
          await saveAnswerToYaml(field.label, gate.answer).catch(() => {});
        }
        filled += 1;
        verified += 1;
        break;
      }
    }

    if (!ok) {
      failed.push({
        questionId: field.questionId,
        reason: 'verification_failed',
        requested: gate.answer,
      });
      logOrchestrator('field_failed', { questionId: field.questionId, reason: 'verification_failed' });
      if (field.required && isHighRiskIntent(decision.intent)) {
        return blockedResult({
          page: pageNumber,
          questionId: field.questionId,
          reason: 'verification_failed',
          requiresReview: true,
          extras: { step, filled, verified, failed, adapter: adapter.name },
        });
      }
      continue;
    }

    filledIds.add(field.questionId || field.label);
  }

  const pageCheck = await adapter.validatePage(page, profile, step);
  const complete = pageCheck.ok === true && failed.filter((f) => f.reason === 'verification_failed').length === 0;
  const status = complete ? STATUS.PAGE_COMPLETE : STATUS.PAGE_INCOMPLETE;
  logOrchestrator(status, {
    step,
    filled,
    verified,
    failed: failed.length,
    remaining: pageCheck.requiredRemaining,
  });

  return {
    status,
    page: pageNumber,
    step,
    filled,
    verified,
    failed,
    pageCheck,
    requiresReview: !complete,
    reason: complete ? '' : (pageCheck.reason || 'unresolved_fields'),
    adapter: adapter.name,
  };
}
