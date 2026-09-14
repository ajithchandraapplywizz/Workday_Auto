/**
 * workday.mjs — Workday account creation & login
 *
 * Workday requires an account to apply. This module:
 * 1. Detects Workday login page
 * 2. Creates account (or logs in if credentials exist)
 * 3. Fills email + auto-generates password
 * 4. Navigates to the application form
 *
 * Login is email + password only. Mailbox OTP is not connected
 * (Zoho Mail can be wired later if a tenant ever requires a code).
 */

import {
  discoverApplicationForm,
  isInNavOrHeader,
  isSignInFormVisible,
  clickGatewaySignIn,
  clickGatewayCreateAccount,
  prescanGatewayElements,
  handleAdaptiveGateway,
  isWorkdayWizardVisible,
  clickContinueApplicationIfPresent,
  ensureWorkdayApplicationWizard,
} from './discovery.mjs';

const MAILBOX_NOT_CONNECTED =
  'Mailbox OTP is not connected (Zoho Mail can be added later). Login is email + password only.';

/**
 * Classify a failed Workday login attempt from visible page text.
 * @param {import('playwright').Page} page
 * @returns {Promise<'needs-signup'|'locked'|'unknown'>}
 */
async function detectLoginFailureReason(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    if (
      text.includes('wrong email address or password') ||
      text.includes('wrong email or password') ||
      text.includes('invalid credentials') ||
      text.includes('unable to sign in') ||
      text.includes('no account') ||
      text.includes('account does not exist') ||
      text.includes('create an account')
    ) {
      return 'needs-signup';
    }
    if (text.includes('account might be locked') || text.includes('account is locked')) {
      return 'locked';
    }
    return 'unknown';
  }).catch(() => 'unknown');
}

/** @returns {Promise<boolean>} */
async function isStillOnSignInForm(page) {
  const pwd = await page.$('input[type="password"]:visible, input[data-automation-id="password"]:visible').catch(() => null);
  const verifyPwd = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  return Boolean(pwd && !verifyPwd);
}

/**
 * After successful login, click Apply if back on the JD page.
 * @param {import('playwright').Page} page
 * @param {string} mode
 * @returns {Promise<true>}
 */
async function finishSuccessfulLogin(page, mode) {
  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  if (await isWorkdayWizardVisible(page)) {
    console.log('   Logged in — already on application wizard.');
    return true;
  }

  const continued = await clickContinueApplicationIfPresent(page);
  if (continued && await isWorkdayWizardVisible(page)) {
    console.log('   Logged in — resumed draft via Continue Application.');
    return true;
  }

  const hasApplyBtn = await page.$([
    'a[data-automation-id="adventureButton"]',
    'a[data-automation-id="applyButton"]',
    'button[data-automation-id="applyButton"]',
    '[data-automation-id="jobPostingApplyButton"]',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'a:has-text("Continue Application")',
    'button:has-text("Continue Application")',
  ].join(', ')).catch(() => null);

  if (hasApplyBtn && await hasApplyBtn.isVisible().catch(() => false)) {
    console.log('   Logged in, on JD page — entering application wizard...');
    await ensureWorkdayApplicationWizard(page, { mode });
  } else if (!continued) {
    await clickContinueApplicationIfPresent(page);
  }

  return true;
}

/**
 * Create account on this tenant, then sign in (or continue if already on the form).
 * @param {import('playwright').Page} page
 * @param {{ email: string, password: string, mode?: string }} opts
 * @returns {Promise<boolean>}
 */
async function fallbackCreateAccountAndLogin(page, { email, password, mode = 'signin' }) {
  console.log('   No account on this tenant — clicking Create Account and registering...');
  const createdPassword = await workdayCreateAccount(page, email, password);
  if (!createdPassword) {
    console.log('   ❌ Account creation failed during signin fallback.');
    return false;
  }

  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  await page.waitForTimeout(2000);

  const onSignIn = await isWorkdaySignInPage(page);
  if (onSignIn) {
    console.log('   Workday redirected to Sign In — logging in with registered credentials...');
    const loggedIn = await workdayLogin(page, email, createdPassword);
    if (loggedIn !== true) {
      console.log('   ❌ Sign-in failed after account creation.');
      return false;
    }
    return finishSuccessfulLogin(page, mode);
  }

  console.log('   ✅ Page already on application form after account creation.');
  return true;
}

