/**
 * workdayOptionalSections.mjs — My Experience optional sections (Certifications,
 * Languages, Awards, Publications, Affiliations, References, Social Networks).
 *
 * Rules:
 * - Never click "Add" / "Add Another" for these sections.
 * - Never click anything at all in an optional section unless it blocks the step:
 *   a pre-rendered empty row is only deleted when it carries a required marker or
 *   a live validation error.
 * - Rows that already contain data (e.g. parsed from the resume) are left alone.
 */

/** Section headings Workday renders on My Experience that are never mandatory. */
export const OPTIONAL_EXPERIENCE_SECTIONS = [
  { name: 'Certifications', pattern: 'certificat|licens(e|ure|ing)|credential' },
  { name: 'Languages', pattern: '^languages?\\b|language proficiency' },
  { name: 'Awards', pattern: '^(awards?|honors?|achievements?)\\b' },
  { name: 'Publications', pattern: '^(publications?|patents?|presentations?)\\b' },
  { name: 'Affiliations', pattern: 'professional (affiliation|membership|organization)|memberships?' },
  { name: 'References', pattern: '^references?\\b' },
  { name: 'Social Networks', pattern: 'social (network|media)' },
  { name: 'Volunteer', pattern: '^volunteer' },
];

/** Single regex source matching any optional section heading. */
export const OPTIONAL_SECTION_PATTERN = OPTIONAL_EXPERIENCE_SECTIONS
  .map((s) => `(?:${s.pattern})`)
  .join('|');

/**
 * True when a button's accessible name / label is an optional-section Add control
 * (e.g. "Add Certificate", "Add Another Language").
 * @param {string} name
 * @returns {boolean}
 */
export function isForbiddenOptionalAddName(name = '') {
  const text = String(name || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  // Any Add that names an optional section — including "Add", "+ Add", "Add Another"
  // when the accessible name also mentions the section type.
  if (/add(\s+(another|a|an|new))?\s*(certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social|volunteer|credential|websites?)/i
    .test(text)) {
    return true;
  }
  // Bare "+" / "Add" alone is handled by heading/scope checks — not forbidden by name alone.
  return false;
}

/**
 * Hard deny-list: never click these Add controls on My Experience.
 * @param {import('playwright').Page} page
 * @returns {Promise<number>} how many buttons were marked blocked
 */
export async function disarmOptionalAddButtons(page) {
  return await page.evaluate((optionalPattern) => {
    const optionalRe = new RegExp(optionalPattern, 'i');
    const forbiddenNameRe = /add(\s+(another|a|an|new))?\s*(certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social|volunteer|credential|websites?)/i;
    const headingSelector = 'h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"],[data-automation-id="panelTitle"]';
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    let blocked = 0;

    const nearestHeading = (el) => {
      let nearest = '';
      for (const h of document.querySelectorAll(headingSelector)) {
        const text = norm(h.textContent);
        if (!text || text.length > 60) continue;
        if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          nearest = text;
        }
      }
      return nearest;
    };

    for (const btn of document.querySelectorAll('button, [role="button"], a[role="button"]')) {
      const name = [
        btn.getAttribute('aria-label') || '',
        btn.textContent || '',
        btn.getAttribute('title') || '',
        btn.getAttribute('data-automation-id') || '',
      ].map(norm).join(' ');

      const isAdd = /^(add|\+)$/i.test(norm(btn.textContent))
        || /^(add|\+)$/i.test(norm(btn.getAttribute('aria-label') || ''))
        || (btn.getAttribute('data-automation-id') || '') === 'Add'
        || forbiddenNameRe.test(name)
        || /^add\b/i.test(name);

      if (!isAdd) continue;

      if (forbiddenNameRe.test(name)) {
        btn.setAttribute('data-wd-optional-add-blocked', '1');
        blocked++;
        continue;
      }

      const heading = nearestHeading(btn);
      if (optionalRe.test(heading)) {
        btn.setAttribute('data-wd-optional-add-blocked', '1');
        blocked++;
        continue;
      }

      let node = btn;
      for (let d = 0; d < 20 && node; d++) {
        const auto = (node.getAttribute?.('data-automation-id') || '');
        if (/certificat|licen[cs]|language|award|publication|affiliation|reference|socialNetwork|volunteer/i.test(auto)) {
          btn.setAttribute('data-wd-optional-add-blocked', '1');
          blocked++;
          break;
        }
        node = node.parentElement;
      }
    }
    return blocked;
  }, OPTIONAL_SECTION_PATTERN).catch(() => 0);
}

