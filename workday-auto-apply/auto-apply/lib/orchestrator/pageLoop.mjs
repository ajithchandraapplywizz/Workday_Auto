/**
 * pageLoop.mjs — Manager: scan → reason → validate → fill → verify → re-scan.
 * LLM never receives a locator. Playwright never invents an answer.
 */

import {
  answerPageQuestions,
  decisionForField,
  isHighRiskIntent,
  classifyQuestionIntent,
  resolveDynamicAnswer,
  llmAnswerWithPlaywrightContext,
} from '../questionEngine/index.mjs';
import { isSelectOnePlaceholder } from '../interaction/workdayCustomDropdown.mjs';
import { normalizeLabel, saveAnswerToYaml, appendManualReviewRecord } from '../qaStore.mjs';
import { isMandatoryField } from '../scanFieldFilter.mjs';
import { validateBeforeFill } from './preFillValidator.mjs';
import { rememberVerified } from './memory.mjs';
import { blockedResult, STATUS } from './types.mjs';
import { logOrchestrator } from './logger.mjs';
import { collectLiveFieldOptions } from '../workdayDom.mjs';
import { resolveClientAnswer } from '../clientAnswer.mjs';
import { trace, logFieldTrace } from '../trace.mjs';
import { makeGuard } from '../loopGuard.mjs';
import { verifyProvenance } from '../provenanceGate.mjs';

const MAX_FIELD_RETRIES = 2;
const MAX_FILLS_PER_CYCLE = 24;
const MAX_VERIFY_FAILS_PER_FIELD = 2;

function squashOptionText(v = '') {
  return String(v).toLowerCase().replace(/[^\w]/g, '');
}

function multiCheckboxAnswersMatch(requested, actualChecked = []) {
  const wants = String(requested || '').split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
  const checked = (actualChecked || []).map((p) => String(p).trim()).filter(Boolean);
  if (!wants.length || !checked.length) return false;
  return wants.every((w) => {
    const wSq = squashOptionText(w);
    return checked.some((c) => squashOptionText(c) === wSq || squashOptionText(c).includes(wSq) || wSq.includes(squashOptionText(c)));
  });
}

function fieldDedupeKey(field = {}) {
  const norm = normalizeLabel(field.label || '');
  if (norm) return `label:${norm}`;
  return field.questionId || field.label || '';
}

/** Latest scan wins; one row per normalized question label (guards duplicate wdq ids). */
function dedupeFields(fields = []) {
  const byKey = new Map();
  for (const field of fields) {
    const key = fieldDedupeKey(field);
    if (!key) continue;
    byKey.set(key, field);
  }
  return [...byKey.values()];
}