// ─── Generate a secure password ─────────────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const specials = '!@#$%&*';
  let pwd = '';
  for (let i = 0; i < 12; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  // Add a special char and digit to satisfy most policies
  pwd += specials[Math.floor(Math.random() * specials.length)];
  pwd += Math.floor(Math.random() * 10);
  return pwd;
}

// ─── Detect if page is Workday login/gateway ────────────────────────────────
export async function isWorkdayLogin(page) {
  const url = page.url();
  if (!/workday|myworkday/i.test(url)) return false;

  const scan = await prescanGatewayElements(page);
  if (scan.hasWizardFields) return false;
  if (scan.hasApplyBtn) return false;

  return !!(
    scan.hasEmailInput ||
    scan.hasPasswordInput ||
    scan.hasVerifyPassword ||
    scan.hasSignInWithEmailBtn ||
    scan.hasCreateAccountBtn ||
    scan.hasSignInUnderCreateAccount
  );
}

// ─── Login to Workday ───────────────────────────────────────────────────────
/**
 * @returns {Promise<true|'needs-signup'|'locked'|false>}
 */
export async function workdayLogin(page, email, password) {
  console.log('   Logging into Workday...');

  // Adaptively ensure we are on the sign-in form (handles SSO "Sign in with email" and "Sign In" link below Create Account)
  await handleAdaptiveGateway(page, 'signin');

  // Wait for signin form to appear (email + password inputs)
  try {
    await page.waitForSelector('input[data-automation-id="password"], input[type="password"]', { timeout: 8000 });
  } catch {}

  // 3. Fill visible email
  const emailInputs = await page.$$('input[data-automation-id="email"], input[data-automation-id="userName"], input[type="email"], input[name="email"], input[name="userName"]');
  let emailFilled = false;
  for (const inp of emailInputs) {
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(email);
      await page.waitForTimeout(200);
      emailFilled = true;
      break;
    }
  }

  // 4. Fill visible password
  const passwordInputs = await page.$$('input[data-automation-id="password"], input[type="password"], input[name="password"]');
  let passwordFilled = false;
  for (const inp of passwordInputs) {
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(password);
      await page.waitForTimeout(200);
      passwordFilled = true;
      break;
    }
  }

  if (!emailFilled || !passwordFilled) {
    console.log('    ⚠️  Could not locate visible email/password inputs on Sign In form.');
  }

  // 5. Click visible Sign In submit button with force: true (excluding nav header)
  const signInButtons = await page.$$('button[data-automation-id="signInSubmitButton"], button:has-text("Sign In"), button[type="submit"]');
  for (const btn of signInButtons) {
    if (await btn.isVisible().catch(() => false)) {
      if (await isInNavOrHeader(btn)) continue;
      const autoId = await btn.getAttribute('data-automation-id').catch(() => '');
      const type = await btn.getAttribute('type').catch(() => '');
      if (autoId === 'signInSubmitButton' || type === 'submit') {
        await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
        break;
      }
    }
  }

  await page.waitForTimeout(4000);
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  await page.waitForTimeout(2000);

  if (await isStillOnSignInForm(page)) {
    const reason = await detectLoginFailureReason(page);
    if (reason === 'needs-signup') {
      console.log('    Login failed — account may not exist on this tenant (wrong email/password message).');
      return 'needs-signup';
    }
    if (reason === 'locked') {
      console.log('    Workday reports the account may be locked.');
      return 'locked';
    }
    // Still on sign-in with no recognized error — treat as missing account for this tenant.
    console.log('    Still on Sign In form after submit — will try Create Account fallback.');
    return 'needs-signup';
  }

  const hasError = await page.$('.error-message, [data-automation-id*="error"]').catch(() => null);
  if (hasError && await hasError.isVisible().catch(() => false)) {
    const reason = await detectLoginFailureReason(page);
    if (reason === 'needs-signup') return 'needs-signup';
    if (reason === 'locked') return 'locked';
    return false;
  }

  console.log('   Workday login successful.');
  return true;
}

