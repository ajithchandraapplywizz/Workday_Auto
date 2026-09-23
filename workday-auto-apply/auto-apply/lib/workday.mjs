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
  extractWorkdayCompanyName,
} from './discovery.mjs';
import {
  resolveWorkdayVerification,
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  isWorkdayPasswordResetSetPage,
  completeWorkdayPasswordResetForm,
  detectWrongPasswordOrLocked,
  executeWorkdayForgotPassword,
} from './workdayVerification.mjs';

export {
  resolveWorkdayVerification,
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  isWorkdayPasswordResetSetPage,
  completeWorkdayPasswordResetForm,
  detectWrongPasswordOrLocked,
  executeWorkdayForgotPassword,
};

const MAILBOX_NOT_CONNECTED =
  'Mailbox OTP is not connected (Zoho Mail can be added later). Login is email + password only.';

/**
 * Classify a failed Workday login attempt from visible page text.
 * @param {import('playwright').Page} page
 * @returns {Promise<'needs-verification'|'wrong-password-or-locked'|'locked'|'needs-signup'|'unknown'>}
 */
async function detectLoginFailureReason(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    // 1. Explicit account lockout messages
    if (
      text.includes('account has been locked') ||
      text.includes('account is locked due to') ||
      text.includes('your account is temporarily locked') ||
      text.includes('too many failed attempts')
    ) {
      return 'locked';
    }
    // 2. Explicit email verification screens or unverified account messages
    if (
      (text.includes('verification email') && text.includes('sent')) ||
      text.includes('check your spam folder') ||
      text.includes('check your email') ||
      text.includes('we sent a verification link') ||
      text.includes('we sent a verification code') ||
      text.includes('need to be verified') ||
      text.includes('needs to be verified') ||
      text.includes('need to be activated') ||
      text.includes('needs to be activated') ||
      text.includes('activate your account') ||
      text.includes('account requires email verification') ||
      text.includes('verify your email')
    ) {
      return 'needs-verification';
    }
    // 3. Wrong password or account might be locked
    if (
      text.includes('invalid user name or password') ||
      text.includes('invalid username or password') ||
      text.includes('or your account might be locked') ||
      text.includes('account might be locked') ||
      text.includes('wrong password') ||
      text.includes('incorrect password') ||
      text.includes('invalid password')
    ) {
      return 'wrong-password-or-locked';
    }
    // All other login failures -> attempt signup fallback
    return 'needs-signup';
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
 * @returns {Promise<boolean>}
 */
async function finishSuccessfulLogin(page, mode, profile = null) {
  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  // 1. Recover immediately if Workday displays transient "Something went wrong"
  let bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/something went wrong|please refresh the page|error code:\s*i\|/i.test(bodyText)) {
    console.log('   🔄 Workday post-login transient error detected ("Something went wrong") — refreshing page to recover application form...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  }

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
    await ensureWorkdayApplicationWizard(page, { mode, profile });
  } else if (!continued) {
    await clickContinueApplicationIfPresent(page);
  }

  if (await isWorkdayWizardVisible(page)) {
    console.log('   ✅ Successfully verified on application wizard.');
    return true;
  }

  // 2. Final recovery attempt: reload if still not confirmed (e.g. stalled hydration)
  bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/something went wrong|please refresh the page|error code:\s*i\|/i.test(bodyText) || !await isWorkdayWizardVisible(page)) {
    console.log('   🔄 Wizard not confirmed post-login — refreshing page once to trigger hydration...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

    if (await isWorkdayWizardVisible(page)) {
      console.log('   ✅ Successfully verified on application wizard after reload.');
      return true;
    }
  }

  const onWizard = await isWorkdayWizardVisible(page);
  if (onWizard) {
    console.log('   ✅ Successfully verified on application wizard.');
    return true;
  }

  console.log('   ⚠️  Post-login navigation completed but application wizard not confirmed.');
  return false;
}

/**
 * Create account on this tenant, then sign in (or continue if already on the form).
 * @param {import('playwright').Page} page
 * @param {{ email: string, password: string, mode?: string }} opts
 * @returns {Promise<boolean>}
 */
async function fallbackCreateAccountAndLogin(page, { email, password, mode = 'signin', profile = null }) {
  console.log('   No account on this tenant — clicking Create Account and registering...');
  const createdPassword = await workdayCreateAccount(page, email, password);
  if (!createdPassword) {
    console.log('   ❌ Account creation failed during signin fallback.');
    return false;
  }

  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  await page.waitForTimeout(2000);

  // 1. Check if already entered wizard
  if (await isWorkdayWizardVisible(page)) {
    console.log('   ✅ Successfully entered application wizard after account creation.');
    return true;
  }

  const company = extractWorkdayCompanyName(page.url());

  // 2. If the account was detected as already existing, attempt sign in or trigger forgot password
  if (page._accountAlreadyExists) {
    console.log('   🔐 Account already exists on this tenant — attempting sign in with credentials...');
    await handleAdaptiveGateway(page, 'signin');
    const directLogin = await workdayLogin(page, email, createdPassword);
    if (directLogin === true) {
      return finishSuccessfulLogin(page, mode, profile);
    }
    if (await isWorkdayWizardVisible(page)) {
      return true;
    }

    // Login on existing account failed (wrong password or locked) -> launch automated Forgot Password flow
    console.log('   📩 Existing account password mismatched or locked — launching automated Forgot Password recovery via Zoho Mail...');
    const effectivePassword = createdPassword || password || process.env.WORKDAY_PASSWORD;
    const forgotResult = await executeWorkdayForgotPassword(page, {
      email,
      password: effectivePassword,
      company,
      timeoutMs: 75000,
    });

    if (forgotResult?.success) {
      console.log('   ✅ Forgot Password recovery succeeded! Logging in / verifying wizard entry...');
      await page.waitForTimeout(3000);
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

      if (forgotResult.onWizard || await isWorkdayWizardVisible(page)) {
        console.log('   ✅ Application wizard active post-password reset!');
        return true;
      }
      await handleAdaptiveGateway(page, 'signin');
      const postResetLogin = await workdayLogin(page, email, effectivePassword);
      if (postResetLogin === true) {
        return finishSuccessfulLogin(page, mode, profile);
      }
      if (await isWorkdayWizardVisible(page)) {
        return true;
      }
    }
  }

  // 3. Resolve email verification
  // Workday account creation sends an activation link or OTP to the applicant's email.
  const isVerifPage = await isWorkdayVerificationPage(page);
  console.log(`   ${isVerifPage ? '📩 Workday page requires email verification.' : '⏳ Newly registered Workday account — polling Zoho Mail Reader for verification link/OTP...'}`);
  const verified = await resolveWorkdayVerification(page, {
    email,
    password: createdPassword,
    company,
    startTime: page._lastRegistrationTime || (Date.now() - 60000),
    timeoutMs: 60000,
  }).catch((err) => {
    console.warn(`   ⚠️  [WorkdayBot] Verification poll note: ${err.message}`);
    return null;
  });

  if (verified?.success) {
    console.log('   ✅ Email verification resolved! Proceeding to application / login...');
    await page.waitForTimeout(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

    if (await isWorkdayWizardVisible(page)) {
      console.log('   ✅ Successfully entered application wizard after verification.');
      return true;
    }

    await handleAdaptiveGateway(page, 'signin');
    const loggedIn = await workdayLogin(page, email, createdPassword);
    if (loggedIn === true) {
      return finishSuccessfulLogin(page, mode, profile);
    }
    if (await isWorkdayWizardVisible(page)) {
      return true;
    }
  }

  // 4. If verification was not needed/pending or redirected to Sign In, attempt login
  console.log('   Workday redirected to Sign In / Gateway — logging in with registered credentials...');
  await handleAdaptiveGateway(page, 'signin');
  const loggedIn = await workdayLogin(page, email, createdPassword);
  if (loggedIn === true) {
    return finishSuccessfulLogin(page, mode, profile);
  }

  if (loggedIn === 'needs-verification') {
    console.log('   📩 Workday reports account requires email verification. Polling Zoho Mail Reader...');
    const retryVerified = await resolveWorkdayVerification(page, {
      email,
      password: createdPassword,
      company,
      startTime: page._lastRegistrationTime || (Date.now() - 60000),
      timeoutMs: 60000,
    }).catch(() => null);

    if (retryVerified?.success) {
      console.log('   ✅ Email verification completed on retry! Logging in...');
      await handleAdaptiveGateway(page, 'signin');
      const retryLogin = await workdayLogin(page, email, createdPassword);
      if (retryLogin === true) {
        return finishSuccessfulLogin(page, mode, profile);
      }
    }
  }

  // 5. If login failed due to wrong password, mismatched credentials, or account lockout:
  const isWrongOrLocked = (loggedIn === 'wrong-password-or-locked' || loggedIn === 'locked' || page._accountAlreadyExists || await detectWrongPasswordOrLocked(page));
  if (isWrongOrLocked) {
    console.log('   🔐 Password invalid or account locked after registration/switch — initiating automated Forgot Password recovery via Zoho Mail...');
    const effectivePassword = createdPassword || password || process.env.WORKDAY_PASSWORD;
    const forgotResult = await executeWorkdayForgotPassword(page, {
      email,
      password: effectivePassword,
      company,
      timeoutMs: 75000,
    });

    if (forgotResult?.success) {
      console.log('   ✅ Forgot Password recovery succeeded! Verifying entry into application wizard...');
      await page.waitForTimeout(3000);
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

      if (forgotResult.onWizard || await isWorkdayWizardVisible(page)) {
        console.log('   ✅ Application wizard active post-password reset!');
        return true;
      }
      await handleAdaptiveGateway(page, 'signin');
      const postResetLogin = await workdayLogin(page, email, effectivePassword);
      if (postResetLogin === true) {
        return finishSuccessfulLogin(page, mode, profile);
      }
      if (await isWorkdayWizardVisible(page)) {
        return true;
      }
    }
  }

  if (await isWorkdayWizardVisible(page)) {
    return true;
  }

  console.log('   ❌ Unable to enter application form after account creation and login attempt.');
  return false;
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
    scan.hasSignInUnderCreateAccount ||
    scan.hasForgotPasswordBtn ||
    scan.hasResetPasswordBtn
  );
}

// ─── Login to Workday ───────────────────────────────────────────────────────
/**
 * @returns {Promise<true|'needs-signup'|'locked'|false>}
 */
export async function workdayLogin(page, email, password) {
  console.log('   Logging into Workday...');

  // 0. Safety Net: If on Password Reset Form, complete password reset first
  if (typeof isWorkdayPasswordResetSetPage === 'function' && await isWorkdayPasswordResetSetPage(page)) {
    console.log('   🔑 [WorkdayBot] Active Password Reset form detected on login entry — setting new password and submitting form...');
    await completeWorkdayPasswordResetForm(page, email, password);
    await page.waitForTimeout(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

    if (await isWorkdayWizardVisible(page)) {
      console.log('   ✅ [WorkdayBot] Entered application wizard directly after password reset.');
      return true;
    }
  }

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
    return false;
  }

  // 5. Click visible Sign In submit button with force: true (excluding nav header)
  const signInButtons = await page.$$([
    'button[data-automation-id="signInSubmitButton"]',
    'button[type="submit"]',
    'button:has-text("Sign In")'
  ].join(', '));
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
    if (reason === 'needs-verification') {
      console.log('    ⚠️  Workday reports account requires email verification before signing in.');
      return 'needs-verification';
    }
    if (reason === 'locked') {
      console.log('    Workday reports the account may be locked.');
      return 'locked';
    }
    if (reason === 'wrong-password-or-locked') {
      console.log('    Workday reports invalid username/password or account might be locked.');
      return 'wrong-password-or-locked';
    }
    if (reason === 'needs-signup') {
      console.log('    Login failed — account may not exist on this tenant (wrong email/password message).');
      return 'needs-signup';
    }
    // Still on sign-in with no recognized error — treat as missing account for this tenant.
    console.log('    Still on Sign In form after submit — will try Create Account fallback.');
    return 'needs-signup';
  }

  const hasError = await page.$('.error-message, [data-automation-id*="error"]').catch(() => null);
  if (hasError && await hasError.isVisible().catch(() => false)) {
    const reason = await detectLoginFailureReason(page);
    if (reason === 'needs-verification') {
      console.log('    ⚠️  Workday reports account requires email verification before signing in.');
      return 'needs-verification';
    }
    if (reason === 'locked') return 'locked';
    if (reason === 'wrong-password-or-locked') return 'wrong-password-or-locked';
    if (reason === 'needs-signup') return 'needs-signup';
    return false;
  }

  console.log('   Workday login successful.');
  return true;
}

