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
import { shouldIncludeInScan } from './scanFieldFilter.mjs';
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
 * Harvest visible form questions on the current wizard page.
 * Records: label, fieldType, required, options (dropdown/radio/checkbox), step name.
 */
export async function harvestPageQuestions(page, { company, url, stepName }) {
  await waitForDomSettled(page);
  const formQuestions = await discoverFormFieldQuestions(page);
  const domFields = await discoverWorkdayFields(page);
  const harvested = [];
  const seen = new Set();

  const add = async (item) => {
    if (!shouldIncludeInScan(item.label, item)) return;
    const norm = normalizeLabel(item.label);
    if (!norm || seen.has(`${stepName}::${norm}`)) return;
    seen.add(`${stepName}::${norm}`);
    let options = normalizeOptionList(item.options);
    if (options.length === 0 && /dropdown|select|checkbox|radio|combobox/i.test(item.fieldType)) {
      try {
        options = await collectLiveFieldOptions(page, item.label, item.fieldType);
      } catch (err) {
        console.log(`    ⚠️  Could not collect options for "${String(item.label).slice(0, 55)}...": ${err.message}`);
      }
    }
    harvested.push({
      label: item.label,
      normalized: norm,
      fieldType: item.fieldType,
      required: Boolean(item.required),
      options,
      step: stepName,
      company,
      tenant: getWorkdayTenant(url),
      url: page.url(),
    });
  };

  for (const q of formQuestions) {
    if (!q.label || q.label.length < 4) continue;
    await add({
      label: q.label,
      fieldType: q.fieldType,
      required: q.required,
      options: q.options,
    });
  }

  for (const f of domFields) {
    const label = f.label || f.id;
    if (!label || label.length < 4) continue;
    if (/how did you hear|phone device|country.*phone|postal|address line/i.test(label)) continue;
    await add({
      label,
      fieldType: f.type || f.role || 'input',
      required: f.required,
      options: f.options,
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