// ─── Create Workday account ─────────────────────────────────────────────────
export async function workdayCreateAccount(page, email, givenPassword) {
  console.log('   Creating Workday account...');

  // 1. If on two-button page or Sign In tab, click "Create Account" button/link (not nav bar)
  await clickGatewayCreateAccount(page);

  // 2. Wait for create account form to appear
  try {
    await page.waitForSelector('input[data-automation-id="email"], input[type="email"], input[data-automation-id="verifyPassword"]', { timeout: 8000 });
  } catch {}

  const emailInputs = await page.$$('input[data-automation-id="email"], input[type="email"], input[name="email"]');
  for (const inp of emailInputs) {
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(email);
      break;
    }
  }

  const password = givenPassword || generatePassword();
  const pwdInputs = await page.$$('input[data-automation-id="password"], input[type="password"]');
  for (const inp of pwdInputs) {
    if (await inp.isVisible().catch(() => false)) {
      const autoId = await inp.getAttribute('data-automation-id').catch(() => '');
      if (autoId === 'verifyPassword') continue;
      await inp.fill(password);
      break;
    }
  }

  const verifyPwdInput = await page.$('input[data-automation-id="verifyPassword"]');
  if (verifyPwdInput && await verifyPwdInput.isVisible().catch(() => false)) {
    await verifyPwdInput.fill(password);
  }

  const termsCheckbox = await page.$('input[type="checkbox"][data-automation-id*="createAccountCheckbox"], input[type="checkbox"][data-automation-id*="agree"], input[type="checkbox"][name*="agree"], label:has-text("agree") input[type="checkbox"]');
  if (termsCheckbox) {
    const isChecked = await termsCheckbox.isChecked().catch(() => false);
    if (!isChecked) await termsCheckbox.click({ force: true }).catch(() => termsCheckbox.evaluate(el => el.click()));
  }

  const submitBtns = await page.$$('button[data-automation-id="createAccountSubmitButton"], button:has-text("Create Account"), button:has-text("Sign Up"), button[type="submit"]');
  for (const btn of submitBtns) {
    if (await btn.isVisible().catch(() => false)) {
      if (await isInNavOrHeader(btn)) continue;
      const autoId = await btn.getAttribute('data-automation-id').catch(() => '');
      const type = await btn.getAttribute('type').catch(() => '');
      if (autoId === 'createAccountSubmitButton' || type === 'submit') {
        await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
        await page.waitForTimeout(5000);
        try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
        break;
      }
    }
  }

  // Check if account already exists with this email
  const alreadyExists = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /already\s*exists|already\s*registered|please\s*sign\s*in/i.test(text);
  }).catch(() => false);

  if (alreadyExists) {
    console.log('   ℹ️  Account already exists with this email — clicking "Sign In" link below Create Account...');
    await clickGatewaySignIn(page);
    return password;
  }

  // Check for email verification
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/verif|check your email|code was sent/i.test(bodyText) && /email/i.test(bodyText)) {
    console.log(`   Email verification screen appeared — ${MAILBOX_NOT_CONNECTED}`);
  }

  return password;
}

