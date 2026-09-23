/**
 * discovery.mjs — Workday-only link intake and form discovery
 *
 * Validates Workday career URLs, reads targets.txt, and navigates
 * from JD page to the application wizard.
 */

import { readFile } from 'fs/promises';

const WORKDAY_HOST_RE = /(^|\.)myworkdayjobs\.com$/i;

// ─── Workday URL validation ─────────────────────────────────────────────────
export function isWorkdayUrl(url) {
  try {
    const u = new URL(url);
    return WORKDAY_HOST_RE.test(u.hostname) || /workday/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Parse any Workday career host: {tenant}.{wdN}.myworkdayjobs.com
 * Supports wd1, wd3, wd5, wd12, wd108, and future wd* platforms.
 * @returns {{ tenant: string, platform: string, hostname: string }|null}
 */
export function detectWorkdayTenant(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const match = hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (match) {
      return {
        tenant: match[1].toLowerCase(),
        platform: match[2].toLowerCase(),
        hostname,
      };
    }
    if (/(^|\.)myworkdayjobs\.com$/i.test(hostname)) {
      return {
        tenant: hostname.split('.')[0],
        platform: '',
        hostname,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Tenant slug only (visa, synechron, td). Same YAML for every wd* platform. */
export function getWorkdayTenant(url) {
  return detectWorkdayTenant(url)?.tenant || 'unknown';
}

export function getWorkdayPlatform(url) {
  return detectWorkdayTenant(url)?.platform || '';
}

/**
 * Extract company name from Workday career URL.
 * Rule: Starting word before the first '.' in the hostname (e.g., motorolasolutions.wd5... -> motorolasolutions).
 * Everything after '.' is discarded.
 * @param {string} url
 * @returns {string}
 */
export function extractWorkdayCompanyName(url) {
  if (!url) return '';
  try {
    const raw = String(url).trim();
    const hostname = raw.includes('://')
      ? new URL(raw).hostname
      : raw.split('/')[0];
    const firstPart = (hostname.split('.')[0] || '').toLowerCase().trim();
    return firstPart;
  } catch {
    return '';
  }
}

/**
 * @param {string} line
 * @returns {{ url: string, company?: string }|null}
 */
export function parseTargetLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx > 0) {
    return {
      url: trimmed.slice(0, pipeIdx).trim(),
      company: trimmed.slice(pipeIdx + 1).trim() || undefined,
    };
  }
  return { url: trimmed };
}

/**
 * @param {string} url
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateWorkdayUrl(url) {
  if (!url) return { valid: false, reason: 'missing URL' };
  try {
    new URL(url);
  } catch {
    return { valid: false, reason: 'invalid URL syntax' };
  }
  if (!isWorkdayUrl(url)) {
    return { valid: false, reason: 'not a Workday career URL (myworkdayjobs.com required)' };
  }
  return { valid: true };
}

/**
 * @param {string} filePath
 * @returns {Promise<Array<{ url: string, company?: string }>>}
 */
export async function readTargetsFile(filePath) {
  return readJobLinksFile(filePath);
}

/**
 * Load today's job dump (CSV or txt). Pulls every Workday URL from the file.
 * Accepts: one URL per line, url|company, or any CSV row that contains a myworkdayjobs.com link.
 * @returns {Promise<Array<{ url: string, company?: string }>>}
 */
export async function readJobLinksFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const results = [];
  const seen = new Set();
  const urlRe = /https?:\/\/[^\s,"']+\.myworkdayjobs\.com[^\s,"']*/gi;

  const add = (url, company) => {
    const clean = String(url || '').replace(/[)\].,;]+$/g, '').trim();
    const check = validateWorkdayUrl(clean);
    if (!check.valid) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ url: clean, company: company || undefined });
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const found = trimmed.match(urlRe) || [];
    if (found.length) {
      let company = '';
      const parts = trimmed.split(',').map((p) => p.replace(/^"|"$/g, '').trim());
      if (parts.length >= 2 && !/myworkdayjobs\.com/i.test(parts[1] || '')) {
        company = parts[1];
      }
      for (const raw of found) add(raw, company);
      continue;
    }

    const parsed = parseTargetLine(trimmed);
    if (parsed) add(parsed.url, parsed.company);
  }

  return results;
}