// ─── Create Workday account ─────────────────────────────────────────────────
export async function workdayCreateAccount(page, email, givenPassword) {
  console.log('   Creating Workday account...');

  // 1. If on two-button page, Social SSO, or Sign In tab, click "Create Account" button/link (not nav bar)
  await clickGatewayCreateAccount(page);

  // 2. Wait explicitly for create account form (verifyPassword input) to appear
  try {
    await page.waitForSelector('input[data-automation-id="verifyPassword"]:visible', { timeout: 8000 });
  } catch {}

  const verifyVisible = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  if (!verifyVisible) {
    await clickGatewayCreateAccount(page);
    try {
      await page.waitForSelector('input[data-automation-id="verifyPassword"]:visible', { timeout: 5000 });
    } catch {}
  }

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

  const submitBtns = await page.$$([
    'button[data-automation-id="createAccountSubmitButton"]',
    'button:has-text("Create Account")',
    'button[type="submit"]'
  ].join(', '));

  let submitted = false;
  for (const btn of submitBtns) {
    if (await btn.isVisible().catch(() => false)) {
      if (await isInNavOrHeader(btn)) continue;
      const registrationTime = Date.now();
      page._lastRegistrationTime = registrationTime - 30000;
      await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
      submitted = true;
      await page.waitForTimeout(4000);
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      break;
    }
  }

  if (!submitted) {
    console.log('   ❌ Could not submit Create Account form.');
    return null;
  }

  // Check if an error banner or message explicitly states the account already exists
  const alreadyExists = await page.evaluate(() => {
    const errorEl = document.querySelector('.error-message, [data-automation-id*="error" i], [role="alert"]');
    if (!errorEl) return false;
    const text = (errorEl.textContent || '').toLowerCase();
    return (
      text.includes('already exists') ||
      text.includes('already registered') ||
      text.includes('an account with this email') ||
      text.includes('user already exists')
    );
  }).catch(() => false);

  if (alreadyExists) {
    console.log('   ℹ️  Account already exists with this email (error alert detected) — switching to Sign In...');
    page._accountAlreadyExists = true;
    await clickGatewaySignIn(page);
    return password;
  }

  // Check for email verification
  if (await isWorkdayVerificationPage(page)) {
    console.log(`   📩 Workday account created for ${email}, tenant requires email verification.`);
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
  ].join(', ')).catch(() => null);

  if (hasAppFields && await hasAppFields.isVisible().catch(() => false)) {
    return false;
  }

  // 2. Check for visible sign-in inputs (email/password fields)
  const pwdInput = await page.$('input[type="password"]:visible, input[data-automation-id="password"]:visible, input[name="password"]:visible').catch(() => null);
  const emailInput = await page.$('input[data-automation-id="email"]:visible, input[data-automation-id="userName"]:visible, input[type="email"]:visible').catch(() => null);
  const signInSubmitBtn = await page.$('button[data-automation-id="signInSubmitButton"]:visible').catch(() => null);
  const ssoBtn = await page.$('button[data-automation-id="SignInWithEmailButton"]:visible, button:has-text("Sign in with email"):visible').catch(() => null);

  return !!((pwdInput && emailInput) || (pwdInput && signInSubmitBtn) || ssoBtn);
}

