/**
 * scanner.mjs — Form field scanner
 *
 * Navigates to a job URL, discovers the application form,
 * extracts all fields (inputs, selects, textareas, custom dropdowns),
 * and writes a scan JSON.
 *
 * Discovery priority:
 * 1. data-automation-id
 * 2. label text
 * 3. id / name
 * 4. role
 * 5. css path fallback
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { discoverApplicationForm, detectATS } from './discovery.mjs';
import { handleWorkday } from './workday.mjs';
import { normalizeLabel } from './qaStore.mjs';

// ─── Submit button patterns ────────────────────────────────────────────────
const SUBMIT_PATTERNS = [
  /submit\s*application/i,
  /submit/i,
  /send\s*application/i,
  /apply\s*now/i,
  /complete\s*application/i,
];

export function isSubmitButton(text) {
  return SUBMIT_PATTERNS.some(p => p.test((text || '').trim()));
}

// ─── Slug helper ────────────────────────────────────────────────────────────
export function slugify(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.replace(/^(boards|job-boards|jobs|careers)\./, '').replace(/\..+$/, '');

    // Skip generic path segments that don't identify the job
    const skipParts = new Set(['jobs', 'embed', 'job_app', 'us', 'en', 'apply', 'job', 'careers', 'career', 'position', 'posting']);
    const isJobId = (p) => /^\d+$/.test(p) || /^[A-Z]\d{4,}/.test(p) || /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}/.test(p);
    const jobId = parts.find(p => isJobId(p)) || parts[parts.length - 1] || u.searchParams.get('token') || '';
    const company = parts.find(p => !skipParts.has(p.toLowerCase()) && !isJobId(p)) || host;

    const slug = `${company}-${jobId}`.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
    return slug === '-' ? host : slug;
  } catch {
    return 'unknown-form';
  }
}

// ─── In-browser DOM Scanner ────────────────────────────────────────────────
export function discoverFieldsInDOM(container = document) {
  const root = container || document;
  const nodes = root.querySelectorAll(
    'input, select, textarea, [role="combobox"], [role="radiogroup"], [role="radio"], [role="checkbox"], [contenteditable="true"], [data-automation-id="select-widget"]'
  );

  function isVisible(el) {
    if (!el) return false;
    if (el.type === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  }

  function indexAmongSiblingsWithRole(el, role) {
    const siblings = Array.from(document.querySelectorAll(`[role="${role}"]`));
    return siblings.indexOf(el);
  }

  function cssPathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const path = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr.tagName.toLowerCase() !== 'html') {
      let selector = curr.tagName.toLowerCase();
      if (curr.id) {
        selector += '#' + CSS.escape(curr.id);
        path.unshift(selector);
        break;
      }
      const autoId = curr.getAttribute('data-automation-id');
      if (autoId) {
        selector += `[data-automation-id="${CSS.escape(autoId)}"]`;
        path.unshift(selector);
        break;
      }
      let sib = curr;
      let nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === curr.tagName) nth++;
      }
      if (nth !== 1) selector += `:nth-of-type(${nth})`;
      path.unshift(selector);
      curr = curr.parentElement;
    }
    return path.join(' > ');
  }

  function getLabelText(el) {
    // Priority: aria-labelledby > explicit <label for> > wrapping <label> > legend > preceding sibling text > aria-label > placeholder
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean).join(' ');
      if (text) return text;
    }

    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return forLabel.textContent.trim();
    }

    const wrapping = el.closest('label');
    if (wrapping) return wrapping.textContent.trim();

    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) return legend.textContent.trim();

    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
      const txt = prev.textContent.trim();
      if (txt && txt.length < 120) return txt;
    }

    const parent = el.parentElement;
    if (parent) {
      const textNode = Array.from(parent.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
      if (textNode) return textNode.textContent.trim();
      const parentLabel = parent.querySelector('label, [class*="label"], [data-automation-id*="label"]');
      if (parentLabel && parentLabel !== el) {
        const txt = parentLabel.textContent.trim();
        if (txt && txt.length < 120) return txt;
      }
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    if (el.placeholder) return el.placeholder.trim();

    const autoId = el.getAttribute('data-automation-id') || '';
    const idOrName = el.id || el.name || autoId;
    if (idOrName) {
      const clean = idOrName
        .replace(/^(name--|address--|phoneNumber--|legalName--)/, '')
        .replace(/--/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .trim();
      if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    return null;
  }

  function normalizeText(label) {
    return (label || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveStableKey(el) {
    // Priority: automation-id > label text > id/name > role
    const automationId = el.getAttribute('data-automation-id')
      || el.closest('[data-automation-id]')?.getAttribute('data-automation-id');
    if (automationId) return `aid:${automationId}`;

    const label = getLabelText(el);
    if (label) return `label:${normalizeText(label)}`;

    if (el.id) return `id:${el.id}`;
    if (el.name) return `name:${el.name}`;

    const role = el.getAttribute('role');
    if (role) return `role:${role}:${indexAmongSiblingsWithRole(el, role)}`;

    return `fallback:${cssPathOf(el)}`;
  }

  function isRequired(el) {
    return el.required ||
      el.getAttribute('aria-required') === 'true' ||
      Boolean(el.closest('.field, [data-automation-id*="formField"], div')?.querySelector('.required, .asterisk, [aria-required="true"]')) ||
      Boolean(el.getAttribute('data-automation-id')?.toLowerCase().includes('required'));
  }

  function getCurrentValue(el) {
    if (el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') {
      return el.checked || el.getAttribute('aria-checked') === 'true';
    }
    if (el.type === 'radio' || el.getAttribute('role') === 'radio') {
      return el.checked || el.getAttribute('aria-checked') === 'true';
    }
    const selected = el.querySelector?.('[data-automation-id="selectedItem"], [data-automation-id="promptOption"]')
      || el.closest('[data-automation-id]')?.querySelector('[data-automation-id="selectedItem"]');
    if (selected && (selected.textContent || '').trim()) return selected.textContent.trim();
    const role = el.getAttribute('role');
    if (role === 'combobox' || el.getAttribute('aria-haspopup') || el.getAttribute('data-automation-id') === 'select-widget') {
      return (el.innerText || el.textContent || el.value || '').trim();
    }
    return el.value ?? el.textContent?.trim() ?? '';
  }

  function classifyFieldType(el) {
    const role = el.getAttribute('role');
    if (role === 'combobox') return 'select';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'radiogroup' || role === 'radio') return 'radio';
    if (el.getAttribute('data-automation-id') === 'select-widget') return 'select';
    if (el.tagName.toLowerCase() === 'select') return 'select';
    if (el.tagName.toLowerCase() === 'textarea') return 'textarea';
    if (el.type) return el.type === 'select-one' ? 'select' : el.type;
    if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    return 'text';
  }

  const fields = [];
  for (const el of nodes) {
    if (el.getAttribute('data-automation-id') === 'beecatcher' || el.name === 'website') continue;
    const type = classifyFieldType(el);
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type) && el.getAttribute('data-automation-id') !== 'select-widget') continue;
    if (!isVisible(el)) continue;

    const automationId = el.getAttribute('data-automation-id')
      || el.closest('[data-automation-id]')?.getAttribute('data-automation-id')
      || '';
    const key = resolveStableKey(el);
    const label = getLabelText(el) || '';
    const id = el.id || '';
    const name = el.name || '';

    let selector = '';
    if (el.id) selector = `#${CSS.escape(el.id)}`;
    else if (automationId) selector = `[data-automation-id="${CSS.escape(automationId)}"]`;
    else if (el.name) selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    else selector = cssPathOf(el);

    const field = {
      key,
      id: id || automationId || name || key,
      name,
      automationId,
      selector,
      label,
      required: isRequired(el),
      value: getCurrentValue(el),
      type,
      disabled: Boolean(el.disabled || el.readOnly),
    };

    if (type === 'select' && el.tagName.toLowerCase() === 'select') {
      field.options = Array.from(el.options || []).map(o => ({
        value: o.value,
        text: o.textContent.trim(),
      })).filter(o => o.value !== '');
    }

    if (type === 'radio' && el.name) {
      const radios = document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`);
      field.options = Array.from(radios).map(r => {
        const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        return { value: r.value, text: lbl ? lbl.textContent.trim() : r.value };
      });
    }

    if (type === 'file') {
      field.accept = el.getAttribute('accept') || '';
    }

    fields.push(field);
  }

  // Dedupe by stable key
  const seen = new Set();
  const deduped = [];
  for (const f of fields) {
    if (!f.key || seen.has(f.key)) continue;
    seen.add(f.key);
    deduped.push(f);
  }
  return deduped;
}

// ─── Public discoverFields (Works with Playwright Page or DOM container) ───
export async function discoverFields(pageOrContainer = (typeof document !== 'undefined' ? document : null), selector = '[data-automation-id="formContent"], form, body') {
  if (pageOrContainer && typeof pageOrContainer.evaluate === 'function') {
    return await pageOrContainer.evaluate(({ fnString, sel }) => {
      const evalFn = new Function('container', `return (${fnString})(container);`);
      let container = document;
      if (sel && typeof sel === 'string') {
        container = document.querySelector(sel) || document;
      }
      return evalFn(container);
    }, { fnString: discoverFieldsInDOM.toString(), sel: selector });
  }

  if (typeof document !== 'undefined') {
    return discoverFieldsInDOM(pageOrContainer || document);
  }

  return [];
}

// ─── Scan a form ────────────────────────────────────────────────────────────
export async function scanForm(url, { formsDir, browser: existingBrowser, context: existingContext, page: existingPage, keepOpen = false, workdayEmail, workdayPassword, otpEmail, otpPassword, mode = 'signin' } = {}) {
  console.log(`🔍 Scanning: ${url}`);
  const outDir = formsDir || resolve(process.cwd(), 'forms');
  await mkdir(outDir, { recursive: true });

  const ownBrowser = !existingBrowser;
  const browser = existingBrowser || await chromium.launch({ headless: false });
  const context = existingContext || (existingBrowser ? await browser.newContext() : await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }));
  const page = existingPage || await context.newPage();

  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('data:')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* partial load OK */ }
      await page.waitForTimeout(2000);
    }

    const ats = detectATS(url);
    let formUrl = url;

    // Step 1: Discover application form (clicks Apply -> Apply Manually on Workday)
    console.log(`   Discovering application form for ${ats}...`);
    const foundForm = await discoverApplicationForm(page, url, { mode });
    if (foundForm) formUrl = foundForm;

    // Step 2: Authenticate if Workday
    if (ats === 'workday') {
      console.log(`   Authenticating on Workday (${mode} mode) before scanning form fields...`);
      const authOk = await handleWorkday(page, {
        email: workdayEmail || otpEmail,
        password: workdayPassword,
        otpEmail,
        otpPassword,
        mode,
      });

      if (!authOk) {
        console.log('   ⚠️  Workday authentication was not completed — skipping premature gateway scan.');
        return {
          url: page.url(),
          original_url: url,
          title: await page.title(),
          scanned_at: new Date().toISOString(),
          field_count: 0,
          fields: [],
          submit_buttons: [],
        };
      }

      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(3000);
      try {
        await page.waitForSelector('input:not([type="hidden"]), select, textarea, [data-automation-id*="form"], [data-automation-id*="page"], [data-automation-id*="Section"]', { timeout: 10000 });
      } catch {}
      formUrl = page.url();
    }

    const pageTitle = await page.title();

    // Extract all form fields via updated discovery priority
    const fields = await discoverFields(page);

    // Detect submit buttons
    const submitButtons = await page.evaluate(() => {
      const buttons = [];
      document.querySelectorAll('button, input[type="submit"], a.btn, [role="button"]').forEach(el => {
        const text = el.textContent.trim() || el.value || '';
        if (text && text.length < 50) {
          buttons.push({ text, type: el.tagName.toLowerCase(), selector: el.id ? `#${el.id}` : '' });
        }
      });
      return buttons;
    });

    // Detect Yes/No button questions (Ashby pattern)
    const buttonQuestions = await page.evaluate(() => {
      const questions = [];
      const labels = document.querySelectorAll('label');
      labels.forEach(label => {
        const container = label.closest('[class*="field"], [class*="question"], [class*="Field"]') || label.parentElement;
        if (!container) return;
        const buttons = container.querySelectorAll('button');
        const btnTexts = Array.from(buttons).map(b => b.textContent.trim());
        if (btnTexts.includes('Yes') && btnTexts.includes('No')) {
          questions.push({
            id: label.htmlFor || `btn_q_${questions.length}`,
            label: label.textContent.trim(),
            type: 'yes-no-button',
            options: ['Yes', 'No'],
          });
        }
      });
      return questions;
    });

    const scan = {
      url: formUrl,
      original_url: url,
      title: pageTitle,
      scanned_at: new Date().toISOString(),
      field_count: fields.length + buttonQuestions.length,
      fields: [...fields, ...buttonQuestions],
      submit_buttons: submitButtons.map(b => ({
        ...b,
        blocked: isSubmitButton(b.text),
      })),
    };

    const slug = slugify(url);
    const outPath = resolve(outDir, `${slug}-scan.json`);
    await writeFile(outPath, JSON.stringify(scan, null, 2));
    console.log(`✅ Scan complete: ${scan.field_count} fields detected`);
    console.log(`📄 Written to: ${outPath}`);
    console.log(`\nField summary:`);
    scan.fields.forEach((f, i) => {
      const req = f.required ? ' *' : '';
      console.log(`  ${i + 1}. [${f.type}] ${f.label || f.id}${req}`);
    });

    if (!keepOpen) {
      await context.close();
      if (ownBrowser) await browser.close();
    }
    return scan;

  } catch (err) {
    console.error(`❌ Scan failed: ${err.message}`);
    if (!keepOpen) {
      await context.close();
      if (ownBrowser) await browser.close();
    }
    throw err;
  }
}
