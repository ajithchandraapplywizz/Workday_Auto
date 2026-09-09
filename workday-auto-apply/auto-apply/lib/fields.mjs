/**
 * fields.mjs — Universal field finder, dropdown handler, and fuzzy matching
 *
 * Handles React Select (Greenhouse), ARIA dropdowns (Ashby/Lever),
 * native selects, custom selects, and every other pattern we've encountered.
 */

// ─── Fuzzy text matching ────────────────────────────────────────────────────
// Score how well two strings match (0 = no match, 1 = exact)
export function fuzzyScore(needle, haystack) {
  const a = needle.toLowerCase().trim();
  const b = haystack.toLowerCase().trim();
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const overlap = aWords.filter(w => bWords.some(bw => bw.includes(w) || w.includes(bw)));
  return overlap.length / Math.max(aWords.length, bWords.length) * 0.6;
}

/**
 * If a locator resolved to a <label> or wrapper (Workday often has label.for
 * pointing at a missing id), walk to the actual input/combobox.
 * @param {import('playwright').ElementHandle} handle
 * @returns {Promise<import('playwright').ElementHandle>}
 */
export async function resolveEditableControl(handle) {
  if (!handle) return null;
  const resolved = await handle.evaluateHandle(el => {
    const isFillable = (n) => {
      if (!n || n.nodeType !== 1) return false;
      const tag = n.tagName.toLowerCase();
      if (tag === 'label') return false;
      if (['input', 'textarea', 'select'].includes(tag)) return true;
      const role = n.getAttribute('role');
      if (role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'listbox') return true;
      if (n.getAttribute('contenteditable') === 'true') return true;
      if (n.getAttribute('data-automation-id') === 'select-widget') return true;
      return false;
    };

    if (isFillable(el)) return el;

    if (el.tagName === 'LABEL') {
      const forId = el.getAttribute('for');
      if (forId) {
        const byId = document.getElementById(forId);
        if (isFillable(byId)) return byId;
      }
      const inner = el.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"], [data-automation-id="select-widget"]');
      if (inner) return inner;
    }

    const nested = el.querySelector('input:not([type="hidden"]):not([type="search"]), textarea, select, [role="combobox"], [role="textbox"], [data-automation-id="select-widget"]');
    if (nested) return nested;

    const container = el.closest('[data-automation-id*="formField"], [data-automation-id*="Field"], fieldset') || el.parentElement;
    if (container) {
      const inContainer = container.querySelector('input:not([type="hidden"]):not([type="search"]), textarea, select, [role="combobox"], [role="textbox"], [data-automation-id="select-widget"]');
      if (inContainer) return inContainer;
    }
    return el;
  });
  return resolved.asElement() || handle;
}

// ─── Universal element finder ───────────────────────────────────────────────
export async function repairBrokenLabelForAttributes(page) {
  await page.evaluate(() => {
    const assignId = (el) => {
      if (!el || el.id) return el?.id || null;
      const id = `auto-generated-${Math.random().toString(36).slice(2, 10)}`;
      el.id = id;
      return id;
    };

    const candidates = Array.from(document.querySelectorAll('input, select, textarea, [role="combobox"], [role="textbox"], [contenteditable="true"], [data-automation-id*="select"], [data-automation-id*="field"]'));
    for (const candidate of candidates) {
      const candidateId = candidate.id || assignId(candidate);
      const label = candidate.closest('label') || Array.from(document.querySelectorAll('label')).find((node) => {
        const forId = node.getAttribute('for');
        return forId && forId === candidateId;
      });
      if (!label) continue;
      const labelFor = label.getAttribute('for');
      if (!labelFor || !document.getElementById(labelFor)) {
        label.setAttribute('for', candidateId);
      }
    }

    const labels = Array.from(document.querySelectorAll('label[for]'));
    for (const label of labels) {
      const targetId = label.getAttribute('for');
      if (!targetId || document.getElementById(targetId)) continue;
      const root = label.closest('[data-automation-id*="formField"], fieldset, [role="group"], .field');
      const field = (root || label.parentElement)?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"], [data-automation-id*="select"], [data-automation-id*="field"]') || document.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"], [data-automation-id*="select"], [data-automation-id*="field"]');
      if (!field) continue;
      const resolvedId = assignId(field);
      label.setAttribute('for', resolvedId);
    }
  }).catch(() => {});
}