/**
 * True when a control (e.g. an "Add" button) sits inside an optional section.
 * Uses button name first, then nearest preceding heading (not any ancestor subtree).
 * @param {import('playwright').Locator} locator
 * @returns {Promise<boolean>}
 */
export async function isOptionalSectionControl(locator) {
  if (!locator) return false;
  return await locator.evaluate((el, optionalPattern) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const optionalRe = new RegExp(optionalPattern, 'i');
    const headingSelector = 'h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"],[data-automation-id="panelTitle"]';

    const ownName = [
      el.getAttribute?.('aria-label') || '',
      el.textContent || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('data-automation-id') || '',
    ].map(norm).join(' ');

    if (/add(\s+(another|a|an|new))?\s*(certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social|volunteer|credential|websites?)/i
      .test(ownName)) {
      return true;
    }

    // Walk ancestors for explicit automation ids before falling back to headings.
    let node = el;
    for (let depth = 0; depth < 25 && node; depth++) {
      const auto = (node.getAttribute?.('data-automation-id') || '');
      if (/certificat|licen[cs]|language|award|publication|affiliation|reference|socialNetwork|volunteer/i.test(auto)) {
        return true;
      }
      // Narrow section containers only — not a page-level workExperience wrapper.
      if (/workExperienceSection|work-experience-section|workExperiencePanelSet/i.test(auto)
        && !/certificat|language|award/i.test(auto)) {
        return false;
      }
      if (/educationSection|educationPanelSet/i.test(auto)
        && !/certificat|language|award/i.test(auto)) {
        return false;
      }
      node = node.parentElement;
    }

    let nearest = '';
    for (const h of document.querySelectorAll(headingSelector)) {
      const text = norm(h.textContent);
      if (!text || text.length > 60) continue;
      if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        nearest = text;
      }
    }
    if (!nearest) return false;
    if (optionalRe.test(nearest)) return true;
    if (/work\s*experience|^education\b/i.test(nearest)) return false;
    return false;
  }, OPTIONAL_SECTION_PATTERN).catch(() => false);
}

/**
 * Find optional sections on the current page and mark their delete buttons.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{name: string, heading: string, hasData: boolean, blocking: boolean, deleteId: string|null}>>}
 */
async function inspectOptionalSections(page) {
  return await page.evaluate(({ sections }) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-wd-optional-delete]').forEach((el) => el.removeAttribute('data-wd-optional-delete'));

    const matchers = sections.map((s) => ({ name: s.name, re: new RegExp(s.pattern, 'i') }));
    const headingSelector = 'h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"],[data-automation-id="panelTitle"]';
    const out = [];
    const seenRoots = new Set();

    for (const headingEl of document.querySelectorAll(headingSelector)) {
      const heading = norm(headingEl.textContent);
      if (!heading || heading.length > 60) continue;
      const match = matchers.find((m) => m.re.test(heading));
      if (!match) continue;

      const root = headingEl.closest(
        '[data-automation-id*="panelSet"], [data-automation-id*="panel-set"], [data-automation-id*="Panel"], [data-automation-id*="panel"], [data-automation-id*="section"], [data-automation-id*="Section"], fieldset, [role="group"]'
      ) || headingEl.parentElement?.parentElement;
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);

      const controls = Array.from(root.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
      )).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

      const hasData = controls.some((el) => norm(el.value))
        || Array.from(root.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id*="pill"]'))
          .some((el) => norm(el.textContent));

      // The row only blocks Save and Continue when Workday marks one of its empty
      // controls required, or when it already shows a validation error.
      const hasError = Array.from(root.querySelectorAll('[data-automation-id*="errorMessage"], [role="alert"]'))
        .some((el) => /required|error|select|enter/i.test(norm(el.textContent)));
      const hasRequiredEmptyControl = controls.some((el) => {
        if (norm(el.value)) return false;
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
        const field = el.closest('[data-automation-id*="formField"]') || el.parentElement?.parentElement;
        if (!field) return false;
        if (field.querySelector('abbr[title*="required" i], [data-automation-id*="required" i]')) return true;
        const labelText = norm(Array.from(field.querySelectorAll('label, [data-automation-id*="label"]'))
          .map((l) => l.textContent).join(' '));
        return /\*\s*$/.test(labelText) || /\(required\)/i.test(labelText);
      });
      const blocking = !hasData && (hasError || hasRequiredEmptyControl);

      // A protected section (work experience / education / websites) must never
      // be deleted, so the row the button belongs to is re-checked from the button up.
      const protectedRe = /work\s*experience|^education|job\s*title|school\s*or\s*university|websites?/i;
      const belongsToOptionalRow = (btn) => {
        // Start above the button — Workday's own delete button carries
        // data-automation-id="panel-set-delete-button", which closest() would self-match.
        const rowRoot = (btn.parentElement || btn).closest(
          '[data-automation-id*="panelSet"], [data-automation-id*="panel-set"], [data-automation-id*="Panel"], [data-automation-id*="panel"], fieldset, [role="group"]'
        ) || root;
        const rowHeadings = Array.from(rowRoot.querySelectorAll(headingSelector))
          .map((h) => norm(h.textContent))
          .filter((t) => t && t.length <= 60);
        const rowLabels = Array.from(rowRoot.querySelectorAll('label, legend, [data-automation-id*="label"]'))
          .map((l) => norm(l.textContent));
        if ([...rowHeadings, ...rowLabels].some((t) => protectedRe.test(t))) return false;
        return rowHeadings.some((t) => matchers.some((m) => m.re.test(t)));
      };

      const deleteBtn = Array.from(root.querySelectorAll('button, [role="button"]')).find((btn) => {
        const text = norm(btn.textContent);
        const auto = btn.getAttribute('data-automation-id') || '';
        const aria = norm(btn.getAttribute('aria-label') || '');
        const isDelete = /^(delete|remove)$/i.test(text) || /delete|remove/i.test(auto) || /^(delete|remove)\b/i.test(aria);
        return isDelete && belongsToOptionalRow(btn);
      });

      let deleteId = null;
      if (deleteBtn && controls.length > 0) {
        deleteId = `wd-opt-${Math.random().toString(36).slice(2, 8)}`;
        deleteBtn.setAttribute('data-wd-optional-delete', deleteId);
      }

      out.push({ name: match.name, heading, hasData, blocking, deleteId, controlCount: controls.length });
    }

    return out;
  }, { sections: OPTIONAL_EXPERIENCE_SECTIONS });
}