// ─── Full Workday flow ──────────────────────────────────────────────────────
export async function handleWorkday(page, { email, password, mode = 'signin', profile = null } = {}) {
  if (await isWorkdayWizardVisible(page)) {
    console.log('   Already on Workday application form wizard — skipping discovery.');
    return true;
  }

  if (!await isWorkdayLogin(page)) {
    const entry = await ensureWorkdayApplicationWizard(page, { mode, profile });
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
        return finishSuccessfulLogin(page, mode, profile);
      }

      if (loginResult === 'locked' || loginResult === 'wrong-password-or-locked') {
        console.log('   🔒 Workday reports invalid credentials or account locked — initiating automated Forgot Password recovery via Zoho Mail...');
        const company = extractWorkdayCompanyName(page.url());
        const forgotSuccess = await executeWorkdayForgotPassword(page, {
          email,
          password,
          company,
          timeoutMs: 75000,
        });

        if (forgotSuccess?.success) {
          console.log('   ✅ Password reset completed for locked account! Verifying session...');
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

          if (await isWorkdayWizardVisible(page)) {
            return true;
          }
          await handleAdaptiveGateway(page, 'signin');
          const relogin = await workdayLogin(page, email, password);
          if (relogin === true) {
            return finishSuccessfulLogin(page, mode, profile);
          }
          if (await isWorkdayWizardVisible(page)) {
            return true;
          }
        }
      }

      if (loginResult === 'needs-verification') {
        console.log('   📩 Workday reports account requires email verification. Resolving via Zoho Mail Reader...');
        const company = extractWorkdayCompanyName(page.url());
        const verified = await resolveWorkdayVerification(page, {
          email,
          password,
          company,
          startTime: Date.now() - 300000,
        }).catch((err) => {
          console.warn(`   ⚠️  [WorkdayBot] Verification failed: ${err.message}`);
          return null;
        });

        if (verified?.success) {
          console.log('   ✅ Email verification resolved! Logging in...');
          await handleAdaptiveGateway(page, 'signin');
          const relogin = await workdayLogin(page, email, password);
          if (relogin === true) {
            return finishSuccessfulLogin(page, mode, profile);
          }
        }
      }

      // If signin was not successful (account does not exist on this tenant, wrong credentials, etc.)
      // Fall back to Create Account as per workflow: if account not found/logged in, create account and proceed
      console.log('   ℹ️  Sign-in not completed with existing credentials — falling back to Create Account...');
      return fallbackCreateAccountAndLogin(page, {
        email,
        password,
        mode,
        profile,
      });
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

        if (await isWorkdayWizardVisible(page)) {
          console.log('   ✅ Already on application form wizard after account creation.');
          return true;
        }

        const isVerif = await isWorkdayVerificationPage(page);
        console.log(`   ${isVerif ? '📩 Workday account created, tenant requires email verification.' : '⏳ Newly registered Workday account — polling Zoho Mail Reader for verification link/OTP...'}`);
        const company = extractWorkdayCompanyName(page.url());
        const verified = await resolveWorkdayVerification(page, {
          email,
          company,
          startTime: page._lastRegistrationTime || (Date.now() - 30000),
          timeoutMs: isVerif ? 60000 : 35000,
        }).catch((err) => {
          console.warn(`   ⚠️  [WorkdayBot] Verification poll note: ${err.message}`);
          return null;
        });

        if (verified?.success) {
          console.log('   ✅ Email verification resolved! Proceeding to application / login...');
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

          if (await isWorkdayWizardVisible(page)) {
            console.log('   ✅ Already on application form wizard after verification.');
            return true;
          }

          await handleAdaptiveGateway(page, 'signin');
          const loggedIn = await workdayLogin(page, email, newPassword);
          if (loggedIn === true) {
            return finishSuccessfulLogin(page, mode);
          }
          if (await isWorkdayWizardVisible(page)) {
            return true;
          }
        }

        console.log('   Workday redirected to Sign In / Gateway — logging in with new credentials...');
        await handleAdaptiveGateway(page, 'signin');
        const loggedIn = await workdayLogin(page, email, newPassword);
        if (loggedIn === true) {
          return finishSuccessfulLogin(page, mode, profile);
        }

        if (loggedIn === 'needs-verification') {
          console.log('   📩 Workday reports account requires email verification. Polling Zoho Mail Reader...');
          const retryVerified = await resolveWorkdayVerification(page, {
            email,
            password: newPassword,
            company,
            startTime: page._lastRegistrationTime || (Date.now() - 60000),
            timeoutMs: 60000,
          }).catch(() => null);

          if (retryVerified?.success) {
            console.log('   ✅ Email verification completed on retry! Logging in...');
            await handleAdaptiveGateway(page, 'signin');
            const retryLogin = await workdayLogin(page, email, newPassword);
            if (retryLogin === true) {
              return finishSuccessfulLogin(page, mode, profile);
            }
          }
        }

        // If login failed due to wrong password, mismatched credentials, or account lockout:
        const isWrongOrLocked = (loggedIn === 'wrong-password-or-locked' || loggedIn === 'locked' || page._accountAlreadyExists || await detectWrongPasswordOrLocked(page));
        if (isWrongOrLocked) {
          console.log('   🔐 Account already exists or locked in signup mode — initiating automated Forgot Password recovery via Zoho Mail...');
          const forgotSuccess = await executeWorkdayForgotPassword(page, {
            email,
            password: newPassword,
            company,
            timeoutMs: 75000,
          });

          if (forgotSuccess?.success) {
            console.log('   ✅ Forgot Password recovery completed! Verifying application wizard...');
            await page.waitForTimeout(3000);
            try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

            if (await isWorkdayWizardVisible(page)) {
              return true;
            }
            await handleAdaptiveGateway(page, 'signin');
            const postResetLogin = await workdayLogin(page, email, newPassword);
            if (postResetLogin === true) {
              return finishSuccessfulLogin(page, mode, profile);
            }
            if (await isWorkdayWizardVisible(page)) {
              return true;
            }
          }
        }

        if (await isWorkdayWizardVisible(page)) {
          return true;
        }

        console.log('   ❌ Unable to enter application form after account creation.');
        return false;
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
