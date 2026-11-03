/**
 * scanner.mjs — Production-grade Workday form scanner engine.
 *
 * Responsibilities:
 *  1. Expose helper utilities: slugify, isSubmitButton, detectControlType.
 *  2. discoverFields(page) — thin wrapper over discoverFormFieldQuestions.
 *  3. scanJobLink(page, jobUrl, bypassProfile, opts) — navigate from start to
 *     Review & Submit, filling bypass answers, recording all questions as
 *     structured JSON for storage in scanned_jobs.form_schema.
 *
 * Removed (replaced by scanJobLink):
 *  - scanForm()           — wrote to local disk; replaced by scanJobLink
 *  - writeFile / mkdir    — no local file storage permitted (Zero Screenshots policy)
 *  - handleWorkday import — not scanner's responsibility
 */

import { normalizeLabel } from './qaStore.mjs';
import {
  discoverFormFieldQuestions,
  scanPageForNewFields,
  waitForDomSettled,
} from './workdayDom.mjs';

// ─── Submit button patterns ───────────────────────────────────────────────────

const SUBMIT_PATTERNS = [
  /submit\s*application/i,
  /^submit$/i,
  /send\s*application/i,
  /apply\s*now/i,
  /complete\s*application/i,
];

/**
 * Returns true when a button text matches known "final submit" patterns.
 * Used to avoid accidentally clicking submit during scan bypass traversal.
 * @param {string} text
 */
export function isSubmitButton(text) {
  return SUBMIT_PATTERNS.some((p) => p.test((text || '').trim()));
}

// ─── URL slug helper ──────────────────────────────────────────────────────────

/**
 * Derive a short, filesystem-safe slug from a job URL.
 * Used as a key for deduplication in scanned_jobs.
 * @param {string} url
 * @returns {string}
 */
export function slugify(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname
      .replace(/^(boards|job-boards|jobs|careers)\./, '')
      .replace(/\..+$/, '');

    const skipParts = new Set([
      'jobs', 'embed', 'job_app', 'us', 'en', 'apply', 'job',
      'careers', 'career', 'position', 'posting',
    ]);
    const isJobId = (p) =>
      /^\d+$/.test(p) ||
      /^[A-Z]\d{4,}/.test(p) ||
      /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}/.test(p);

    const jobId =
      parts.find((p) => isJobId(p)) ||
      parts[parts.length - 1] ||
      u.searchParams.get('token') ||
      '';
    const company =
      parts.find((p) => !skipParts.has(p.toLowerCase()) && !isJobId(p)) || host;

    const slug = `${company}-${jobId}`
      .replace(/[^a-z0-9-]/gi, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
    return slug === '-' ? host : slug;
  } catch {
    return 'unknown-form';
  }
}

// ─── detectControlType (field-object classifier, no DOM access) ───────────────

/**
 * Classify a scanned field object (or DOM element) into a control-type string.
 * Returns: 'native-select' | 'custom-dropdown' | 'checkbox-group' | 'radio-group' |
 *          'date-picker' | 'spinbutton' | 'tag-input' | 'file' | 'free-text'
 *
 * Works on plain JS objects (scanner output) — no live DOM required.
 * @param {object} elOrField
 */
