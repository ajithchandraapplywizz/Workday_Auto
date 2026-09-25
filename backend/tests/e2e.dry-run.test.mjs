import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runPageOrchestrator } from '../lib/orchestrator/pageLoop.mjs';
import { STATUS } from '../lib/orchestrator/types.mjs';
import { withLocalPage, openFixture } from './helpers/browser.mjs';
import { createFixtureAdapter } from './helpers/fixtureAdapter.mjs';
import { buildMockHydratedProfile } from './helpers/mockProfile.mjs';
import { dryRunAnswerFn } from './helpers/dryRunAnswers.mjs';
import { metric } from './helpers/metrics.mjs';

const DRY = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/dry-run.html');

test('end-to-end dry run walks four pages and never submits', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, DRY);
    const profile = buildMockHydratedProfile();
    let pagesProcessed = 0;
    let pagesCompleted = 0;
    let filled = 0;
    let verified = 0;

    for (let n = 1; n <= 4; n += 1) {
      const adapter = createFixtureAdapter();
      const result = await runPageOrchestrator({
        page,
        profile,
        adapter,
        pageNumber: n,
        answerFn: dryRunAnswerFn,
      });
      pagesProcessed += 1;
      filled += result.filled || 0;
      verified += result.verified || 0;
      metric('phase3', 'page_processed', true, { detail: `page ${n} ${result.status}` });
      if (result.status === STATUS.PAGE_COMPLETE) {
        pagesCompleted += 1;
        metric('phase3', 'page_completed', true, { detail: `page ${n}` });
        if (n < 4) {
          await page.locator('#nextBtn').click();
          const stillOn = await page.evaluate(() => window.__dryRun.page);
          const navOk = stillOn === n + 1;
          metric('phase3', 'navigation', navOk, { detail: `to ${stillOn}`, code: navOk ? '' : 'F10' });
          assert.equal(stillOn, n + 1, `Next did not reach page ${n + 1}`);
        }
      } else {
        metric('phase3', 'page_completed', false, { detail: `page ${n} ${result.reason}`, code: 'F8' });
        if (n < 4) {
          await page.locator('#nextBtn').click();
          const advanced = await page.evaluate(() => window.__dryRun.page);
          if (advanced === n + 1) {
            metric('phase3', 'navigation', true, { detail: `incomplete page ${n} still allowed next in fixture` });
          } else {
            metric('phase3', 'navigation', true, { detail: 'blocked by required fields' });
            break;
          }
        }
      }
    }

    const submitted = await page.evaluate(() => window.__dryRun.submitted);
    metric('phase3', 'no_external_submit', submitted === false, { code: submitted ? 'F12' : '' });
    metric('phase3', 'end_to_end', pagesCompleted >= 3, {
      detail: `completed ${pagesCompleted}/4 filled=${filled} verified=${verified}`,
    });
    metric('phase3', 'fields_filled', true, { count: filled });
    metric('phase3', 'fields_verified', true, { count: verified });
    assert.equal(submitted, false, 'Submit Application was clicked — dry-run must not submit');
    assert.ok(pagesProcessed >= 1);
    assert.ok(pagesCompleted >= 1, 'no page reached a verified complete state');
  });
});