// ─── ATS Detection (Workday-only) ──────────────────────────────────────────
export function detectATS(url) {
  return isWorkdayUrl(url) ? 'workday' : 'unsupported';
}

/**
 * Workday 404 / expired job posting — shown before login on bad URLs.
 * e.g. "The page you are looking for doesn't exist." + "Search for Jobs"
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayJobPageMissing(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const missing = /the page you are looking for doesn'?t exist/i.test(text)
      || /this job (?:posting )?has (?:been )?(?:filled|closed|expired|removed)/i.test(text)
      || /job (?:you(?:'re| are) looking for )?(?:is )?no longer (?:available|open)/i.test(text)
      || /position (?:has been )?filled/i.test(text);
    const searchJobs = /search for jobs/i.test(text);
    return missing && (searchJobs || /doesn'?t exist/i.test(text));
  }).catch(() => false);
}

const WORKDAY_WIZARD_SELECTORS = [
  'button:has-text("Save and Continue")',
  'button:has-text("Save & Continue")',
  'button[data-automation-id="bottom-navigation-next-button"]',
  'input[data-automation-id="legalNameSection_firstName"]',
  'input[data-automation-id="phone-number"]',
  '[data-automation-id*="wizardStep"]',
].join(', ');

const CONTINUE_APPLICATION_SELECTORS = [
  'a[data-automation-id="continueApplication"]',
  'button[data-automation-id="continueApplication"]',
  'a[data-automation-id="continueApplicationButton"]',
  'button[data-automation-id="continueApplicationButton"]',
  'a[data-automation-id="continueButton"]',
  'button[data-automation-id="continueButton"]',
  'a:has-text("Continue Application")',
  'button:has-text("Continue Application")',
  '[role="menuitem"]:has-text("Continue Application")',
  'a:has-text("Continue application")',
  'button:has-text("Continue application")',
];

/** True when the multi-step application wizard is visible (not JD / login). */
export async function isWorkdayWizardVisible(page) {
  const url = page.url();
  if (/\/login(?:\?|$)/i.test(url)) return false;

  // If on login, registration, or Social SSO screen, it is NOT the wizard
  const isAuth = await page.$([
    'input[data-automation-id="password"]:visible',
    'input[type="password"]:visible',
    'input[data-automation-id="verifyPassword"]:visible',
    'button[data-automation-id="SignInWithEmailButton"]:visible',
    'button[data-automation-id="signInSubmitButton"]:visible',
    'button[data-automation-id="createAccountSubmitButton"]:visible',
    'button[data-automation-id="createAccountLink"]:visible',
    'button[data-automation-id="signInLink"]:visible',
  ].join(', ')).catch(() => null);
  if (isAuth) return false;

  const el = await page.$(WORKDAY_WIZARD_SELECTORS).catch(() => null);
  return Boolean(el && await el.isVisible().catch(() => false));
}

/**
 * Click "Continue Application" when a draft exists (JD page or Manage menu).
 * @returns {Promise<boolean>} true if a continue control was clicked
 */