// ─── Detect if page currently shows Sign In inputs ──────────────────────────
export async function isWorkdaySignInPage(page) {
  const url = page.url();
  if (!/workday|myworkday/i.test(url)) return false;

  // 1. Check if application form wizard fields or buttons are visible
  const hasAppFields = await page.$([
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button[data-automation-id="bottom-navigation-next-button"]',
    'input[data-automation-id="legalNameSection_firstName"]',
    'input[data-automation-id="phone-number"]',
    '[data-automation-id*="wizardStep"]',
  ].join(', ')).catch(() => null);

  if (hasAppFields && await hasAppFields.isVisible().catch(() => false)) {
    return false;
  }

  // 2. Check for visible sign-in inputs (email/password fields)
  const pwdInput = await page.$('input[type="password"]:visible, input[data-automation-id="password"]:visible, input[name="password"]:visible').catch(() => null);
  const emailInput = await page.$('input[data-automation-id="email"]:visible, input[data-automation-id="userName"]:visible, input[type="email"]:visible').catch(() => null);
  const signInSubmitBtn = await page.$('button[data-automation-id="signInSubmitButton"]:visible').catch(() => null);

  return !!((pwdInput && emailInput) || (pwdInput && signInSubmitBtn));
}

// ─── Full Workday flow ──────────────────────────────────────────────────────
export async function handleWorkday(page, { email, password, mode = 'signin' } = {}) {
  if (await isWorkdayWizardVisible(page)) {
    console.log('   Already on Workday application form wizard — skipping discovery.');
    return true;
  }

  if (!await isWorkdayLogin(page)) {
    const entry = await ensureWorkdayApplicationWizard(page, { mode });
    if (entry.entered) {
      console.log(`   Entered application wizard (${entry.method}).`);
    }
  }

  if (await isWorkdayWizardVisible(page)) {
    console.log('   Already authenticated on Workday application form.');
    return true;
  }

  if (!await isWorkdayLogin(page)) {
    console.log('   Already authenticated on Workday (pre-wizard page).');
    return true;
  }

  console.log(`   Workday auth mode: "${mode}"`);

  // Mode: "signin" — try login first; on wrong-password / no-account, create account then sign in
  if (mode === 'signin') {
    if (email && password) {
      console.log(`   Logging in to Workday as ${email}...`);
      const loginResult = await workdayLogin(page, email, password);

      if (loginResult === true) {
        return finishSuccessfulLogin(page, mode);
      }

      if (loginResult === 'needs-signup') {
        return fallbackCreateAccountAndLogin(page, {
          email,
          password,
          mode,
        });
      }

      if (loginResult === 'locked') {
        console.log('   ❌ Workday account appears locked — cannot proceed automatically.');
        return false;
      }

      console.log('   ❌ Sign-in failed with provided credentials.');
      return false;
    }
    console.log('   ❌ Missing email or password for Workday signin mode.');
    return false;
  }

  // Mode: "signup" -> call workdayCreateAccount() then workdayLogin()
  if (mode === 'signup') {
    if (email) {
      console.log(`   Creating new Workday account for ${email}...`);
      const newPassword = await workdayCreateAccount(page, email, password);
      if (newPassword) {
        console.log('   Checking page state after account creation...');
        await page.waitForTimeout(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
        await page.waitForTimeout(2000);

        // Page detection step:
        // 1. Check if current page has sign-in form inputs (email, password visible)
        const onSignIn = await isWorkdaySignInPage(page);

        if (onSignIn) {
          // 2. If yes: call workdayLogin with the new email and password, wait for sign-in to complete
          console.log('   Workday redirected to Sign In page — logging in with new credentials...');
          const loggedIn = await workdayLogin(page, email, newPassword);
          if (loggedIn !== true) {
            console.log('   ❌ Sign-in failed after account creation.');
            return false;
          }
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
          console.log('   ✅ Sign-in confirmed after account creation.');
          return finishSuccessfulLogin(page, mode);
        } else {
          // 3. If no: page is already on application form, proceed directly to fillForm
          console.log('   ✅ Page already on application form after account creation — proceeding directly to form.');
          return true;
        }
      }
      console.log('   ❌ Account creation failed in signup mode.');
      return false;
    }
    console.log('   ❌ Missing email for Workday signup mode.');
    return false;
  }

  console.log(`   ❌ Unknown mode "${mode}" or missing credentials.`);
  return false;
}