export function detectControlType(elOrField = {}) {
  if (!elOrField) return 'free-text';

  // Respect previously tagged controlType
  if (elOrField.controlType) return elOrField.controlType;

  const tag = String(elOrField.tagName || elOrField.tag || '').toLowerCase();
  const role = String(
    elOrField.role ||
    (typeof elOrField.getAttribute === 'function'
      ? elOrField.getAttribute('role')
      : '') ||
    '',
  ).toLowerCase();
  const autoId = String(
    elOrField.automationId ||
    elOrField.dataAutomationId ||
    (typeof elOrField.getAttribute === 'function'
      ? elOrField.getAttribute('data-automation-id')
      : '') ||
    '',
  ).toLowerCase();
  const ariaHasPopup = String(
    (typeof elOrField.getAttribute === 'function'
      ? elOrField.getAttribute('aria-haspopup')
      : elOrField.ariaHasPopup) || '',
  ).toLowerCase();
  const placeholder = String(
    elOrField.placeholder ||
    (typeof elOrField.getAttribute === 'function'
      ? elOrField.getAttribute('placeholder')
      : '') ||
    '',
  ).toLowerCase();
  const type = String(
    elOrField.type ||
    elOrField.inputType ||
    elOrField.fieldType ||
    (typeof elOrField.getAttribute === 'function'
      ? elOrField.getAttribute('type')
      : '') ||
    '',
  ).toLowerCase();

  // tag-input (Workday multi-select widget)
  if (
    autoId.includes('multiselect') ||
    type === 'tag-input' ||
    type.includes('tag-input')
  )
    return 'tag-input';

  // file upload
  if (type === 'file') return 'file';

  // native-select
  if (tag === 'select' || type === 'select-one') return 'native-select';

  // custom-dropdown (combobox / listbox / Workday selectWidget)
  if (
    role === 'combobox' ||
    role === 'listbox' ||
    ariaHasPopup === 'listbox' ||
    ariaHasPopup === 'true' ||
    autoId.includes('selectwidget') ||
    autoId.includes('selectone') ||
    autoId.includes('select-widget') ||
    autoId.includes('select-one') ||
    autoId.includes('prompt') ||
    type === 'dropdown' ||
    type === 'combobox'
  )
    return 'custom-dropdown';

  // checkbox-group
  if (
    role === 'checkbox' ||
    type === 'checkbox' ||
    type === 'checkbox-group'
  )
    return 'checkbox-group';

  // radio-group
  if (
    role === 'radio' ||
    role === 'radiogroup' ||
    type === 'radio' ||
    type === 'radio-group'
  )
    return 'radio-group';

  // spinbutton
  if (role === 'spinbutton' || type === 'spinbutton') return 'spinbutton';

  // date-picker
  const isDatePlaceholder =
    /(mm\/dd\/yyyy|dd\/mm\/yyyy|yyyy\/mm\/dd|mm\/yyyy|dd-mm-yyyy|mm-dd-yyyy|\bmm\b.*\byyyy\b)/i.test(
      placeholder,
    );
  const isDateAutoId = autoId.includes('date') || autoId.includes('datesection');
  if (type === 'date' || isDatePlaceholder || isDateAutoId) return 'date-picker';

  return 'free-text';
}

// ─── discoverFields — thin wrapper for backward compatibility ─────────────────

/**
 * Discover all visible form fields on the current page.
 * Delegates to discoverFormFieldQuestions (workdayDom.mjs).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
export async function discoverFields(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  return discoverFormFieldQuestions(page).catch(() => []);
}

// ─── Bypass fill helpers ──────────────────────────────────────────────────────

/**
 * Attempt to fill a single field with a bypass answer during scan traversal.
 * Rules follow the bypass spec:
 *  - text/textarea    → "NA"
 *  - dropdown/combobox → first "No" option, else first option
 *  - radio            → option labeled "No", else first option
 *  - checkbox         → check it
 *  - spinbutton       → set "1" + Enter
 *  - file             → skip
 *  - tag-input        → type "NA" + Enter
 *
 * After every fill: press Enter, then scan for newly appeared sub-fields.
 *
 * @param {import('playwright').Page} page
 * @param {object} field — standard field object from discoverFormFieldQuestions
 * @param {object} [profile] — bypassProfile key-value overrides
 * @returns {Promise<string>} — the bypass answer that was filled (or '' if skipped)
 */