export async function clickContinueApplicationIfPresent(page) {
  if (await isWorkdayWizardVisible(page)) return false;

  for (const sel of CONTINUE_APPLICATION_SELECTORS) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        if (!await el.isVisible().catch(() => false)) continue;
        if (await isInNavOrHeader(el)) continue;
        const text = (await el.textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!/continue\s*application/i.test(text) && !/continueApplication/i.test(sel)) continue;
        console.log(`   Found draft resume control: "${text || 'Continue Application'}" — clicking...`);
        await el.click({ force: true }).catch(() => el.evaluate((node) => node.click()));
        await page.waitForTimeout(2000);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
        return true;
      }
    } catch {}
  }

  const viaDom = await page.evaluate(() => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetParent !== null || el.getClientRects().length > 0);
    };
    const inNav = (el) => !!el.closest('nav, header, [role="navigation"], [role="banner"]');
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]'));
    const target = nodes.find((el) => {
      if (!isVisible(el) || inNav(el)) return false;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const autoId = el.getAttribute('data-automation-id') || '';
      return /^continue\s*application$/i.test(t)
        || autoId === 'continueApplication'
        || autoId === 'continueApplicationButton';
    });
    if (!target) return null;
    target.click();
    return (target.textContent || '').replace(/\s+/g, ' ').trim() || 'Continue Application';
  }).catch(() => null);

  if (viaDom) {
    console.log(`   Found draft resume control via DOM: "${viaDom}" — clicked`);
    await page.waitForTimeout(2000);
    try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
    return true;
  }

  const manageBtn = page.locator('button, [role="button"]').filter({ hasText: /^manage$/i }).first();
  if (await manageBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
    if (!(await isInNavOrHeader(manageBtn).catch(() => false))) {
      await manageBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      const menuItem = page.locator('[role="menuitem"], li, a, button').filter({ hasText: /^Continue Application$/i }).first();
      if (await menuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('   Opening Manage menu → Continue Application...');
        await menuItem.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
        return true;
      }
    }
  }

  return false;
}

/**
 * Enter the application wizard from JD / draft / apply URL (DOM-only).
 * @returns {Promise<{ entered: boolean, method: string }>}
 */
export async function ensureWorkdayApplicationWizard(page, { mode = 'signin', profile = null, applywizzId = null } = {}) {
  if (await isWorkdayWizardVisible(page)) {
    return { entered: true, method: 'already-on-wizard' };
  }

  const continued = await clickContinueApplicationIfPresent(page);
  if (continued) {
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(1000);
    if (await isWorkdayWizardVisible(page)) {
      return { entered: true, method: 'continue-application' };
    }
  }

  await discoverApplicationForm(page, page.url(), { mode, profile, applywizzId });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(1000);

  if (await isWorkdayWizardVisible(page)) {
    return { entered: true, method: continued ? 'continue-then-apply' : 'apply-button' };
  }

  const retried = await clickContinueApplicationIfPresent(page);
  if (retried && await isWorkdayWizardVisible(page)) {
    return { entered: true, method: 'continue-application-retry' };
  }

  return { entered: false, method: 'none' };
}

