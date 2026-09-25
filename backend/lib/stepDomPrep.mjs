/**
 * stepDomPrep.mjs — Step-specific DOM fills (Playwright hands) before the question engine.
 * Answers still come from Apply Wizz / profile / LLM via orchestrator; this only handles
 * controls that need special widgets (CC-305 spinbuttons, EEO custom dropdowns, checkboxes).
 */

import {
  acknowledgeVibePrivacyOnce,
  acknowledgeForegoingStatementOnce,
  handleVoluntaryDisclosuresStep,
  ensureSelfIdentifyComplete,
} from './workdayQuestionFill.mjs';

/**
 * @param {import('playwright').Page} page
 * @param {string} stepName
 * @param {object} profile
 */
export async function runStepDomPrep(page, stepName = '', profile = {}) {
  const step = String(stepName || '');

  if (/voluntary disclosures/i.test(step)) {
    await acknowledgeVibePrivacyOnce(page, profile);
    await acknowledgeForegoingStatementOnce(page, profile);
    await handleVoluntaryDisclosuresStep(page, profile);
    return;
  }

  if (/self identify/i.test(step)) {
    await ensureSelfIdentifyComplete(page, profile);
  }
}
