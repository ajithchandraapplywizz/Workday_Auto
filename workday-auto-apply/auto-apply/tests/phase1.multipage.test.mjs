import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withLocalPage, openFixture } from './helpers/browser.mjs';
import { scanFixtureFields } from './helpers/scanFixture.mjs';
import { createFixtureAdapter } from './helpers/fixtureAdapter.mjs';
import { runPageOrchestrator } from '../lib/orchestrator/pageLoop.mjs';
import { buildMockHydratedProfile } from './helpers/mockProfile.mjs';
import { dryRunAnswerFn } from './helpers/dryRunAnswers.mjs';
import { metric } from './helpers/metrics.mjs';

const DRY = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/dry-run.html');

test('multipage fixture does not assume page-1 fields exist on later pages', async () => {
  await withLocalPage(async (page) => {
    await openFixture(page, DRY);
    const p1 = await scanFixtureFields(page, { pageNumber: 1 });
    assert.ok(p1.some((f) => /first name/i.test(f.label)));
    assert.equal(p1.some((f) => /university/i.test(f.label)), false);
    metric('phase1', 'multipage_page1_isolated', true);

    await page.locator('#firstName').fill('Test');
    await page.locator('#lastName').fill('User');
    await page.locator('#email').fill('test.user@example.test');
    await page.locator('#phone').fill('5550100');
    await page.locator('#p1Yes').check();
    await page.locator('#nextBtn').click();

    const p2 = await scanFixtureFields(page, { pageNumber: 2 });
    assert.ok(p2.some((f) => /university|degree/i.test(f.label)));
    assert.equal(p2.some((f) => /first name/i.test(f.label)), false);
    metric('phase1', 'multipage_page2_isolated', true);

    const profile = buildMockHydratedProfile();
    const adapter = createFixtureAdapter();
    const result = await runPageOrchestrator({
      page,
      profile,
      adapter,
      pageNumber: 2,
      answerFn: dryRunAnswerFn,
    });
    metric('phase1', 'multipage_page2_orchestrated', result.status === 'page_complete', {
      detail: result.status,
      code: result.status === 'page_complete' ? '' : 'F10',
    });
    assert.ok(result.status === 'page_complete' || result.status === 'page_incomplete', result.status);
  });
});
