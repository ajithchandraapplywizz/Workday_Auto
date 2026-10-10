/**
 * workdayScanHarvest.mjs — DOM question harvest for scan-batch (read-only catalog).
 */

import { getWorkdayTenant } from './discovery.mjs';
import {
  discoverFormFieldQuestions,
  discoverWorkdayFields,
  collectLiveFieldOptions,
  waitForDomSettled,
} from './workdayDom.mjs';
import { normalizeLabel } from './qaStore.mjs';
import { shouldIncludeInScan, isMandatoryField } from './scanFieldFilter.mjs';
import {
  getApplicationQuestionsPageInfo,
  advanceApplicationQuestionsPage,
} from './workdayQuestionFill.mjs';

function normalizeOptionList(options = []) {
  return options
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Infer standard options for Workday choice questions when DOM options are not yet opened.
 */
export function inferStandardOptions(label = '', fieldType = '') {
  const norm = String(label || '').toLowerCase();
  const type = String(fieldType || '').toLowerCase();
  const isChoice = /dropdown|select|radio|combobox/i.test(type);

  if (/^(gender|sex)\b/i.test(norm)) {
    return ['Male', 'Female', 'Decline to self-identify'];
  }
  if (/hispanic|latino/i.test(norm)) {
    return ['Yes', 'No', 'Decline to self-identify'];
  }
  if (/veteran/i.test(norm)) {
    return [
      'I am not a protected veteran',
      'I identify as one or more of the classifications of protected veteran',
      'I do not wish to self-identify',
    ];
  }
  if (/disability/i.test(norm)) {
    return [
      'Yes, I have a disability, or have a history/record of having a disability',
      'No, I do not have a disability, or have a history/record of having a disability',
      'I do not wish to answer',
    ];
  }
  if (/notice\s*period/i.test(norm)) {
    return ['Immediate', '2 Weeks', '1 Month', 'More than 1 month'];
  }
  if (isChoice || /\?/.test(norm)) {
    if (
      /\b(authorized|authorization|sponsorship|visa|over\s*18|age|previously|former|non-compete|convicted|felony|agree|consent|certify)\b/i.test(norm) ||
      /^(are you|have you|will you|do you|is your|were you|did you|can you|should you|would you)\b/i.test(norm)
    ) {
      return ['Yes', 'No'];
    }
  }
  return [];
}

/**
 * Harvest visible form questions on the current wizard page.
 * Records: label, fieldType, required, options (dropdown/radio/checkbox), step name.
 */
export async function harvestPageQuestions(page, { company, url, stepName }) {
  await waitForDomSettled(page);
  const formQuestions = await discoverFormFieldQuestions(page).catch(() => []);
  const domFields = await discoverWorkdayFields(page).catch(() => []);
  const harvested = [];
  const seen = new Set();

  const add = async (item) => {
    if (!shouldIncludeInScan(item.label, item, stepName)) return;
    const norm = normalizeLabel(item.label);
    if (!norm || seen.has(`${stepName}::${norm}`)) return;
    seen.add(`${stepName}::${norm}`);

    const isRequired = isMandatoryField(item.label, item, stepName) || Boolean(item.required);

    let options = normalizeOptionList(item.options);
    if (options.length === 0 && /dropdown|select|checkbox|radio|combobox/i.test(item.fieldType)) {
      // 1. Try standard inferred options first
      const inferred = inferStandardOptions(item.label, item.fieldType);
      if (inferred.length > 0) {
        options = inferred;
      } else {
        // 2. Safe timeout attempt to read live options
        try {
          const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve([]), 1200));
          const livePromise = collectLiveFieldOptions(page, item.label, item.fieldType);
          const liveOpts = await Promise.race([livePromise, timeoutPromise]);
          if (Array.isArray(liveOpts) && liveOpts.length > 0) {
            options = normalizeOptionList(liveOpts);
          }
        } catch (err) {
          // ignore timeout / non-fatal
        }
      }
    }

    harvested.push({
      label: item.label,
      question: item.label,
      normalized: norm,
      question_normalized: norm,
      fieldType: item.fieldType || 'text',
      field_type: item.fieldType || 'text',
      type: item.fieldType || 'text',
      required: isRequired,
      is_required: isRequired,
      options,
      step: stepName,
      company,
      tenant: getWorkdayTenant(url),
      url: page.url(),
      value: item.currentValue || item.value || '',
    });
  };

  for (const q of formQuestions) {
    if (!q.label || q.label.length < 3) continue;
    await add({
      label: q.label,
      fieldType: q.fieldType,
      required: q.required,
      options: q.options,
      currentValue: q.currentValue,
    });
  }

  for (const f of domFields) {
    const label = f.label || f.id;
    if (!label || label.length < 3) continue;
    await add({
      label,
      fieldType: f.type || f.role || 'input',
      required: f.required,
      options: f.options,
      currentValue: f.currentValue,
    });
  }

  return harvested;
}

/** Harvest Application Questions page 2, 3, … (page 1 already harvested by caller). */
export async function harvestApplicationQuestionSubpages(page, meta) {
  const collected = [];
  for (let pass = 0; pass < 8; pass++) {
    const info = await getApplicationQuestionsPageInfo(page);
    if (!info || info.current >= info.total) break;
    const advanced = await advanceApplicationQuestionsPage(page);
    if (!advanced) break;
    const batch = await harvestPageQuestions(page, meta);
    collected.push(...batch);
  }
  return collected;
}

export function summarizeQuestionsByStep(questions = []) {
  const byStep = {};
  for (const q of questions) {
    const step = q.step || 'Unknown';
    byStep[step] = (byStep[step] || 0) + 1;
  }
  return byStep;
}

export function formatStepQuestionSummary(byStep = {}) {
  const parts = Object.entries(byStep).map(([step, count]) => `${step}:${count}`);
  return parts.length ? parts.join(', ') : 'none';
}