export async function findField(page, entry) {
  const { selector, id, name, label, automationId } = entry;
  await repairBrokenLabelForAttributes(page).catch(() => {});
  const strategies = [
    // 1. data-automation-id (Workday highest-priority locator)
    async () => {
      const autoId = automationId || entry['data-automation-id'];
      if (!autoId) return null;
      const loc = page.locator(`[data-automation-id="${autoId}"]`).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
        return await loc.elementHandle();
      }
      return await page.$(`[data-automation-id="${autoId}"]`);
    },
    // 2. Label text
    async () => {
      if (!label) return null;
      const cleanLabel = label.replace(/\*+/g, '').trim();
      if (!cleanLabel) return null;
      try {
        const loc = page.getByLabel(cleanLabel, { exact: false });
        if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
          return await loc.first().elementHandle();
        }
      } catch { /* label not found */ }
      for (const combo of [
        `label:has-text("${cleanLabel}") + input`,
        `label:has-text("${cleanLabel}") + div input`,
        `label:has-text("${cleanLabel}") ~ input`,
        `label:has-text("${cleanLabel}") ~ div input`,
        `label:has-text("${cleanLabel}") + textarea`,
        `label:has-text("${cleanLabel}") + select`,
        `label:has-text("${cleanLabel}") ~ select`,
        `label:has-text("${cleanLabel}") ~ div select`,
        `div:has-text("${cleanLabel}") + input`,
        `div:has-text("${cleanLabel}") + div input`,
      ]) {
        try {
          const el = await page.$(combo);
          if (el) return el;
        } catch { /* invalid selector, skip */ }
      }
      return null;
    },
    // 3. id / name
    async () => {
      if (id) {
        try {
          const byAttr = await page.$(`[id="${id}"]`);
          if (byAttr) return byAttr;
          return await page.$(`#${CSS.escape(id)}`);
        } catch { /* try name */ }
      }
      return name ? await page.$(`[name="${name}"]`) : null;
    },
    // 4. ARIA role + accessible name
    async () => {
      if (!label) return null;
      const cleanLabel = label.replace(/\*+/g, '').trim();
      if (!cleanLabel) return null;
      const escaped = cleanLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRegex = new RegExp(escaped, 'i');
      for (const role of ['textbox', 'combobox', 'checkbox', 'radio', 'button', 'searchbox']) {
        try {
          const loc = page.getByRole(role, { name: nameRegex });
          if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
            return await loc.first().elementHandle();
          }
        } catch { /* try next role */ }
      }
      return null;
    },
    // 5. Direct selector from scan
    async () => selector ? await page.$(selector) : null,
  ];

  for (const strategy of strategies) {
    try {
      const el = await strategy();
      if (el) return await resolveEditableControl(el);
    } catch { /* try next */ }
  }
  return null;
}

// ─── Option selectors for dropdown scanning ─────────────────────────────────
const OPTION_SELECTORS = [
  '.select__option',                      // React Select (Greenhouse)
  '[role="option"]',                       // ARIA standard (Lever, Ashby, Workday)
  '.select2-results__option',              // Select2 (legacy ATS)
  '[class*="menu"] [class*="option"]',     // CSS module pattern
  '[class*="listbox"] [class*="option"]',  // ARIA listbox pattern
  'li[class*="option"]',                   // Lever, BambooHR
  '.dropdown-item',                        // Bootstrap-based ATS
  'div[data-value]',                       // Workday custom selects
  'div[data-automation-id="select-widget"]', // Workday select widget
  '[data-automation-id="promptOption"]',   // Workday prompt option
  '[data-automation-id="menuItem"]',       // Workday menu item
  'li[data-automation-id*="option"]',      // Workday list option
  'div[data-automation-id*="dropdown"]',   // Workday dropdown
  '.css-option, .css-1n7v3ny-option',      // Emotion/styled-components
  'ul.dropdown-content li',                // Materialize-based
  '[class*="MenuItem"]',                   // MUI Select
];

/**
 * Collect visible dropdown option labels from the open list (or open via trigger).
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator|null} [trigger]
 * @returns {Promise<string[]>}
 */