// ─── Check if an element is inside a nav or header ─────────────────────────
export async function isInNavOrHeader(el) {
  return await el.evaluate(node => {
    let cur = node;
    while (cur && cur !== document.body) {
      const tag = cur.tagName?.toLowerCase();
      const role = cur.getAttribute?.('role')?.toLowerCase();
      const autoId = cur.getAttribute?.('data-automation-id')?.toLowerCase() || '';
      if (
        tag === 'nav' || tag === 'header' ||
        role === 'navigation' || role === 'banner' ||
        autoId === 'header' || autoId === 'navbar' || autoId === 'pageheader' || autoId === 'top-nav'
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    const rect = node.getBoundingClientRect();
    if (rect.top < 70 && rect.bottom < 85) {
      const inMainOrDialog = node.closest('main, [role="main"], [role="dialog"], .modal, form, [data-automation-id*="page"]');
      if (!inMainOrDialog) return true;
    }
    return false;
  }).catch(() => false);
}

// ─── Pre-scan page & modal elements to detect gateway state ────────────────
export async function prescanGatewayElements(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], .modal, [data-automation-id*="modal"], [data-automation-id*="dialog"]');
    const root = modal || document;

    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea'));
    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));

    const hasEmailInput = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const type = (i.type || '').toLowerCase();
      return (type === 'email' || autoId.includes('email') || autoId.includes('username') || nameOrId.includes('email') || nameOrId.includes('username')) && i.offsetParent !== null;
    });

    const hasPasswordInput = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const isVerify = autoId.includes('verify') || nameOrId.includes('verify') || (i.placeholder || '').toLowerCase().includes('verify');
      return (i.type === 'password' || autoId.includes('password')) && !isVerify && i.offsetParent !== null;
    });

    const hasVerifyPassword = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const isVerify = autoId.includes('verify') || nameOrId.includes('verify') || (i.placeholder || '').toLowerCase().includes('verify');
      return isVerify && i.offsetParent !== null;
    });

    const ssoWithEmailBtn = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return (t === 'sign in with email' || t === 'continue with email' || t === 'log in with email' || t.includes('sign in with email')) && b.offsetParent !== null;
    });

    const hasSocialSSO = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return (t.includes('google') || t.includes('apple') || t.includes('linkedin')) && b.offsetParent !== null;
    });

    const hasCreateAccountBtn = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      const autoId = b.getAttribute('data-automation-id') || '';
      return (t === 'create account' || autoId === 'createAccountLink' || autoId === 'createAccountSubmitButton' || autoId === 'createAccountTab') && b.offsetParent !== null;
    });

    const hasSignInUnderCreateAccount = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      const autoId = b.getAttribute('data-automation-id') || '';
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      const isSubmit = autoId === 'signInSubmitButton' || b.getAttribute('type') === 'submit';
      return (t === 'sign in' || autoId === 'signInLink' || autoId === 'signInTab') && !inNav && !isSubmit && b.offsetParent !== null;
    });

    const hasWizardFields = !!document.querySelector('input[data-automation-id="legalNameSection_firstName"], button[data-automation-id="bottom-navigation-next-button"], [data-automation-id*="wizardStep"]');

    const hasApplyBtn = buttons.some(b => {
      const autoId = b.getAttribute('data-automation-id') || '';
      const t = (b.textContent || '').trim().toLowerCase();
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      return !inNav && (autoId === 'adventureButton' || autoId === 'applyButton' || autoId === 'jobPostingApplyButton' || t === 'apply' || t === 'apply now' || t === 'apply for this job') && b.offsetParent !== null;
    });

    const hasContinueApplicationBtn = buttons.some(b => {
      const autoId = b.getAttribute('data-automation-id') || '';
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      return !inNav && (autoId === 'continueApplication' || autoId === 'continueApplicationButton' || t === 'continue application') && b.offsetParent !== null;
    });

    const hasForgotPasswordBtn = buttons.some(b => {
      const autoId = b.getAttribute('data-automation-id') || '';
      const t = (b.textContent || '').trim().toLowerCase();
      return (t.includes('forgot') || autoId === 'forgotPasswordLink') && b.offsetParent !== null;
    });

    const hasResetPasswordBtn = buttons.some(b => {
      const autoId = b.getAttribute('data-automation-id') || '';
      const t = (b.textContent || '').trim().toLowerCase();
      return (t.includes('reset password') || autoId === 'resetPasswordButton') && b.offsetParent !== null;
    });

    return {
      hasActiveModal: !!modal,
      hasWizardFields,
      hasApplyBtn,
      hasContinueApplicationBtn,
      hasEmailInput,
      hasPasswordInput,
      hasVerifyPassword,
      hasSocialSSO,
      hasSignInWithEmailBtn: ssoWithEmailBtn,
      hasCreateAccountBtn,
      hasSignInUnderCreateAccount,
      hasForgotPasswordBtn,
      hasResetPasswordBtn,
    };
  }).catch(() => ({}));
}

