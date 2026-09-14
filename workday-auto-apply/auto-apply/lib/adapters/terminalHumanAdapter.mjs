/**
 * terminalHumanAdapter.mjs — Opt-in stdin (FORM_ANSWER_TERMINAL=1).
 * Default: form answers come from Apply Wizz / YAML / profile / LLM only.
 */

import { promptUserInTerminal } from '../engine.mjs';
import { isFormAnswerTerminalEnabled } from '../planner.mjs';

export function createTerminalHumanAdapter() {
  return {
    async requestAnswer({ question, fieldType, options, complianceSensitive, company }) {
      if (!isFormAnswerTerminalEnabled()) {
        console.log(`    ⚠️  UNRESOLVED "${String(question || '').slice(0, 70)}" — terminal adapter disabled`);
        return null;
      }
      return promptUserInTerminal(question, fieldType, options || [], {
        company,
        compliance: complianceSensitive,
      });
    },
  };
}