export async function collectVisibleDropdownOptions(page, trigger = null) {
  if (trigger) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }).catch(() => trigger.evaluate((el) => el.click()));
    await page.waitForTimeout(600);
  }

  const selectorCsv = OPTION_SELECTORS.join(', ');
  const options = await page.evaluate((selectors) => {
    const seen = new Set();
    const results = [];
    for (const sel of selectors.split(', ')) {
      document.querySelectorAll(sel).forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (!el.offsetParent && el.getClientRects().length === 0) return;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 140 || /^no options$/i.test(text) || /^select\.{3}$/i.test(text)) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push(text);
      });
    }
    return results;
  }, selectorCsv);

  return options;
}

// ─── Hierarchical dropdown handler (Workday prompt drill-down) ───────────────
export async function handleHierarchicalDropdown(page, trigger, primaryText, secondaryText, options = {}) {
  const timeout = options.timeout || 8000;
  const steps = [primaryText, secondaryText].filter(Boolean);

  async function clickVisibleTextOption(targetText, hint = '') {
    const escaped = String(targetText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const candidates = [
      page.getByRole('option', { name: regex }),
      page.getByRole('treeitem', { name: regex }),
      page.locator('[data-automation-id="promptOption"]').filter({ hasText: regex }),
      page.locator('[role="option"], [data-automation-id="promptOption"], li, div').filter({ hasText: regex }),
    ];

    for (const c of candidates) {
      const count = await c.count().catch(() => 0);
      if (!count) continue;
      const hit = c.first();
      const visible = await hit.isVisible({ timeout: 700 }).catch(() => false);
      if (visible) {
        await hit.click({ force: true });
        return true;
      }
    }

    const fallback = page.locator('[role="option"], [data-automation-id="promptOption"], li, div').filter({ hasText: new RegExp(String(targetText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
    if (await fallback.isVisible({ timeout: 700 }).catch(() => false)) {
      await fallback.click({ force: true });
      return true;
    }

    if (hint) {
      const maybe = page.locator('button, [role="combobox"], [role="button"]').filter({ hasText: new RegExp(String(hint).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
      if (await maybe.isVisible({ timeout: 700 }).catch(() => false)) {
        await maybe.click({ force: true });
      }
    }

    return false;
  }

  try {
    if (trigger && typeof trigger.click === 'function') {
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await trigger.click({ force: true }).catch(() => trigger.evaluate(el => el.click()));
    } else if (typeof trigger === 'string') {
      const el = await page.$(trigger);
      if (el) await el.click({ force: true });
    }
    await page.waitForTimeout(400);

    for (let i = 0; i < steps.length; i++) {
      const text = String(steps[i]);
      const ok = await clickVisibleTextOption(text, i === 0 ? primaryText : secondaryText);
      if (!ok) {
        throw new Error(`Could not select hierarchical option: ${text}`);
      }

      if (i < steps.length - 1) {
        try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
        await page.waitForTimeout(700);
      }
    }

    return { success: true, method: 'hierarchical-dropdown', steps };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Click a visible Workday prompt option by DOM text.
 * Prefers "United States of America (+1)" over "United States Minor Outlying Islands (+1)".
 * @param {import('playwright').Page} page
 * @param {string[]} needles
 * @returns {Promise<string|null>}
 */
export async function clickVisiblePromptOption(page, needles = []) {
  const chosen = await page.evaluate((needlesIn) => {
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(
      '[role="option"], [data-automation-id="promptOption"], [role="treeitem"], [data-automation-id="menuItem"]'
    )).filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && (el.offsetWidth > 0 || el.getClientRects().length > 0);
    });

    const items = nodes.map(el => ({ el, text: normalize(el.textContent) })).filter(i => i.text);

    const score = (text) => {
      const t = text.toLowerCase();
      let s = 0;
      for (const n of needlesIn) {
        const needle = String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!needle) continue;
        if (t === needle) s += 10;
        if (t.includes(needle)) s += 4;
        if (needle.includes('united states of america') && t.includes('united states of america') && t.includes('+1')) s += 8;
        if (t.includes('minor outlying')) s -= 6;
      }
      return s;
    };

    let best = null;
    let bestScore = 0;
    for (const item of items) {
      const sc = score(item.text);
      if (sc > bestScore) {
        bestScore = sc;
        best = item;
      }
    }
    if (!best || bestScore <= 0) return null;
    best.el.click();
    return best.text;
  }, needles);

  return chosen;
}

// ─── Searchable dropdown handler (Country Phone Code etc.) ──────────────────
export async function handleSearchableDropdown(page, trigger, searchTerm, optionText, options = {}) {
  const timeout = options.timeout || 8000;
  try {
    if (options.alreadyOpen) {
      /* trigger already opened by caller */
    } else if (trigger && typeof trigger.click === 'function') {
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await trigger.click({ force: true }).catch(() => trigger.evaluate(el => el.click()));
      await page.waitForTimeout(300);
    } else if (typeof trigger === 'string') {
      const el = await page.$(trigger);
      if (el) await el.click({ force: true });
      await page.waitForTimeout(300);
    }

    // 2. Locate search input or use trigger if it's already an input
    const searchInput = page.locator('input[role="searchbox"], input[type="search"], [data-automation-id*="search" i], input[aria-label*="Search" i]')
      .filter({ has: page.locator(':visible') })
      .first();

    const isSearchBoxVisible = await searchInput.isVisible().catch(() => false);
    if (isSearchBoxVisible) {
      await searchInput.fill('');
      await searchInput.pressSequentially(searchTerm, { delay: 40 });
    } else {
      let isInput = false;
      try {
        isInput = await trigger.evaluate(el => el.tagName.toLowerCase() === 'input');
      } catch {}

      if (isInput) {
        await trigger.fill('');
        await trigger.pressSequentially(searchTerm, { delay: 40 });
      } else {
        await page.keyboard.type(searchTerm, { delay: 40 });
      }
    }

    await page.waitForTimeout(400);
    try {
      await page.waitForFunction((needle) => {
        const n = String(needle || '').toLowerCase();
        return Array.from(document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]'))
          .some(el => (el.textContent || '').toLowerCase().includes(n) && el.offsetParent !== null);
      }, searchTerm, { timeout: 6000 });
    } catch { /* list may still be unfiltered; Enter often still selects the top match */ }

    // Workday country codes: type query then Enter (same as manual use)
    if (options.confirmWithEnter !== false) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      return { success: true, method: 'searchable-dropdown-enter' };
    }

    // 3. Select matching option from open list (DOM text, not vision)
    const clicked = await clickVisiblePromptOption(page, [optionText, searchTerm]);
    if (clicked) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(300);
      return { success: true, method: 'searchable-dropdown' };
    }

    const optEscaped = optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const optRegex = new RegExp(optEscaped, 'i');

    const matchOpt = page.getByRole('option', { name: optRegex })
      .or(page.locator('[data-automation-id="promptOption"]').filter({ hasText: optRegex }))
      .or(page.getByText(optionText, { exact: false }))
      .first();

    await matchOpt.waitFor({ state: 'visible', timeout });
    await matchOpt.click({ force: true }).catch(() => matchOpt.evaluate(el => el.click()));
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(300);

    return { success: true, method: 'searchable-dropdown' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Universal dropdown handler ─────────────────────────────────────────────
export async function handleDropdown(page, element, value, label) {
  // If hierarchical array provided (e.g. ['Website', 'Workday.com'])
  if (Array.isArray(value) && value.length >= 2) {
    return await handleHierarchicalDropdown(page, element, value[0], value[1]);
  }

  // Strategy 1: Try native <select> first
  const tagName = await element.evaluate(el => el.tagName.toLowerCase());
  if (tagName === 'select') {
    try {
      await element.selectOption({ label: value });
      return { success: true, method: 'native-select' };
    } catch {
      try {
        await element.selectOption({ value });
        return { success: true, method: 'native-select-value' };
      } catch { /* not a simple select */ }
    }
  }

  // Strategy 2: Type value + press Enter — skip for referral source (click-only; avoids +91 phone search)
  const isReferralSource = /how\s*did\s*you\s*hear/i.test(String(label || ''));
  if (!isReferralSource) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await element.scrollIntoViewIfNeeded();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await element.click();
      await page.waitForTimeout(200);
      await element.fill('');
      await page.waitForTimeout(100);

      // Type value -> waitForTimeout(500) -> press('Enter') -> waitForLoadState
      await element.type(value, { delay: 50 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
      await page.waitForTimeout(500);

      const verified = await verifyDropdownFilled(page, element, value);
      if (verified) {
        return { success: true, method: 'type-enter', attempt };
      }

      // Check if input value itself matched
      const currentVal = await element.inputValue().catch(() => '');
      if (currentVal && fuzzyScore(value, currentVal) >= 0.3) {
        return { success: true, method: 'type-enter-val', attempt };
      }

      // If Enter alone did not confirm, fall back to matching popup option and clicking
      let bestMatch = null;
      let bestScore = 0;

      for (const optSel of OPTION_SELECTORS) {
        const options = await page.$$(optSel);
        if (options.length === 0) continue;

        for (const opt of options) {
          const isVisible = await opt.isVisible().catch(() => false);
          if (!isVisible) continue;
          const text = await opt.textContent().catch(() => '');
          const trimmed = text.trim();
          if (!trimmed || trimmed === 'No options') continue;

          const score = fuzzyScore(value, trimmed);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = opt;
          }
        }
        if (bestMatch && bestScore >= 0.5) break;
      }

      if (bestMatch && bestScore >= 0.3) {
        await bestMatch.click();
        await page.waitForTimeout(500);
        try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}

        const optVerified = await verifyDropdownFilled(page, element, value);
        if (optVerified) {
          return { success: true, method: 'type-filter-click', score: bestScore, attempt };
        }
      }
    } catch (err) {
      if (attempt < 3) {
        console.log(`    ↻ Error attempt ${attempt}/3: ${err.message?.substring(0, 60)}`);
      }
    }
  }
  }

  // Strategy 3: Click to open + scan all options (non-searchable dropdowns)
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await element.scrollIntoViewIfNeeded();
    await element.click();
    await page.waitForTimeout(1000);

    const allOptions = await page.$$(OPTION_SELECTORS.join(', '));
    let bestMatch = null;
    let bestScore = 0;

    for (const opt of allOptions) {
      const isVisible = await opt.isVisible().catch(() => false);
      if (!isVisible) continue;
      const text = await opt.textContent().catch(() => '');
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 100) continue;
      const score = fuzzyScore(value, trimmed);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = opt;
      }
    }

    if (bestMatch && bestScore >= 0.3) {
      await bestMatch.click();
      await page.waitForTimeout(600);
      const verified = await verifyDropdownFilled(page, element, value);
      return { success: verified, method: verified ? 'click-scan' : 'click-scan-unverified', score: bestScore };
    }
  } catch { /* click-scan failed */ }

  // Strategy 4: Keyboard navigation
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await element.click();
    await page.waitForTimeout(300);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(80);
      const active = await page.$('.select__option--is-focused, [role="option"][aria-selected="true"], .option.highlighted');
      if (active) {
        const text = await active.textContent().catch(() => '');
        if (fuzzyScore(value, text.trim()) >= 0.5) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
          const verified = await verifyDropdownFilled(page, element, value);
          return { success: verified, method: 'keyboard-nav' };
        }
      }
    }
  } catch { /* keyboard nav failed */ }

  return { success: false, method: 'all-strategies-failed' };
}