// ─── Adaptive Gateway Handler post-Apply ───────────────────────────────────
export async function handleAdaptiveGateway(page, mode = 'signin') {
  console.log(`   Scanning page & gateway elements post-apply (mode: "${mode}")...`);

  // Wait for gateway or form elements to hydrate before scanning
  try {
    await page.waitForSelector([
      'button[data-automation-id="SignInWithEmailButton"]',
      'button:has-text("Sign in with email")',
      'input[data-automation-id="password"]',
      'input[type="password"]',
      'input[data-automation-id="email"]',
      'input[type="email"]',
      'button[data-automation-id="createAccountTab"]',
      'button[data-automation-id="createAccountLink"]',
      'button:has-text("Create Account")',
      'button[data-automation-id="bottom-navigation-next-button"]',
      'button:has-text("Save and Continue")',
      'button:has-text("Save & Continue")',
    ].join(', '), { timeout: 10000 });
  } catch {}
  await page.waitForTimeout(500);

  const scan = await prescanGatewayElements(page);
  console.log('   Pre-scan elements:', JSON.stringify(scan));

  if (scan.hasActiveModal) {
    console.log('   ℹ️  Modal dialog detected — scanning and filling fields inside modal without closing it.');
  }

  // 1. Social SSO Screen with "Sign in with email"
  if (scan.hasSignInWithEmailBtn) {
    console.log('   🔗 Pre-scan: Detected Social SSO gateway — clicking "Sign in with email"...');
    const ssoBtns = await page.$$([
      'button[data-automation-id="SignInWithEmailButton"]',
      'button:has-text("Sign in with email")',
      'a:has-text("Sign in with email")',
      'button:has-text("Continue with email")',
      'a:has-text("Continue with email")',
      '[data-automation-id*="email" i]'
    ].join(', '));
    for (const btn of ssoBtns) {
      if (await btn.isVisible().catch(() => false)) {
        if (await isInNavOrHeader(btn)) continue;
        await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
        await page.waitForTimeout(2000);
        break;
      }
    }
  }

  // 2. Post-SSO state check
  const postScan = await prescanGatewayElements(page);

  if (mode === 'signin') {
    // If verifyPassword, createAccountBtn, or link under create account is present, click "Sign In" link (except on Reset Password form)
    if (!postScan.hasResetPasswordBtn && (postScan.hasVerifyPassword || postScan.hasCreateAccountBtn || postScan.hasSignInUnderCreateAccount)) {
      console.log('   🔗 Pre-scan: Detected Create Account gateway — clicking "Sign In" link below Create Account button...');
      await clickGatewaySignIn(page);
    }
    // Wait for password input to appear
    try {
      await page.waitForSelector('input[data-automation-id="password"]:visible, input[type="password"]:visible', { timeout: 8000 });
      console.log('   ✅ Sign-in form ready (password input visible).');
    } catch {
      console.log('   ⚠️  Waiting for sign-in form inputs...');
    }
  } else if (mode === 'signup') {
    if (postScan.hasPasswordInput && !postScan.hasVerifyPassword && postScan.hasCreateAccountBtn) {
      console.log('   🔗 Pre-scan: On Sign In screen in signup mode — clicking "Create Account"...');
      await clickGatewayCreateAccount(page);
    }
    try {
      await page.waitForSelector('input[data-automation-id="verifyPassword"]:visible, input[data-automation-id="email"]:visible', { timeout: 8000 });
      console.log('   ✅ Create Account form ready.');
    } catch {}
  }
}

// ─── Check if Workday sign-in form inputs are already visible ──────────────
export async function isSignInFormVisible(page) {
  const pwd = await page.$('input[data-automation-id="password"]:visible, input[type="password"]:visible').catch(() => null);
  const verifyPwd = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  // Must have password AND NOT verifyPassword
  return !!(pwd && !verifyPwd);
}

