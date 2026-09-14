import { locateControl, assertEditable } from './locators.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Type into a text / email / tel / number input, then read the DOM value.
 */
export async function fillText(page, field, answer, ctx = {}) {
  const located = await locateControl(page, field, ['textbox', 'searchbox', 'spinbutton']);
  if (located.locator) {
    const gate = await assertEditable(located.locator);
    if (gate.ok) {
      await located.locator.scrollIntoViewIfNeeded().catch(() => {});
      await located.locator.fill('').catch(() => {});
      await located.locator.fill(String(answer)).catch(() => {});
      const actual = await located.locator.inputValue().catch(() => '');
      if (actual && (actual === String(answer) || actual.includes(String(answer)))) {
        return okResult(field, actual, 1);
      }
    }
  }
  const delegated = await delegateExistingFill(page, field, answer, ctx.profile);
  if (delegated) return okResult(field, answer, 2);
  return failResult(field, 'text_fill_unverified', { recoverable: true, attempts: 2 });
}
