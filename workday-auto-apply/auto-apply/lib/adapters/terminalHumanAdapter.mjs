/**
 * terminalHumanAdapter.mjs — Local Phase human-in-the-loop (stdin)
 */

import { promptUserInTerminal } from '../engine.mjs';

export function createTerminalHumanAdapter() {
  return {
    async requestAnswer({ question, fieldType, options, complianceSensitive, company }) {
      return promptUserInTerminal(question, fieldType, options || [], {
        company,
        compliance: complianceSensitive,
      });
    },
  };
}
