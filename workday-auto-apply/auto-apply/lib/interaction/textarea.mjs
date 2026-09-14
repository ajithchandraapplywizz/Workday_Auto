import { locateControl, assertEditable } from './locators.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

export async function fillTextarea(page, field, answer, ctx = {}) {
  const located = await locateControl(page, field, ['textbox']);
  if (located.locator) {
    const tag = await located.locator.evaluate((el) => el.tagName || '').catch(() => '');
    const gate = await assertEditable(located.locator);
    if (gate.ok && /textarea/i.test(tag)) {
      await located.locator.scrollIntoViewIfNeeded().catch(() => {});
      await located.locator.fill(String(answer)).catch(() => {});
      const actual = await located.locator.inputValue().catch(() => '');
      if (actual && actual.trim()) return okResult(field, actual, 1);
    }
  }
  const delegated = await delegateExistingFill(page, field, answer, ctx.profile);
  if (delegated) return okResult(field, answer, 2);
  return failResult(field, 'textarea_fill_unverified', { recoverable: true, attempts: 2 });
}