/**
 * Skip every optional My Experience section: no Add clicks, and no clicks at all
 * unless an empty row is actually blocking the step.
 * @param {import('playwright').Page} page
 * @param {object} [profile] set `_fillOptionalFields = true` to disable skipping
 * @param {{force?: boolean}} [options] `force: true` deletes every empty optional row
 *   (used only after Workday refuses to advance the step)
 * @returns {Promise<{skipped: string[], removed: string[]}>}
 */
export async function skipOptionalExperienceSections(page, profile = {}, options = {}) {
  const result = { skipped: [], removed: [] };
  if (profile?._fillOptionalFields === true) return result;

  // Prefer the broader disarm (Certifications + orphan bare Add).
  try {
    const { disarmRiskyAddButtons } = await import('./safeClick.mjs');
    const blockedAdds = await disarmRiskyAddButtons(page);
    if (blockedAdds > 0) {
      console.log(`    🚫 Blocked ${blockedAdds} optional/risky Add button(s) (Certifications/Languages/etc.)`);
    }
  } catch {
    const blockedAdds = await disarmOptionalAddButtons(page);
    if (blockedAdds > 0) {
      console.log(`    🚫 Blocked ${blockedAdds} optional Add button(s) (Certifications/Languages/etc.)`);
    }
  }

  const force = options?.force === true;
  let previousEmptyRows = null;

  for (let pass = 0; pass < 6; pass++) {
    const sections = await inspectOptionalSections(page).catch(() => []);
    if (!sections.length) break;

    for (const section of sections) {
      if (!result.skipped.includes(section.name)) result.skipped.push(section.name);
    }

    const emptyRows = sections.filter((s) => s.deleteId && !s.hasData && (force || s.blocking));
    // Stop as soon as a delete click stops removing rows (renumbered rows still shrink the count).
    if (previousEmptyRows !== null && emptyRows.length >= previousEmptyRows) break;
    previousEmptyRows = emptyRows.length;

    const target = emptyRows[0];
    if (!target) break;

    const deleteBtn = page.locator(`[data-wd-optional-delete="${target.deleteId}"]`).first();
    if (!(await deleteBtn.isVisible({ timeout: 500 }).catch(() => false))) break;
    await deleteBtn.scrollIntoViewIfNeeded().catch(() => {});
    await deleteBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    result.removed.push(target.heading);
  }

  if (result.skipped.length) {
    console.log(`    ⏭️  Optional sections left untouched (no Add): ${result.skipped.join(', ')}`);
  }
  if (result.removed.length) {
    console.log(`    🗑️  Removed blocking empty optional row(s): ${result.removed.join(', ')}`);
  }
  return result;
}
