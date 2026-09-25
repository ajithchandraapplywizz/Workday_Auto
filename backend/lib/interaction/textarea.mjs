import { locateControl, assertEditable } from './locators.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

export async function fillTextarea(page, field, answer, ctx = {}) {
  const located = await locateControl(page, field, ['textbox']);
  let targetLoc = null;

  if (located.locator) {
    const tag = await located.locator.evaluate((el) => el.tagName || '').catch(() => '');
    if (/textarea/i.test(tag)) {
      targetLoc = located.locator;
    } else {
      const inner = located.locator.locator('textarea, [contenteditable="true"], input[type="text"]').first();
      if (await inner.count().catch(() => 0)) targetLoc = inner;
    }
  }

  if (!targetLoc && field?.wdQId) {
    const byQId = page.locator(`[data-wd-q-id="${field.wdQId}"] textarea, [data-wd-q-id="${field.wdQId}"] [contenteditable="true"]`).first();
    if (await byQId.count().catch(() => 0)) targetLoc = byQId;
  }

  if (targetLoc) {
    const gate = await assertEditable(targetLoc);
    if (gate.ok) {
      await targetLoc.scrollIntoViewIfNeeded().catch(() => {});
      await targetLoc.click({ force: true }).catch(() => {});
      await targetLoc.fill(String(answer)).catch(async () => {
        // Fallback for rich editors
        await page.keyboard.type(String(answer), { delay: 10 }).catch(() => {});
      });
      let actual = await targetLoc.inputValue().catch(() => '');
      if (!actual) {
        actual = (await targetLoc.textContent().catch(() => '') || await targetLoc.innerText().catch(() => '') || '').trim();
      }
      if (actual && actual.trim()) return okResult(field, actual, 1);
    }
  }

  const delegated = await delegateExistingFill(page, field, answer, ctx.profile);
  if (delegated) return okResult(field, answer, 2);
  return failResult(field, 'textarea_fill_unverified', { recoverable: true, attempts: 2 });
}
