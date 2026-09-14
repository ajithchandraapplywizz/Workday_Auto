/**
 * workdayPageWorkflow.mjs — One reusable pipeline for every Workday wizard page.
 *
 * SCAN → INTENT → EVIDENCE → GENERATE → VALIDATE → FILL → VERIFY → RESCAN
 * (implemented in runPageOrchestrator + questionEngine)
 *
 * Handles multipage Application Questions (Next between sub-pages).
 */

import { runPageOrchestrator } from './pageLoop.mjs';
import { workdayAdapter } from './adapters/workdayAdapter.mjs';
import { STATUS } from './types.mjs';
import {
  advanceApplicationQuestionsPage,
  getApplicationQuestionsPageInfo,
} from '../workdayQuestionFill.mjs';
import { waitForDomSettled } from '../workdayDom.mjs';

/**
 * Run the full orchestration workflow until the page is verified complete, blocked, or stalled.
 *
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {object} [plan]
 * @param {string} [stepName]
 * @param {{ maxCycles?: number, maxOuterPasses?: number, pageNumber?: number }} [options]
 */
export async function runWorkdayPageWorkflow(page, profile = {}, plan = {}, stepName = '', options = {}) {
  const maxCycles = options.maxCycles ?? (/voluntary disclosures|application questions/i.test(stepName) ? 18 : 14);
  const maxOuter = options.maxOuterPasses ?? 4;
  profile._currentStep = stepName;
  profile._jobUrl = profile._jobUrl || page.url();

  let totalFilled = 0;
  let lastOrch = null;
  let lastStatus = STATUS.PAGE_INCOMPLETE;

  for (let outer = 0; outer < maxOuter; outer++) {
    const aqMultipage = /application questions/i.test(stepName);
    const maxSubPages = aqMultipage ? 6 : 1;

    for (let sub = 0; sub < maxSubPages; sub++) {
      lastOrch = await runPageOrchestrator({
        page,
        profile,
        plan,
        adapter: workdayAdapter,
        stepName,
        pageNumber: options.pageNumber || sub + 1,
        maxCycles,
      });
      totalFilled += lastOrch.filled || 0;
      lastStatus = lastOrch.status;

      if (lastOrch.status === STATUS.BLOCKED) {
        return finalize(lastOrch, totalFilled, profile);
      }

      if (!aqMultipage) break;

      const info = await getApplicationQuestionsPageInfo(page).catch(() => null);
      if (!info || info.current >= info.total) break;

      console.log(`  ➡️  Application Questions page ${info.current}/${info.total} complete — Next`);
      const moved = await advanceApplicationQuestionsPage(page);
      if (!moved) break;
      await waitForDomSettled(page, { timeout: 1500 }).catch(() => {});
    }

    if (lastOrch?.status === STATUS.PAGE_COMPLETE) {
      break;
    }

    const progress = lastOrch?.filled || 0;
    if (outer > 0 && progress === 0) {
      break;
    }
    await waitForDomSettled(page, { timeout: 800 }).catch(() => {});
  }

  return finalize(lastOrch || { status: lastStatus, filled: 0 }, totalFilled, profile);
}

function finalize(orch, totalFilled, profile) {
  if (totalFilled > 0) {
    console.log(`  ✓ Page workflow: ${totalFilled} verified fill(s) (${orch.status})`);
  }
  if (orch.status === STATUS.BLOCKED) {
    console.log(`  🛑 Page workflow blocked: ${orch.reason} (${orch.questionId || ''})`);
  }
  return {
    filled: totalFilled,
    humanRequired: profile._humanRequired || [],
    pageCheck: orch.pageCheck,
    orchestrator: orch,
    status: orch.status,
  };
}