// ─── Verify a dropdown actually has a value ─────────────────────────────────
export async function verifyDropdownFilled(page, element, expectedValue) {
  // Method 1: React Select — check for .select__single-value
  try {
    const container = await element.evaluateHandle(el => {
      return el.closest('[class*="container"]') || el.closest('.select') || el.closest('.field');
    });
    if (container) {
      const singleValue = await container.$('.select__single-value, [class*="singleValue"]');
      if (singleValue) {
        const text = await singleValue.textContent().catch(() => '');
        if (text && text.trim() !== '' && text.trim() !== 'Select...') return true;
      }
      const multiValues = await container.$$('.select__multi-value, [class*="multiValue"]');
      if (multiValues && multiValues.length > 0) return true;
      const placeholder = await container.$('.select__placeholder');
      if (!placeholder) return true;
      const placeholderVisible = await placeholder.isVisible().catch(() => true);
      if (!placeholderVisible) return true;
    }
  } catch { /* container check failed */ }

  // Method 2: Check input value
  try {
    const val = await element.inputValue();
    if (val && val.trim() !== '' && val !== 'Select...' && val !== 'Select') return true;
  } catch { /* not an input */ }

  // Method 3: Check aria-expanded
  try {
    const expanded = await element.getAttribute('aria-expanded');
    const hasDescendant = await element.getAttribute('aria-activedescendant');
    if (expanded === 'false' && hasDescendant) return true;
  } catch {}

  return false;
}