// ─── Click the gateway "Sign In" link (below Create Account, not nav bar) ───
export async function clickGatewaySignIn(page) {
  // Try candidates inside modal dialog first, then main document
  const candidates = await page.$$([
    '[role="dialog"] [data-automation-id="signInLink"]',
    '[role="dialog"] [data-automation-id="signInTab"]',
    '[role="dialog"] button:has-text("Sign In")',
    '[role="dialog"] a:has-text("Sign In")',
    '[data-automation-id="signInLink"]',
    '[data-automation-id="signInTab"]',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
  ].join(', '));

  for (const el of candidates) {
    if (!await el.isVisible().catch(() => false)) continue;
    const autoId = await el.getAttribute('data-automation-id').catch(() => '');
    const type = await el.getAttribute('type').catch(() => '');

    // Skip submit buttons
    if (autoId === 'signInSubmitButton' || type === 'submit') continue;

    // Skip elements inside top nav/header
    if (await isInNavOrHeader(el)) continue;

    console.log('   Clicking gateway "Sign In" link (below Create Account, not nav bar)...');
    await el.click({ force: true }).catch(() => el.evaluate(e => e.click()));
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

// ─── Click the gateway "Create Account" button/tab (not nav bar) ───────────
export async function clickGatewayCreateAccount(page) {
  const verifyPwd = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  if (verifyPwd) {
    console.log('   Create Account form is already visible.');
    return true;
  }

  // If currently on Social SSO, click "Sign in with email" first
  const ssoBtn = await page.$('button[data-automation-id="SignInWithEmailButton"]:visible, button:has-text("Sign in with email"):visible');
  if (ssoBtn) {
    console.log('   Clicking "Sign in with email" before switching to Create Account...');
    await ssoBtn.click({ force: true }).catch(() => ssoBtn.evaluate(e => e.click()));
    await page.waitForTimeout(1500);
  }

  const buttons = await page.$$([
    '[role="dialog"] button[data-automation-id="createAccountLink"]',
    '[role="dialog"] button:has-text("Create Account")',
    'button[data-automation-id="createAccountLink"]',
    '[data-automation-id="createAccountTab"]',
    'button:has-text("Create Account")',
    'a:has-text("Create Account")',
  ].join(', '));

  for (const btn of buttons) {
    if (!await btn.isVisible().catch(() => false)) continue;
    const autoId = await btn.getAttribute('data-automation-id').catch(() => '');
    const type = await btn.getAttribute('type').catch(() => '');

    if (autoId === 'createAccountSubmitButton' || type === 'submit') continue;
    if (await isInNavOrHeader(btn)) continue;

    console.log('   Clicking gateway "Create Account" button (not nav bar)...');
    await btn.click({ force: true }).catch(() => btn.evaluate(e => e.click()));
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

/**
 * Extract job role/title from Workday job page DOM or URL fallback.
 * @param {import('playwright').Page} page
 * @param {string} [fallbackUrl]
 * @returns {Promise<string>}
 */
export async function extractJobRoleFromDom(page, fallbackUrl = '') {
  let role = '';
  try {
    if (page && typeof page.evaluate === 'function') {
      role = await page.evaluate(() => {
        const selectors = [
          'h1[data-automation-id="jobPostingHeader"]',
          '[data-automation-id="jobPostingHeader"]',
          '[data-automation-id="jobTitle"]',
          'h1[data-automation-id*="job" i]',
          '[data-automation-id="jobPostingPage"] h1',
          'main h1',
          'article h1',
          'h1',
          '[role="heading"][aria-level="1"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt && txt.length > 2 && txt.length < 200 && !/^(sign in|create account|apply|my information|my experience|application questions|review)/i.test(txt)) {
              return txt;
            }
          }
        }
        return '';
      }).catch(() => '');
    }
  } catch {}

  if (role) return role;

  const targetUrl = fallbackUrl || (page && typeof page.url === 'function' ? page.url() : '');
  if (targetUrl) {
    try {
      const pathname = new URL(targetUrl).pathname;
      const parts = pathname.split('/').filter(Boolean);
      const slug = parts[parts.length - 1] || '';
      if (slug) {
        const cleaned = slug
          .replace(/_[A-Za-z0-9-]+$/, '')
          .replace(/[-_]+/g, ' ')
          .trim();
        if (cleaned) return cleaned;
      }
    } catch {}
  }
  return '';
}

// ─── Workday form discovery (JD → Apply → auth gateway) ─────────────────────
export async function discoverApplicationForm(page, originalUrl, { mode = 'signin', profile = null, applywizzId = null } = {}) {
  const currentUrl = page.url();

  if (!isWorkdayUrl(currentUrl) && !isWorkdayUrl(originalUrl)) {
    console.log('⚠ Non-Workday URL — this build supports Workday career sites only.');
    return null;
  }

  console.log('📋 Workday detected — navigating to application form...');

    // Accept cookie notice if present
    try {
      const cookieBtn = await page.$('button[data-automation-id="legalNoticeAcceptButton"], button:has-text("Accept Cookies"), button:has-text("Accept all"), button:has-text("Accept")');
      if (cookieBtn && await cookieBtn.isVisible().catch(() => false)) {
        console.log('   Dismissing cookie banner...');
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}

    // 1. Check if already on wizard form (Step 1..5)
    if (await isWorkdayWizardVisible(page)) {
      console.log('   Already on Workday application wizard.');
      return page.url();
    }

    // 2. Draft in progress — "Continue Application" on JD (replaces Apply)
    const continued = await clickContinueApplicationIfPresent(page);
    if (continued) {
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1000);
      if (await isWorkdayWizardVisible(page)) {
        console.log('   Resumed draft application via Continue Application.');
        return page.url();
      }
      await handleAdaptiveGateway(page, mode);
      if (await isWorkdayWizardVisible(page)) {
        console.log('   Resumed draft application after gateway.');
        return page.url();
      }
    }

    // 3. Target initial Apply button on JD page (excluding nav/header links)
    const workdayApplySelectors = [
      ...CONTINUE_APPLICATION_SELECTORS,
      'a[data-automation-id="adventureButton"]',
      'a[data-automation-id="applyButton"]',
      'button[data-automation-id="applyButton"]',
      '[data-automation-id="jobPostingApplyButton"]',
      'a[data-automation-id*="apply" i]',
      'button[data-automation-id*="apply" i]',
      'a[data-uxi-element-id*="apply"]',
      'button[data-uxi-element-id*="apply"]',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ];

    let applyBtn = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const sel of workdayApplySelectors) {
        try {
          const btns = await page.$$(sel);
          for (const btn of btns) {
            if (await btn.isVisible().catch(() => false)) {
              if (await isInNavOrHeader(btn)) continue;
              applyBtn = btn;
              break;
            }
          }
        } catch {}
        if (applyBtn) break;
      }
      if (applyBtn) break;
      await page.waitForTimeout(1000);
    }

    if (applyBtn) {
      const text = (await applyBtn.textContent().catch(() => '')).trim();
      console.log(`   Found initial Workday Apply button: "${text || 'Apply'}" — clicking...`);

      // Determine company & job role
      const effectiveUrl = originalUrl || page.url();
      const company = extractWorkdayCompanyName(effectiveUrl);
      const role = await extractJobRoleFromDom(page, effectiveUrl);
      if (profile) {
        if (company && !profile._company) profile._company = company;
        if (role && !profile._jobTitle) profile._jobTitle = role;
        if (role && !profile._roleTitle) profile._roleTitle = role;
      }

      let hasPriorApp = false;
      const clientAwlId = String(
        applywizzId
        || profile?._applyWizzId
        || profile?.applywizz_id
        || profile?.client_id
        || process.env.APPLYWIZZ_ID
        || '',
      ).trim();

      if (clientAwlId && company) {
        try {
          const { hasPriorApplicationForCompany } = await import('./applicationHistory.mjs');
          hasPriorApp = await hasPriorApplicationForCompany(clientAwlId, company, profile, effectiveUrl);
        } catch {
          hasPriorApp = false;
        }
      }

      await applyBtn.click({ force: true }).catch(() => applyBtn.evaluate(el => el.click()));
      await page.waitForTimeout(2000);

      // Popup choices: if client previously applied to this company, click "Use My Last Application", else "Apply Manually"
      const manualApplySelectors = [
        '[data-automation-id="applyManually"]',
        'a[data-automation-id="applyManually"]',
        'button[data-automation-id="applyManually"]',
        'a:has-text("Apply Manually")',
        'button:has-text("Apply Manually")',
        'a[href*="applyManually"]',
        'span:has-text("Apply Manually")',
        'div:has-text("Apply Manually")',
      ];

      const previousAppSelectors = [
        '[data-automation-id="useMyLastApplication"]',
        '[data-automation-id="useMyPreviousApplication"]',
        'a[data-automation-id="useMyLastApplication"]',
        'button[data-automation-id="useMyLastApplication"]',
        'a:has-text("Use My Last Application")',
        'button:has-text("Use My Last Application")',
        'a:has-text("Use My Previous Application")',
        'button:has-text("Use My Previous Application")',
        'span:has-text("Use My Last Application")',
        'span:has-text("Use My Previous Application")',
        'div:has-text("Use My Last Application")',
        'div:has-text("Use My Previous Application")',
        '[data-automation-id*="lastApplication" i]',
        '[data-automation-id*="previousApplication" i]',
      ];

      let optionClicked = false;

      if (hasPriorApp) {
        console.log(`   Client "${clientAwlId}" has applied to "${company}" previously — selecting "Use My Last Application"...`);
        for (let attempt = 0; attempt < 8; attempt++) {
          for (const sel of previousAppSelectors) {
            try {
              const opt = await page.$(sel);
              if (opt && await opt.isVisible().catch(() => false)) {
                const optText = (await opt.textContent().catch(() => '')).trim();
                console.log(`   ✅ Selecting Workday apply option: "${optText || 'Use My Last Application'}"...`);
                await opt.click({ force: true }).catch(() => opt.evaluate(el => el.click()));
                optionClicked = true;
                await page.waitForTimeout(2000);
                break;
              }
            } catch {}
          }
          if (optionClicked) break;
          await page.waitForTimeout(500);
        }
        if (!optionClicked) {
          console.log(`   ℹ️  "Use My Last Application" popup option not found — falling back to "Apply Manually"...`);
        }
      } else {
        console.log(`   Client "${clientAwlId || 'unknown'}" is new to "${company}" — selecting "Apply Manually"...`);
      }

      if (!optionClicked) {
        console.log('   Waiting for "Apply Manually" popup option...');
        for (let attempt = 0; attempt < 8; attempt++) {
          for (const sel of manualApplySelectors) {
            try {
              const opt = await page.$(sel);
              if (opt && await opt.isVisible().catch(() => false)) {
                const optText = (await opt.textContent().catch(() => '')).trim();
                console.log(`   Selecting Workday apply option: "${optText || 'Apply Manually'}"...`);
                await opt.click({ force: true }).catch(() => opt.evaluate(el => el.click()));
                optionClicked = true;
                await page.waitForTimeout(2000);
                break;
              }
            } catch {}
          }
          if (optionClicked) break;
          await page.waitForTimeout(500);
        }
      }

      // 3. Post-Apply Gateway Handling with adaptive element pre-scan
      await handleAdaptiveGateway(page, mode);

      try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(2000);
      return page.url();
    }

    return page.url();
}

// ─── Extract JD text from page (for resume matching) ────────────────────────
export async function extractJDText(page) {
  return page.evaluate(() => {
    const selectors = [
      '.job-post-content', '.job-description', '.posting-description',
      '#job-description', '.description', '[class*="jobDescription"]',
      '[class*="job-details"]', 'article', 'main',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) return el.textContent.trim();
    }
    return document.body?.innerText?.substring(0, 5000) || '';
  });
}

