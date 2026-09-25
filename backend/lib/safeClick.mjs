/**
 * safeClick.mjs — Script-only Playwright clicks.
 *
 * Policy (mandatory-only apply):
 * - Fill / click ONLY required fields and scripted handlers.
 * - Never click optional / unimportant fields, questions, or junk chrome.
 * - Never click bare "Add", Certifications Adds, Help, Share, Save for Later, etc.
 * - Allowed navigation: Save and Continue / Next / Submit / Sign In (elsewhere).
 */

import { isForbiddenOptionalAddName, OPTIONAL_SECTION_PATTERN } from './workdayOptionalSections.mjs';

/** Buttons that are never safe as a generic "click first matching button" target. */
const RISKY_NAME_RE = /^(add|\+|add\s+another|add\s+a\s+new|create|delete|remove|edit|clear|cancel|close|×|x|help|share|print|feedback|preview|skip|back|save\s*for\s*later|withdraw|start\s*over)$/i;

/** Page chrome / marketing / optional actions — never scripted. */
const CHROME_BLOCK_RE = /\b(help|support|feedback|share|print|download|preview|save\s*for\s*later|withdraw|start\s*over|view\s*job|return\s*to\s*job|linkedin|facebook|twitter|instagram|cookie|privacy\s*policy|terms\s*of\s*use)\b/i;

/** Allow only these named section Adds (My Experience required rows). */
const ALLOWED_SECTION_ADD_RE = /^add(\s+(another|a|an|new))?\s*(work\s*)?experience$|^add(\s+(another|a|an|new))?\s*education$/i;

/** Wizard footer / navigation that is intentionally clickable elsewhere. */
const NAV_ALLOW_RE = /^(save\s*(and|&)\s*continue|next|continue|submit(\s+application)?|review\s*(and|&)\s*submit|sign\s*in|create\s*account|apply(\s+manually)?|continue\s*application)$/i;

/**
 * Normalize accessible button text for comparisons.
 * @param {string} name
 * @returns {string}
 */
export function normalizeButtonName(name = '') {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/**
 * True when this label looks like an Add / junk / chrome control that must not be
 * clicked during dropdown fills or generic button searches.
 * @param {string} name
 * @param {{allowSectionAdd?: boolean}} [opts]
 * @returns {boolean}
 */
export function isRiskyMisclickButton(name = '', opts = {}) {
  const text = normalizeButtonName(name);
  if (!text) return false;
  if (NAV_ALLOW_RE.test(text)) return false;
  if (opts.allowSectionAdd && ALLOWED_SECTION_ADD_RE.test(text)) return false;
  if (isForbiddenOptionalAddName(text)) return true;
  if (RISKY_NAME_RE.test(text)) return true;
  if (CHROME_BLOCK_RE.test(text) && !NAV_ALLOW_RE.test(text)) return true;
  if (/^add\b/i.test(text) && !ALLOWED_SECTION_ADD_RE.test(text)) return true;
  return false;
}

/**
 * Read a locator's best accessible name (aria-label, text, title, automation id).
 * @param {import('playwright').Locator} locator
 * @returns {Promise<string>}
 */
export async function readButtonName(locator) {
  if (!locator) return '';
  return await locator.evaluate((el) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    return [
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.textContent || '',
      el.getAttribute?.('data-automation-id') || '',
    ].map(norm).filter(Boolean).join(' | ');
  }).catch(() => '');
}

/**
 * @param {import('playwright').Locator} locator
 * @param {{allowSectionAdd?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isLocatorRiskyMisclick(locator, opts = {}) {
  if (!locator) return true;
  const name = await readButtonName(locator);
  if (isRiskyMisclickButton(name, opts)) return true;
  // Also blocked if previously disarmed
  const blocked = await locator.getAttribute('data-wd-optional-add-blocked').catch(() => null);
  if (blocked === '1') return true;
  const scriptBlocked = await locator.getAttribute('data-wd-script-block').catch(() => null);
  if (scriptBlocked === '1') return true;
  return false;
}

/**
 * Click only when the target is not an Add / junk misclick button.
 * @param {import('playwright').Locator} locator
 * @param {object} [clickOpts] Playwright click options
 * @param {{allowSectionAdd?: boolean, label?: string}} [guard]
 * @returns {Promise<boolean>} true if clicked
 */