async function fillBypassField(page, field, profile = {}) {
  const { fieldType, label, automationId, selector, options = [], required = false } = field;

  // Profile override wins (caller can supply exact answers)
  const profileVal = profile[normalizeLabel(label)] || profile[label] || '';

  try {
    if (fieldType === 'file') {
      // Never upload files during scanning
      return '';
    }

    // Skip optional tag-inputs completely (only fill required tags)
    if (fieldType === 'tag-input' && !required) {
      return '';
    }

    if (fieldType === 'text' || fieldType === 'textarea') {
      const answer = profileVal || 'NE';
      const locator = automationId
        ? page.locator(`[data-automation-id="${automationId}"] input, [data-automation-id="${automationId}"] textarea`).first()
        : selector
          ? page.locator(`${selector} input, ${selector} textarea, ${selector}`).first()
          : null;
      if (!locator) return '';
      await locator.fill(answer).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
      return answer;
    }

    if (fieldType === 'dropdown' || fieldType === 'combobox') {
      // Locate the trigger button
      const triggerSel = automationId
        ? `[data-automation-id="${automationId}"] button[aria-haspopup="listbox"], [data-automation-id="${automationId}"] [role="combobox"], [data-automation-id="${automationId}"]`
        : selector;
      if (!triggerSel) return '';

      const trigger = page.locator(triggerSel).first();
      const count = await trigger.count().catch(() => 0);
      if (!count) return '';

      await trigger.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);

      // Collect visible options from open listbox
      const liveOpts = await page
        .evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll(
            '[role="option"], [data-automation-id="promptOption"]',
          )) {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && text.length < 120) out.push(text);
          }
          return out;
        })
        .catch(() => []);

      const allOpts = liveOpts.length > 0 ? liveOpts : options;
      const noOption = allOpts.find((o) => /^no$/i.test(o.trim())) || allOpts.find((o) => /\bno\b/i.test(o.trim()));
      const chosen = profileVal || noOption || allOpts[0] || 'No';

      // Click the matching option or first option
      const clicked = await page
        .evaluate((targetText) => {
          const els = document.querySelectorAll(
            '[role="option"], [data-automation-id="promptOption"]',
          );
          for (const el of els) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.toLowerCase() === targetText.toLowerCase() || (targetText === 'No' && /^no$/i.test(text))) {
              el.click();
              return true;
            }
          }
          if (els[0]) {
            els[0].click();
            return true;
          }
          return false;
        }, chosen)
        .catch(() => false);

      if (!clicked) {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(300);

      // Handle potential nested dropdown (e.g. cascaded prompt)
      const nestedVisible = await page.evaluate(() => {
        const nested = document.querySelector('[role="listbox"]:not([aria-hidden="true"]), [data-automation-id="selectWidget"] [role="listbox"]');
        return Boolean(nested && window.getComputedStyle(nested).display !== 'none');
      }).catch(() => false);

      if (nestedVisible) {
        await page.evaluate(() => {
          const nestedOpt = document.querySelector('[role="option"]:not([aria-hidden="true"])');
          if (nestedOpt) nestedOpt.click();
        }).catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(200);
      }

      return chosen;
    }

    if (fieldType === 'radio') {
      // Find "No" radio or first radio
      const chosen = profileVal || options.find((o) => /^no$/i.test(o)) || options[0] || 'No';

      const clicked = await page
        .evaluate(
          ({ aid, sel, target }) => {
            const containers = aid
              ? [document.querySelector(`[data-automation-id="${aid}"]`)].filter(Boolean)
              : sel
                ? [document.querySelector(sel)].filter(Boolean)
                : [];
            const root = containers[0] || document;
            const radios = Array.from(root.querySelectorAll('input[type="radio"], [role="radio"]'));
            for (const r of radios) {
              const id = r.id;
              const lab = id
                ? root.querySelector(`label[for="${CSS.escape(id)}"]`)
                : r.closest('label');
              const text = (lab?.textContent || r.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
              if (text.toLowerCase() === target.toLowerCase() || (target === 'No' && /^no$/i.test(text))) {
                r.click();
                return true;
              }
            }
            // Fallback: click first radio
            if (radios[0]) { radios[0].click(); return true; }
            return false;
          },
          { aid: automationId || '', sel: selector || '', target: chosen },
        )
        .catch(() => false);

      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
      return clicked ? chosen : '';
    }

    if (fieldType === 'checkbox' || fieldType === 'checkbox-group') {
      // Check the first unchecked checkbox
      await page
        .evaluate(
          ({ aid, sel }) => {
            const root = (aid && document.querySelector(`[data-automation-id="${aid}"]`)) ||
              (sel && document.querySelector(sel)) || document;
            const cb = root.querySelector('input[type="checkbox"]:not(:checked), [role="checkbox"][aria-checked="false"]');
            if (cb) cb.click();
          },
          { aid: automationId || '', sel: selector || '' },
        )
        .catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
      return 'checked';
    }

    if (fieldType === 'spinbutton' || fieldType === 'date') {
      const today = new Date();
      const standardDate = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
      const answer = profileVal || standardDate;
      const spinSel = automationId
        ? `[data-automation-id="${automationId}"] [role="spinbutton"], [data-automation-id="${automationId}"] input`
        : selector
          ? `${selector} [role="spinbutton"], ${selector} input`
          : null;
      if (!spinSel) return '';
      const locator = page.locator(spinSel).first();
      const count = await locator.count().catch(() => 0);
      if (!count) return '';
      await locator.fill(answer).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
      return answer;
    }

    if (fieldType === 'tag-input') {
      const answer = profileVal || 'Engineering';
      const inputSel = automationId
        ? `[data-automation-id="${automationId}"] input`
        : selector
          ? `${selector} input`
          : null;
      if (!inputSel) return '';
      const locator = page.locator(inputSel).first();
      const count = await locator.count().catch(() => 0);
      if (!count) return '';
      await locator.fill(answer).catch(() => {});
      await page.waitForTimeout(300);
      // If prompt appears, click first option
      await page.evaluate(() => {
        const firstOpt = document.querySelector('[role="option"], [data-automation-id="promptOption"]');
        if (firstOpt) firstOpt.click();
      }).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
      return answer;
    }
  } catch (err) {
    // Non-fatal: log and continue scan
    console.warn(`[scanner] fillBypassField skipped "${label}": ${err.message}`);
  }
  return '';
}

