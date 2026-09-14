import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runPageOrchestrator } from '../lib/orchestrator/pageLoop.mjs';
import { STATUS } from '../lib/orchestrator/types.mjs';
import { withLocalPage, openFixture } from './helpers/browser.mjs';
import { createFixtureAdapter } from './helpers/fixtureAdapter.mjs';
import { scanFixtureFields } from './helpers/scanFixture.mjs';
import { buildMockHydratedProfile } from './helpers/mockProfile.mjs';
import { decisionFromProfile } from './helpers/dryRunAnswers.mjs';
import { metric } from './helpers/metrics.mjs';

const CONTROLS = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/controls.html');

test('orchestrator rescans after a Yes on driver license and does not invent the number', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, CONTROLS);
    const profile = buildMockHydratedProfile();
    const seen = [];
    const adapter = createFixtureAdapter();
    const result = await runPageOrchestrator({
      page,
      profile,
      adapter,
      pageNumber: 1,
      maxCycles: 20,
      answerFn: async (fields) => {
        seen.push(fields.map((f) => f.label));
        return {
          answers: fields.map((field) => {
            if (/driver'?s license\?/i.test(field.label) && !/number/i.test(field.label)) {
              return {
                questionId: field.questionId,
                intent: 'yes_no',
                answer: 'Yes',
                confidence: 0.95,
                requiresReview: false,
                source: 'explicit_user_data',
                reasonCode: 'EXPLICIT_PROFILE_MATCH',
                normalizedQuestion: field.label,
              };
            }
            return decisionFromProfile(field, profile);
          }),
        };
      },
    });

    const flat = seen.flat().join(' | ');
    const detectedDynamic = /license number/i.test(flat);
    metric('phase3', 'dynamic_detected', detectedDynamic, {
      detail: `scans=${seen.length}`,
      code: detectedDynamic ? '' : 'F9',
    });

    const after = await scanFixtureFields(page, { pageNumber: 1 });
    const numberField = after.find((f) => /license number/i.test(f.label));
    const invented = Boolean(numberField?.currentValue);
    metric('phase3', 'dynamic_no_invent', !invented, { code: invented ? 'F6' : '' });
    assert.ok(detectedDynamic || numberField, 'dynamic license number never appeared in a rescan');
    assert.equal(invented, false, 'license number was filled without profile support');
    assert.notEqual(result.status, undefined);
    metric('phase3', 'dynamic_status', result.status !== STATUS.PAGE_COMPLETE || !numberField?.required, {
      detail: result.status,
    });
  });
});