export async function safeClick(locator, clickOpts = {}, guard = {}) {
  if (!locator) return false;
  if (await isLocatorRiskyMisclick(locator, guard)) {
    const name = await readButtonName(locator);
    console.log(`    🚫 Script-only: skipped non-required button "${String(name).slice(0, 60)}"`);
    return false;
  }
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true, ...clickOpts }).catch(async () => {
    await locator.evaluate((el) => el.click()).catch(() => {});
  });
  return true;
}

/**
 * Browser-side guard: cancel clicks on optional Adds + page chrome that the
 * apply script never intends to use. Install once per page / navigation.
 * @param {import('playwright').Page} page
 */
export async function installScriptOnlyClickGuard(page) {
  const guard = ({ optionalPattern }) => {
    if (window.__wdScriptOnlyGuardInstalled) return;
    window.__wdScriptOnlyGuardInstalled = true;
    window.__wdBlockedScriptClicks = [];

    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const optionalRe = new RegExp(optionalPattern, 'i');
    const optionalWordRe = /certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social\s*(network|media)|volunteer|credential|website/i;
    const addRe = /^(\+\s*)?add\b|^add(\s+(another|a|an|new))?\b/i;
    const allowedAddRe = /^add(\s+(another|a|an|new))?\s*(work\s*)?experience$|^add(\s+(another|a|an|new))?\s*education$/i;
    const navAllowRe = /^(save\s*(and|&)\s*continue|next|continue|submit(\s+application)?|review\s*(and|&)\s*submit|sign\s*in|create\s*account|apply(\s+manually)?|continue\s*application)$/i;
    const chromeRe = /\b(help|support|feedback|share|print|download|preview|save\s*for\s*later|withdraw|start\s*over|view\s*job|return\s*to\s*job|cookie)\b/i;
    const headingSelector = 'h1,h2,h3,h4,h5,legend,[data-automation-id*="title"],[data-automation-id*="heading"],[data-automation-id="panelTitle"]';

    const nearestHeading = (el) => {
      let nearest = '';
      for (const h of document.querySelectorAll(headingSelector)) {
        const text = norm(h.textContent);
        if (!text || text.length > 60) continue;
        if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) nearest = text;
      }
      return nearest;
    };

    // Must be normalized *after* joining: a blank aria-label would otherwise leave a
    // leading space and break every `^add` test below.
    const buttonName = (btn) => norm([
      btn.getAttribute('aria-label') || '',
      btn.textContent || '',
      btn.getAttribute('title') || '',
    ].map(norm).filter(Boolean).join(' '));

    const shouldBlock = (el) => {
      const btn = el.closest?.('button, [role="button"], a[role="button"]');
      if (!btn) return null;
      const name = buttonName(btn);
      const auto = btn.getAttribute('data-automation-id') || '';
      if (navAllowRe.test(name)) return null;
      if (chromeRe.test(name)) return name || 'chrome';
      if (allowedAddRe.test(name)) return null;

      const isAdd = addRe.test(name) || /^add$/i.test(auto);
      if (!isAdd) return null;

      if (optionalWordRe.test(name)) return name || 'Add';
      for (let node = btn, depth = 0; node && depth < 25; node = node.parentElement, depth++) {
        const nodeAuto = node.getAttribute?.('data-automation-id') || '';
        if (optionalWordRe.test(nodeAuto)) return name || nodeAuto;
        if (/workExperience|work-experience|education/i.test(nodeAuto) && !optionalWordRe.test(nodeAuto)) {
          return null;
        }
      }
      const heading = nearestHeading(btn);
      if (/work\s*experience|^education\b/i.test(heading)) return null;
      if (optionalRe.test(heading)) return `${name || 'Add'} (${heading})`;
      // Default-deny: an Add with no Work Experience / Education context is never
      // something the script needs, whatever it is called.
      return `${name || 'Add'}${heading ? ` (${heading})` : ''}`;
    };

    const block = (event) => {
      // Escape hatch for the operator: run `window.__wdAllowAddClicks = true` in
      // devtools to add a row by hand in the headed browser.
      if (window.__wdAllowAddClicks === true) return;
      const blocked = shouldBlock(event.target);
      if (!blocked) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__wdBlockedScriptClicks.push(blocked);
    };

    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, block, true);
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') block(event);
    }, true);
  };

  await page.addInitScript(guard, { optionalPattern: OPTIONAL_SECTION_PATTERN }).catch(() => {});
  await page.evaluate(guard, { optionalPattern: OPTIONAL_SECTION_PATTERN }).catch(() => {});
}

