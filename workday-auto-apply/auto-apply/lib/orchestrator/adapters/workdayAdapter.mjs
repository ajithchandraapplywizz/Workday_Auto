/**
 * Workday ATS adapter — Playwright hands only.
 * A future ATS implements the same methods; the question engine stays unchanged.
 */

import { discoverPage, interactField, validatePage } from '../../interaction/index.mjs';
import { waitForDomSettled, isDiscoveredFieldFilled, readFieldState } from '../../workdayDom.mjs';
import { detectWorkdayStep } from '../../stateDetector.mjs';
import { selectionMatchesAnswer } from '../../workdayDefaults.mjs';
import {
  isSkippableUnimportantLabel,
  shouldSkipOptionalFill,
  shouldIncludeInScan,
  isMandatoryField,
} from '../../scanFieldFilter.mjs';
import { normalizeLabel } from '../../qaStore.mjs';

function fieldForFilter(field = {}) {
  return {
    ...(field._raw || {}),
    ...field,
    required: field.required === true || field._raw?.required === true,
    ariaRequired: field.ariaRequired === true || field._raw?.ariaRequired === true,
    hasRequiredMarker: field.hasRequiredMarker === true || field._raw?.hasRequiredMarker === true,
    containerText: field.containerText || field._raw?.containerText || '',
  };
}

export const workdayAdapter = {
  name: 'workday',

  async detectPage(page) {
    return detectWorkdayStep(page);
  },

  async waitStable(page) {
    await waitForDomSettled(page, { timeout: 250 }).catch(() => {});
  },

  async scan(page, meta = {}) {
    return discoverPage(page, {
      pageNumber: meta.pageNumber || 1,
      stepName: meta.stepName || '',
    });
  },

  shouldFill(field, profile = {}, stepName = '') {
    const label = field.label || '';
    if (!label) return false;
    if (field.elementType === 'button') return false;
    if (stepName === 'My Experience'
      && profile?._workdaySkillsFilled === true
      && /type\s*to\s*add\s*skills|enter\s+a\s*skill\s*below/i.test(label)) return false;

    // My Information fields are handled by handleStep1MyInformation — skip in orchestrator
    // to prevent stall-break on fields that are already filled by the dedicated handler.
    if (stepName === 'My Information') {
      const myInfoHandled = /how did you hear about us|phone\s*(number|device\s*type)?|country\s*(\/\s*territory\s*)?phone\s*code|city|state\s*\/\s*(region|province)|address\s*line|postal\s*code|country\s*\(address|^country$/i.test(label);
      if (myInfoHandled) return false;
    }

    const raw = fieldForFilter(field);
    const mandatory = isMandatoryField(label, raw, stepName);
    if (field.elementType === 'file' && !mandatory) return false;
    if (isDiscoveredFieldFilled(field._raw || field, label)) return false;
    if (mandatory) return field.elementType !== 'file';
    if (isSkippableUnimportantLabel(label, raw, stepName)) return false;
    if (shouldSkipOptionalFill(label, raw, profile, stepName)) return false;
    if (profile?._fillOptionalFields !== true && !shouldIncludeInScan(label, raw, stepName)) {
      return false;
    }
    if (stepName === 'My Information' && /how did you hear about us/i.test(label)) {
      return false;
    }
    return true;
  },

  async fill(page, field, answer, ctx = {}) {
    return interactField(page, field, { answer, confidence: ctx.confidence }, {
      profile: ctx.profile,
      pageNumber: ctx.pageNumber || field.pageNumber || 1,
    });
  },

  async readValue(page, field, meta = {}) {
    const directVal = await readFieldState(page, field).catch(() => '');
    if (directVal && !/^select(\s+one)?\.?$/i.test(directVal)) {
      return {
        current: directVal,
        field: { ...field, currentValue: directVal },
        all: [],
      };
    }
    const snap = await discoverPage(page, {
      pageNumber: meta.pageNumber || field.pageNumber || 1,
      stepName: meta.stepName || field.stepName || '',
    });
    const norm = normalizeLabel(field.label || '');
    const match = snap.fields.find((f) => f.questionId === field.questionId)
      || snap.fields.find((f) => normalizeLabel(f.label) === norm);
    return {
      current: match?.currentValue ?? '',
      field: match || null,
      all: snap.fields,
    };
  },

  valuesMatch(requested, actual) {
    return selectionMatchesAnswer(actual, requested);
  },

  async validatePage(page, profile, stepName) {
    return validatePage(page, profile, stepName);
  },
};