function pickNext(fields, filledIds, filledNormLabels, adapter, profile, stepName) {
  return fields.find((field) => {
    const id = field.questionId || field.label;
    const norm = normalizeLabel(field.label || '');
    if (filledIds.has(id)) return false;
    if (norm && filledNormLabels.has(norm)) return false;
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

function releaseStaleFilledIds(fields, filledIds, filledNormLabels, adapter, profile, step, verifyFailCounts = null) {
  for (const field of fields) {
    if (!fieldNeedsFill(field, adapter, profile, step)) continue;
    const failKey = fieldDedupeKey(field);
    if (verifyFailCounts && (verifyFailCounts.get(failKey) || 0) >= MAX_VERIFY_FAILS_PER_FIELD) {
      continue; // Never release fields that reached maximum verification retry cap
    }
    const skipNorm = normalizeLabel(field.label || '');
    const skipKey = skipNorm || field.questionId || field.label;
    if ((profile?._orchestratorSkipTries?.get(skipKey) || 0) >= 1) {
      continue; // Never release fields that were already gated/skipped as human required
    }
    filledIds.delete(field.questionId || field.label);
    const norm = normalizeLabel(field.label || '');
    if (norm) filledNormLabels.delete(norm);
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
  const step = (stepName && stepName !== 'Unknown') ? stepName : (detected || stepName || 'Unknown');
  logOrchestrator('page_detect', { step, page: pageNumber, adapter: adapter.name });

  let fields = dedupeFields((await adapter.scan(page, { pageNumber, stepName: step })).fields || []);
  if (profile?._fillOptionalFields !== true && adapter.name === 'workday') {
    fields = fields.filter((f) => f.required === true || isMandatoryField(f.label, f, step));
  }
  logOrchestrator('scan', { step, fields: fields.length });
  for (const f of fields) {
    trace({
      stage: 'scan',
      step,
      page: pageNumber,
      label: f.label,
      normLabel: normalizeLabel(f.label || ''),
      fieldType: f.fieldType || f.elementType,
      options: f.options,
    });
  }

  const guard = makeGuard({ maxAttemptsPerField: MAX_FIELD_RETRIES, maxIterationsPerPage: maxCycles });
  const filledIds = new Set();
  const filledNormLabels = new Set();
  const verifyFailCounts = new Map();
  const failed = [];
  let filled = 0;
  let verified = 0;
  let pack = null;
  let prevFieldCount = fields.length;
  let stallCycles = 0;

  let cyclesWithoutFill = 0;
  outer: for (let cycle = 0; cycle < maxCycles; cycle++) {
    await adapter.waitStable(page);
    const scan = await adapter.scan(page, { pageNumber, stepName: step });
    fields = dedupeFields(scan.fields || []);
    if (profile?._fillOptionalFields !== true && adapter.name === 'workday') {
      fields = fields.filter((f) => f.required === true || isMandatoryField(f.label, f, step));
    }
    logOrchestrator('rescan', { step, fields: fields.length, cycle });

    if (cycle > 0 && fields.length > prevFieldCount + 4) {
      stallCycles += 1;
      if (stallCycles >= 2) {
        logOrchestrator('stall_break', { step, fields: fields.length, cycle, reason: 'field_count_growth' });
        break;
      }
    } else {
      stallCycles = 0;
    }
    prevFieldCount = fields.length;

    pack = await answerFn(fields, profile, {
      page,
      pageNumber,
      stepName: step,
      resumePath: plan?.resume || profile._resumePath,
    });

    const filledBeforeCycle = filled;
    let fillsThisCycle = 0;

    while (fillsThisCycle < MAX_FILLS_PER_CYCLE) {
    let field = pickNext(fields, filledIds, filledNormLabels, adapter, profile, step);
    if (!field) {
      if (fillsThisCycle === 0) {
        const pageCheckEarly = await adapter.validatePage(page, profile, step);
        if (pageCheckEarly.ok === true) break;
        releaseStaleFilledIds(fields, filledIds, filledNormLabels, adapter, profile, step, verifyFailCounts);
        field = pickNext(fields, filledIds, filledNormLabels, adapter, profile, step);
      }
      if (!field) break;
    }

    let decision = decisionForField(pack, field);
    let gate = validateBeforeFill(field, decision, profile);
    const mandatory = field.required === true || isMandatoryField(field.label, field, step);
    if (!gate.ok && mandatory && gate.reason !== 'high_risk_missing_data') {
      const alt = await resolveDynamicAnswer(
        { ...(field._raw || {}), ...field, label: field.label },
        profile,
        {
          page,
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
      if (!gate.ok) {
        const domLlm = await llmAnswerWithPlaywrightContext(
          { ...(field._raw || {}), ...field, label: field.label },
          profile,
          { page, stepName: step, resumePath: plan?.resume || profile._resumePath },
        );
        if (domLlm?.answer && !domLlm.requiresReview) {
          const retry = validateBeforeFill(field, domLlm, profile);
          if (retry.ok) {
            logOrchestrator('llm_dom_retry', { questionId: field.questionId, from: gate.reason });
            gate = retry;
            decision = domLlm;
          }
        }
      }
      if (!gate.ok && mandatory) {
        const clientHit = await resolveClientAnswer(
          { ...(field._raw || {}), ...field, label: field.label, required: true },
          profile,
          {
            page,
            stepName: step,
            forceLlm: true,
            required: true,
            resumePath: plan?.resume || profile._resumePath,
          },
        );
        if (clientHit?.answer) {
          const synthetic = {
            questionId: field.questionId,
            intent: classifyQuestionIntent(field.label, field),
            answer: clientHit.answer,
            confidence: 0.78,
            requiresReview: false,
            source: clientHit.source || 'llm_profile',
          };
          const retry = validateBeforeFill(field, synthetic, profile);
          if (retry.ok) {
            logOrchestrator('llm_force_retry', { questionId: field.questionId, from: gate.reason });
            gate = retry;
            decision = synthetic;
          }
        }
      }
    }

    // Provenance Gate Check (Block-and-log mode)
    const prov = verifyProvenance(field, decision);
    if (!prov.ok) {
      logOrchestrator('provenance_blocked', {
        questionId: field.questionId,
        label: field.label,
        source: prov.source,
        reason: prov.reason,
      });
      trace({
        stage: 'provenance_blocked',
        step,
        page: pageNumber,
        questionId: field.questionId,
        label: field.label,
        source: prov.source,
        evidence: prov.evidence,
        matchScore: prov.matchScore,
        reason: prov.reason,
        controlTag: field.controlTag || field._raw?.tagName,
        controlRole: field.controlRole || field.role || field._raw?.role,
        controlAriaHaspopup: field.controlAriaHaspopup || field._raw?.ariaHaspopup,
        controlType: field.elementType || field.fieldType,
        controlId: field.questionId || field._raw?.wdQId || field.label,
        labelResolutionPath: field.locatorStrategy?.preferred || 'label',
      });
      gate = { ok: false, reason: `provenance_gate:${prov.reason}`, requiresReview: true };
    }
    if (!gate.ok) {
      const highRisk = isHighRiskIntent(decision?.intent || classifyQuestionIntent(field.label, field)) && mandatory;
      logOrchestrator('skip_fill', {
        questionId: field.questionId,
        reason: gate.reason,
        required: field.required,
      });
      const autoId = field.automationId || field._raw?.automationId || field._raw?.['data-automation-id'] || field.questionId;
      logFieldTrace({
        automationId: autoId,
        label: field.label,
        controlType: field.elementType || field.fieldType || 'text',
        tier: decision?.source || 'unresolved',
        valueAttempted: gate?.answer || decision?.answer || '',
        success: false,
        reason: gate.reason || 'validation_failed',
        step,
        page: pageNumber,
      });
      appendManualReviewRecord({
        candidateId: profile?.id || process.env.APPLYWIZZ_ID,
        tenant: profile?._tenant || '',
        questionLabel: field.label,
        controlType: field.controlType || field.elementType || field.fieldType || 'text',
        visibleOptions: field.options || [],
        tierAttempted: decision?.source || 'unresolved',
        attemptedValue: gate?.answer || decision?.answer || '',
        reason: gate.reason || 'validation_failed',
        step,
      }).catch(() => {});
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
        console.log(`    ⚠️  Mandatory field needs review: "${field.label}" — attempting safe fallback...`);
      }
      const skipNorm = normalizeLabel(field.label || '');
      const skipKey = skipNorm || field.questionId || field.label;
      profile._orchestratorSkipTries = profile._orchestratorSkipTries || new Map();
      const tries = profile._orchestratorSkipTries.get(skipKey) || 0;
      profile._orchestratorSkipTries.set(skipKey, tries + 1);
      if (!mandatory || tries >= 1) {
        filledIds.add(field.questionId || field.label);
        if (skipNorm) filledNormLabels.add(skipNorm);
      }
      cyclesWithoutFill += 1;
      if (cyclesWithoutFill >= 4) {
        logOrchestrator('stall_break', { step, cycle, reason: 'unresolved_required' });
        break outer;
      }
      fillsThisCycle += 1;
      continue;
    }

    if (guard.isExceeded(field)) {
      logOrchestrator('field_skipped_guard_exceeded', {
        step,
        questionId: field.questionId,
        label: field.label,
        reason: 'max_attempts_reached',
      });
      const autoId = field.automationId || field._raw?.automationId || field._raw?.['data-automation-id'] || field.questionId;
      logFieldTrace({
        automationId: autoId,
        label: field.label,
        controlType: field.elementType || field.fieldType || 'text',
        tier: decision?.source || 'guard',
        valueAttempted: gate?.answer || '',
        success: false,
        reason: 'max_attempts_reached',
        step,
        page: pageNumber,
      });
      filledIds.add(field.questionId || field.label);
      const failNorm = normalizeLabel(field.label || '');
      if (failNorm) filledNormLabels.add(failNorm);
      cyclesWithoutFill += 1;
      fillsThisCycle += 1;
      continue;
    }

    let lastFill = null;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_FIELD_RETRIES; attempt++) {
      if (guard.isExceeded(field)) {
        trace({
          stage: 'guard_exceeded',
          guardKey: guard.makeKey(field),
          attempts: 2,
          action: 'break_attempts',
        });
        break;
      }
      const guardKey = guard.makeKey(field, gate.answer, fillsThisCycle);
      const attemptRecord = guard.recordAttempt(field, gate.answer, fillsThisCycle);
      if (attemptRecord.exceeded) {
        trace({
          stage: 'guard_exceeded',
          guardKey,
          attempts: attemptRecord.count,
          action: 'break_attempts',
        });
        break;
      }
      const controlId = field.questionId || field._raw?.wdQId || field.label;
      const controlTag = field.controlTag || field._raw?.tagName || 'unknown';
      const controlRole = field.controlRole || field.role || field._raw?.role || 'unknown';
      const controlAriaHaspopup = field.controlAriaHaspopup || field._raw?.ariaHaspopup || null;
      const controlType = field.elementType || field.fieldType || 'text';
      const labelResolutionPath = field.locatorStrategy?.preferred || 'label';
      const source = decision?.source || 'unknown';
      const evidence = decision?.evidence || decision?.reasonCode || '';
      const matchScore = decision?.score ?? decision?.confidence ?? 1.0;

      trace({
        stage: 'fill',
        step,
        page: pageNumber,
        questionId: field.questionId,
        label: field.label,
        answer: gate.answer,
        attempt,
        guardKey,
        source,
        evidence,
        matchScore,
        controlTag,
        controlRole,
        controlAriaHaspopup,
        controlType,
        controlId,
        labelResolutionPath,
      });
      lastFill = await adapter.fill(page, field, gate.answer, {
        profile,
        pageNumber,
        confidence: decision.confidence,
      });
      await adapter.waitStable(page);
      const read = await adapter.readValue(page, field, { pageNumber, stepName: step });
      if (read.all?.length) {
        let newFields = dedupeFields(read.all);
        if (profile?._fillOptionalFields !== true && adapter.name === 'workday') {
          newFields = newFields.filter((f) => f.required === true || isMandatoryField(f.label, f, step));
        }
        fields = newFields;
      } else {
        fields = dedupeFields(fields);
      }
      let actual = read.current ?? '';
      if (!actual && lastFill?.success === true) {
        actual = lastFill?.verifiedValue || '';
      }
      if (isSelectOnePlaceholder(actual)) {
        actual = '';
      }
      const isMultiCb = /multi-checkbox|checkbox-group/i.test(String(field.elementType || field.fieldType || ''));
      let matched = false;
      if (isMultiCb) {
        if (lastFill?.success === true) {
          matched = true;
        } else {
          const checked = await page.evaluate(({ pattern }) => {
            let re;
            try { re = new RegExp(pattern, 'i'); } catch { return []; }
            const out = [];
            for (const fieldEl of document.querySelectorAll('[data-automation-id*="formField"], fieldset')) {
              if (!re.test((fieldEl.textContent || '').replace(/\s+/g, ' '))) continue;
              fieldEl.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
                const id = cb.id;
                const lab = id ? fieldEl.querySelector(`label[for="${CSS.escape(id)}"]`) : cb.closest('label');
                const t = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
                if (t) out.push(t);
              });
              break;
            }
            return out;
          }, { pattern: (field.label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80) }).catch(() => []);
          matched = multiCheckboxAnswersMatch(gate.answer, checked)
            || multiCheckboxAnswersMatch(gate.answer, String(actual).split(','));
          if (checked.length) actual = checked.join(', ');
        }
      } else {
        matched = (field.elementType === 'checkbox' && lastFill?.success === true)
          || adapter.valuesMatch(gate.answer, actual);
      }
      trace({
        stage: 'verify',
        step,
        page: pageNumber,
        questionId: field.questionId,
        label: field.label,
        expected: gate.answer,
        actual,
        guardKey,
        ok: matched,
        attempt,
        source,
        evidence,
        matchScore,
        controlTag,
        controlRole,
        controlAriaHaspopup,
        controlType,
        controlId,
        labelResolutionPath,
      });
      const autoId = field.automationId || field._raw?.automationId || field._raw?.['data-automation-id'] || field.questionId || controlId;
      logFieldTrace({
        automationId: autoId,
        label: field.label,
        controlType,
        tier: source,
        valueAttempted: gate.answer,
        success: matched,
        reason: matched ? 'verified' : (lastFill?.reason || 'verification_failed'),
        step,
        page: pageNumber,
      });
      logOrchestrator('verify', {
        questionId: field.questionId,
        requested: String(gate.answer).slice(0, 40),
        actual: String(actual).slice(0, 40),
        matched,
        attempt,
      });
      if (matched) {
        ok = true;
        field.currentValue = gate.answer;
        if (field._raw) field._raw.currentValue = gate.answer;
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
      if (attemptRecord.exceeded) {
        trace({
          stage: 'guard_exceeded',
          guardKey,
          attempts: attemptRecord.count,
          action: 'break_attempts',
        });
        break;
      }
    }

    if (!ok) {
      const failKey = fieldDedupeKey(field);
      const failN = (verifyFailCounts.get(failKey) || 0) + 1;
      verifyFailCounts.set(failKey, failN);
      failed.push({
        questionId: field.questionId,
        reason: 'verification_failed',
        requested: gate.answer,
      });
      logOrchestrator('field_failed', { questionId: field.questionId, reason: 'verification_failed', attempt: failN });
      appendManualReviewRecord({
        candidateId: profile?.id || process.env.APPLYWIZZ_ID,
        tenant: profile?._tenant || '',
        questionLabel: field.label,
        controlType: field.controlType || field.elementType || field.fieldType || 'text',
        visibleOptions: field.options || [],
        tierAttempted: decision?.source || 'unverified',
        attemptedValue: gate.answer,
        reason: 'verification_failed',
        step,
      }).catch(() => {});
      if (mandatory && failN < MAX_VERIFY_FAILS_PER_FIELD) {
        const live = await collectLiveFieldOptions(page, field.label, field.fieldType || field.elementType).catch(() => []);
        if (live.length) {
          field.options = live;
          field._raw = { ...(field._raw || {}), options: live.map((text) => ({ text })) };
          const regen = await resolveClientAnswer(field, profile, {
            page,
            stepName: step,
            forceLlm: true,
            required: true,
            resumePath: plan?.resume || profile._resumePath,
          });
          if (regen?.answer && regen.answer !== gate.answer) {
            logOrchestrator('llm_reanswer_after_fail', { questionId: field.questionId, answer: String(regen.answer).slice(0, 40) });
            fillsThisCycle += 1;
            continue;
          }
        }
      }
      const definitiveFillFailure = /option_not_in_list|field_not_found|options_not_visible/.test(String(lastFill?.reason || ''));
      if (definitiveFillFailure) {
        console.log(`    ⏭️  No retry for ${field.questionId || field.label}: ${lastFill.reason}`);
      }
      if (field.required && isHighRiskIntent(decision.intent)) {
        return blockedResult({
          page: pageNumber,
          questionId: field.questionId,
          reason: 'verification_failed',
          requiresReview: true,
          extras: { step, filled, verified, failed, adapter: adapter.name },
        });
      }
      if (definitiveFillFailure) {
        cyclesWithoutFill += 1;
        fillsThisCycle += 1;
        continue;
      }
      cyclesWithoutFill += 1;
      if (failN >= MAX_VERIFY_FAILS_PER_FIELD) {
        filledIds.add(field.questionId || field.label);
        const failNorm = normalizeLabel(field.label || '');
        if (failNorm) filledNormLabels.add(failNorm);
      }
      if (cyclesWithoutFill >= 4) {
        logOrchestrator('stall_break', { step, cycle, reason: 'verification_stall' });
        break outer;
      }
      fillsThisCycle += 1;
      continue;
    }

    filledIds.add(field.questionId || field.label);
    const doneNorm = normalizeLabel(field.label || '');
    if (doneNorm) filledNormLabels.add(doneNorm);
    field.currentValue = gate.answer;
    if (field._raw) field._raw.currentValue = gate.answer;
    fillsThisCycle += 1;
    cyclesWithoutFill = 0;
    } // end multi-fill per cycle

    if (filled === filledBeforeCycle) {
      cyclesWithoutFill += 1;
      if (cyclesWithoutFill >= 3) {
        logOrchestrator('stall_break', { step, cycle, reason: 'no_verified_fills' });
        break;
      }
    } else {
      cyclesWithoutFill = 0;
    }
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
