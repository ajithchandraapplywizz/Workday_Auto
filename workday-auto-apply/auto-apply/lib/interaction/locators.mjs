/**
 * locators.mjs — Accessible-name first. Never use nth() as the primary locator.
 */

import { locateWorkdayFieldByLabel } from '../workdayDom.mjs';

async function firstVisible(locator) {
  if (!locator) return null;
  const count = await locator.count().catch(() => 0);
  if (count < 1) return null;
  for (let i = 0; i < Math.min(count, 8); i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

/**
 * Locate a control with verified fallbacks. `.nth` is only used to walk
 * candidates after an accessible query already matched.
 * @param {import('playwright').Page} page
 * @param {object} field
 * @param {string[]} [roles]
 */
export async function locateControl(page, field = {}, roles = []) {
  const label = String(field.label || field._raw?.label || '').replace(/\*+/g, '').trim();
  const wdQId = field.wdQId || field._raw?.wdQId;
  const attempts = [];

  if (wdQId) {
    const marked = page.locator(`[data-wd-q-id="${wdQId}"]`).locator(
      'input:not([type="hidden"]), textarea, select, [role="combobox"], button[aria-haspopup="listbox"]',
    );
    const hit = await firstVisible(marked);
    if (hit) return { locator: hit, strategy: 'data-wd-q-id', attempts };
    attempts.push('data-wd-q-id_miss');
  }

  if (label) {
    try {
      const byLabel = page.getByLabel(label, { exact: false });
      const hit = await firstVisible(byLabel);
      if (hit) return { locator: hit, strategy: 'getByLabel', attempts };
    } catch { /* label too messy for getByLabel */ }
    attempts.push('getByLabel_miss');
  }

  const roleList = roles.length
    ? roles
    : ['textbox', 'combobox', 'radio', 'checkbox', 'searchbox', 'spinbutton'];
  if (label) {
    const truncated = label.slice(0, 80).trim();
    const nameRe = new RegExp(truncated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const role of roleList) {
      try {
        const hit = await firstVisible(page.getByRole(role, { name: nameRe }));
        if (hit) return { locator: hit, strategy: `role:${role}`, attempts };
      } catch { /* next role */ }
    }
    attempts.push('role+name_miss');
  }

  const autoId = field._raw?.automationId || field._raw?.dataAutomationId;
  if (autoId) {
    const hit = await firstVisible(page.locator(`[data-automation-id="${autoId}"]`));
    if (hit) return { locator: hit, strategy: 'data-automation-id', attempts };
    attempts.push('automation-id_miss');
  }

  if (label) {
    const byDom = await locateWorkdayFieldByLabel(page, label).catch(() => null);
    if (byDom && await byDom.isVisible().catch(() => false)) {
      return { locator: byDom, strategy: 'dom-relationship', attempts };
    }
    attempts.push('dom-relationship_miss');
  }

  return { locator: null, strategy: 'none', attempts };
}

export async function assertEditable(locator) {
  if (!locator) return { ok: false, reason: 'not_found' };
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return { ok: false, reason: 'not_visible' };
  const enabled = await locator.isEnabled().catch(() => false);
  if (!enabled) return { ok: false, reason: 'disabled' };
  const ro = await locator.getAttribute('readonly').catch(() => null);
  if (ro != null) return { ok: false, reason: 'read_only' };
  return { ok: true };
}