/**
 * Check for visible Workday error elements on the current page.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function hasVisibleErrors(page) {
  return page
    .evaluate(() => {
      const errors = document.querySelectorAll('[data-automation-id="error"]');
      for (const el of errors) {
        const s = window.getComputedStyle(el);
        if (s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0)
          return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Attempt to heal a postal code field that showed a Workday validation error.
 * Tries up to 3 alternative codes from resolvePostalCodeViaLlm (if available).
 *
 * @param {import('playwright').Page} page
 * @param {object} field
 * @param {object} profile
 * @returns {Promise<boolean>} — true if healed, false if still failing
 */
async function healPostalCodeError(page, field, profile) {
  let resolvePostalCodeViaLlm;
  try {
    ({ resolvePostalCodeViaLlm } = await import('./openRouterLlm.mjs').catch(
      () => import('./claudeLlm.mjs').catch(() => ({})),
    ));
  } catch {
    return false;
  }
  if (typeof resolvePostalCodeViaLlm !== 'function') return false;

  const country = profile.country || profile.countryCode || 'US';
  const state = profile.state || profile.stateCode || '';
  const city = profile.city || '';

  for (let attempt = 0; attempt < 3; attempt++) {
    const altCode = await resolvePostalCodeViaLlm(country, state, city, attempt).catch(
      () => null,
    );
    if (!altCode) continue;

    const locator = field.automationId
      ? page.locator(`[data-automation-id="${field.automationId}"] input`).first()
      : page.locator(`${field.selector} input`).first();

    await locator.fill(String(altCode)).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(800);

    const stillError = await hasVisibleErrors(page);
    if (!stillError) return true;
  }
  return false;
}

// ─── scanJobLink — main scanner export ───────────────────────────────────────

/**
 * Navigate a job application from start to Review & Submit page,
 * filling bypass answers along the way and recording all questions.
 *
 * @param {import('playwright').Page} page — Playwright page already navigated to the wizard
 * @param {string} jobUrl — original job URL (for metadata)
 * @param {object} [bypassProfile] — optional profile key-value overrides for bypass fills
 * @param {object} [opts]
 * @param {number} [opts.maxPages=12] — safety limit for wizard page count
 * @param {boolean} [opts.skipFill=false] — if true, only scan without filling
 * @returns {Promise<{ questions: object[], pageCount: number, reachedReview: boolean }>}
 */