/**
 * Names of the clicks the browser guard refused since the last call (audit only).
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
export async function drainBlockedScriptClicks(page) {
  return await page.evaluate(() => {
    const list = window.__wdBlockedScriptClicks || [];
    window.__wdBlockedScriptClicks = [];
    return list;
  }).catch(() => []);
}

/**
 * Mark ALL risky Add / chrome buttons on the page. Call before fills on every wizard step.
 * @param {import('playwright').Page} page
 * @returns {Promise<number>}
 */
export async function disarmRiskyAddButtons(page) {
  return await page.evaluate(({ optionalPattern }) => {
    const optionalRe = new RegExp(optionalPattern, 'i');
    const allowedAddRe = /^add(\s+(another|a|an|new))?\s*(work\s*)?experience$|^add(\s+(another|a|an|new))?\s*education$/i;
    const forbiddenNameRe = /add(\s+(another|a|an|new))?\s*(certificat|licen[cs]|language|award|honor|publication|patent|affiliation|membership|reference|social|volunteer|credential|websites?)/i;
    const bareAddRe = /^(add|\+|add\s+another)$/i;
    const chromeRe = /\b(help|support|feedback|share|print|download|preview|save\s*for\s*later|withdraw|start\s*over)\b/i;
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
      const aria = norm(btn.getAttribute('aria-label'));
      const text = norm(btn.textContent);
      const title = norm(btn.getAttribute('title'));
      const auto = btn.getAttribute('data-automation-id') || '';
      const name = [aria, text, title, auto].filter(Boolean).join(' ');

      if (chromeRe.test(name)) {
        btn.setAttribute('data-wd-script-block', '1');
        btn.setAttribute('data-wd-optional-add-blocked', '1');
        btn.setAttribute('aria-disabled', 'true');
        btn.style.pointerEvents = 'none';
        blocked++;
        continue;
      }

      const isAddShaped = bareAddRe.test(text)
        || bareAddRe.test(aria)
        || auto === 'Add'
        || /^add\b/i.test(name)
        || forbiddenNameRe.test(name);

      if (!isAddShaped) continue;

      // Explicit work/education Add is allowed — leave unblocked.
      if (allowedAddRe.test(text) || allowedAddRe.test(aria)) continue;

      const heading = nearestHeading(btn);
      const underWorkEdu = /work\s*experience|^education\b/i.test(heading);
      const underOptional = optionalRe.test(heading);

      // Bare Add under Work/Education stays available for section expand.
      if (underWorkEdu && !underOptional && !forbiddenNameRe.test(name) && (bareAddRe.test(text) || bareAddRe.test(aria) || auto === 'Add')) {
        continue;
      }

      // Everything else (Certifications Add, Add Another Language, orphan bare Add, …)
      btn.setAttribute('data-wd-optional-add-blocked', '1');
      btn.setAttribute('data-wd-script-block', '1');
      btn.setAttribute('aria-disabled', 'true');
      btn.style.pointerEvents = 'none';
      blocked++;
    }
    return blocked;
  }, { optionalPattern: OPTIONAL_SECTION_PATTERN }).catch(() => 0);
}
