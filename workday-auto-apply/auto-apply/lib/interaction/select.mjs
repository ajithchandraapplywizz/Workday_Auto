import { locateControl } from './locators.mjs';
import { delegateExistingFill } from './_delegate.mjs';
import { okResult, failResult } from './_result.mjs';

/**
 * Native <select> only. Prefer label, then value. No guess.
 */
export async function fillSelect(page, field, answer, ctx = {}) {
  const located = await locateControl(page, field, []);
  const loc = located.locator;
  const isNative = loc
    ? await loc.evaluate((el) => el.tagName === 'SELECT').catch(() => false)
    : false;

  if (isNative) {
    try {
      await loc.selectOption({ label: String(answer) }).catch(() => loc.selectOption({ value: String(answer) }));
      const selected = await loc.evaluate((el) => {
        const opt = el.selectedOptions?.[0];
        return (opt?.textContent || opt?.value || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      if (selected) return okResult(field, selected, 1);
    } catch {
      return failResult(field, 'native_select_option_not_found', { recoverable: true });
    }
  }

  const delegated = await delegateExistingFill(page, field, answer, ctx.profile);
  if (delegated) return okResult(field, answer, 2);
  return failResult(field, 'native_select_unverified', { recoverable: true, attempts: 2 });
}