export async function scanJobLink(
  page,
  jobUrl,
  bypassProfile = {},
  { maxPages = 12, skipFill = false } = {},
) {
  const allQuestions = [];
  let pageCount = 0;
  let reachedReview = false;
  let reviewScreenshotUrl = null;
  let sequence = 0;

  // Keys of fields already seen across all pages (automationId or label-key)
  const globalSeenKeys = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    pageCount = pageNum;
    await waitForDomSettled(page, { timeout: 3000 });

    // Check if we've reached the Review & Submit page
    const onReview = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const hasReviewHeading = Boolean(
          document.querySelector(
            '[data-automation-id="reviewStep"], [data-automation-id="review"], [data-automation-id="applicationReview"]',
          ),
        );
        return (
          hasReviewHeading ||
          /review\s+(&|and)\s+submit|review\s+application|check.*review/i.test(
            bodyText,
          )
        );
      })
      .catch(() => false);

    if (onReview) {
      reachedReview = true;
      console.log(`[scanner] Reached Review & Submit page after ${pageNum - 1} wizard pages.`);
      try {
        const { uploadStorageScreenshot } = await import('./supabaseClient.mjs');
        const buf = await page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
        if (buf && typeof uploadStorageScreenshot === 'function') {
          const fileName = `scan_${slugify(jobUrl)}_${Date.now()}.jpg`;
          reviewScreenshotUrl = await uploadStorageScreenshot('scan_jobs', fileName, buf);
          console.log(`[scanner] In-memory review screenshot uploaded strictly to scan_jobs: ${reviewScreenshotUrl}`);
        }
      } catch (shotErr) {
        console.warn(`[scanner] Could not upload in-memory review screenshot: ${shotErr.message}`);
      }
      break;
    }

    // ── Discover fields on this page ──────────────────────────────────────────
    const pageFields = await discoverFormFieldQuestions(page).catch(() => []);

    // Separate known from new
    const newFields = pageFields.filter((f) => {
      const key = f.automationId ? `aid:${f.automationId}` : `label:${f.normalizedLabel}`;
      return !globalSeenKeys.has(key);
    });

    // Register new fields as seen
    for (const f of newFields) {
      const key = f.automationId ? `aid:${f.automationId}` : `label:${f.normalizedLabel}`;
      globalSeenKeys.add(key);
    }

    // ── Fill bypass answers & record questions ────────────────────────────────
    for (const field of newFields) {
      let bypassAnswer = '';

      if (!skipFill) {
        bypassAnswer = await fillBypassField(page, field, bypassProfile);

        // Postal code error healing
        if (
          /postal|zip\s*code/i.test(field.label) &&
          bypassAnswer
        ) {
          await page.waitForTimeout(800);
          const errored = await hasVisibleErrors(page);
          if (errored) {
            const healed = await healPostalCodeError(page, field, bypassProfile);
            if (!healed) {
              field.couldNotFill = true;
            }
          }
        }

        // Detect dynamic sub-fields that appeared after this fill
        if (bypassAnswer) {
          await waitForDomSettled(page, { timeout: 800 });
          const subFields = await scanPageForNewFields(page, globalSeenKeys);
          for (const sub of subFields) {
            const subKey = sub.automationId
              ? `aid:${sub.automationId}`
              : `label:${sub.normalizedLabel}`;
            globalSeenKeys.add(subKey);

            // Only fill required sub-fields automatically
            let subAnswer = '';
            if (sub.required) {
              subAnswer = await fillBypassField(page, sub, bypassProfile);
            }

            sequence++;
            allQuestions.push({
              sequence,
              page: pageNum,
              label: sub.label,
              normalizedLabel: sub.normalizedLabel,
              fieldType: sub.fieldType,
              required: sub.required,
              options: Array.isArray(sub.options) ? sub.options.map((o) => (typeof o === 'string' ? o : o.text || '')).filter(Boolean) : [],
              bypassAnswer: subAnswer,
              source_type: 'bypass',
              dynamic: true,
            });
          }
        }
      }

      sequence++;
      allQuestions.push({
        sequence,
        page: pageNum,
        label: field.label,
        normalizedLabel: field.normalizedLabel,
        fieldType: field.fieldType,
        required: field.required,
        options: Array.isArray(field.options)
          ? field.options.map((o) => (typeof o === 'string' ? o : o.text || '')).filter(Boolean)
          : [],
        bypassAnswer,
        source_type: 'bypass',
        couldNotFill: field.couldNotFill || false,
      });
    }

    // ── Attempt to advance to the next wizard page ────────────────────────────

    // Check for blocking errors before advancing
    const errorsBeforeAdvance = await hasVisibleErrors(page);
    if (errorsBeforeAdvance) {
      console.warn(
        `[scanner] Page ${pageNum}: validation errors present before advancing — attempting to continue anyway.`,
      );
    }

    // Locate Save/Continue button
    const advanceSel =
      'button[data-automation-id="pageFooterNextButton"], button[data-automation-id="saveAndContinueButton"], button:has-text("Save and Continue"), button:has-text("Continue"), button:has-text("Next")';

    const nextBtn = page.locator(advanceSel).first();
    const btnCount = await nextBtn.count().catch(() => 0);

    if (!btnCount) {
      console.log(`[scanner] No advance button found on page ${pageNum} — stopping scan.`);
      break;
    }

    // Check if it's a submit button (never click final submit during scan)
    const btnText = await nextBtn.textContent().catch(() => '');
    if (isSubmitButton(btnText)) {
      console.log(`[scanner] Submit button detected ("${btnText.trim()}") — stopping scan before submission.`);
      reachedReview = true;
      if (!reviewScreenshotUrl) {
        try {
          const { uploadStorageScreenshot } = await import('./supabaseClient.mjs');
          const buf = await page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
          if (buf && typeof uploadStorageScreenshot === 'function') {
            const fileName = `scan_${slugify(jobUrl)}_${Date.now()}.jpg`;
            reviewScreenshotUrl = await uploadStorageScreenshot('scan_jobs', fileName, buf);
            console.log(`[scanner] In-memory review screenshot uploaded strictly to scan_jobs: ${reviewScreenshotUrl}`);
          }
        } catch (shotErr) {
          console.warn(`[scanner] Could not upload in-memory review screenshot: ${shotErr.message}`);
        }
      }
      break;
    }

    await nextBtn.click({ force: true }).catch(() => {});

    // Wait for next page to load
    try {
      await Promise.race([
        page.waitForSelector('[data-automation-id="applicationStep"]', {
          timeout: 8000,
        }),
        waitForDomSettled(page, { timeout: 5000 }),
      ]);
    } catch {
      await waitForDomSettled(page, { timeout: 3000 });
    }

    // Small stabilization delay
    await page.waitForTimeout(500);

    // Confirm page actually advanced (URL or step indicator changed)
    const stillOnSamePage = await page
      .evaluate(() => {
        // If there's a validation summary still visible, we didn't advance
        return Boolean(
          document.querySelector('[data-automation-id="validationError"], [data-automation-id="pageError"]'),
        );
      })
      .catch(() => false);

    if (stillOnSamePage) {
      console.warn(`[scanner] Page ${pageNum}: did not advance (validation error). Stopping scan.`);
      break;
    }
  }

  console.log(
    `[scanner] Scan complete: ${allQuestions.length} questions across ${pageCount} pages. reachedReview=${reachedReview}`,
  );

  return {
    questions: allQuestions,
    pageCount,
    reachedReview,
    reviewScreenshotUrl,
  };
}

/**
 * Backward compatibility adapter for legacy workerPool.mjs callers.
 */
export async function scanForm(jobUrl, opts = {}) {
  const page = opts.page;
  if (!page) {
    return { fields: [], questions: [], field_count: 0, authFailed: false };
  }
  const fields = await discoverFormFieldQuestions(page).catch(() => []);
  return {
    fields,
    questions: fields,
    field_count: fields.length,
    authFailed: false,
    alreadyApplied: false,
  };
}
