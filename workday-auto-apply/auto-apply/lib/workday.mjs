/**
 * workday.mjs — Workday account creation & login
 *
 * Workday requires an account to apply. This module:
 * 1. Detects Workday login page
 * 2. Creates account (or logs in if credentials exist)
 * 3. Fills email + auto-generates password
 * 4. Handles email verification for account
 * 5. Navigates to the application form
 */

import {
  discoverApplicationForm,
  isInNavOrHeader,
  isSignInFormVisible,
  clickGatewaySignIn,
  clickGatewayCreateAccount,
  prescanGatewayElements,
  handleAdaptiveGateway,
} from './discovery.mjs';

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

  const stillHasPasswordInput = await page.$('input[type="password"]:visible, input[data-automation-id="password"]:visible').catch(() => null);
  const stillOnLogin = stillHasPasswordInput || await page.$('.error-message, [data-automation-id*="error"]').catch(() => null);

  if (stillOnLogin) {
    console.log('    Workday login with existing credentials failed or account does not exist.');
    return false;
  }

  console.log('   Workday login successful.');
  return true;
}

// ─── Create Workday account ─────────────────────────────────────────────────
export async function workdayCreateAccount(page, email, otpEmail, otpPassword, givenPassword) {
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
  const pwdInput = await page.$('input[data-automation-id="password"], input[type="password"]');
  if (pwdInput && await pwdInput.isVisible().catch(() => false)) await pwdInput.fill(password);

  const verifyPwdInput = await page.$('input[data-automation-id="verifyPassword"]');
  if (verifyPwdInput && await verifyPwdInput.isVisible().catch(() => false)) await verifyPwdInput.fill(password);

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
  if (/verif|confirm|code|check your email/i.test(bodyText)) {
    console.log('   Email verification required for account — OTP auto-handling is disabled. Please verify manually if required.');
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
export async function handleWorkday(page, { email, password, otpEmail, otpPassword, mode = 'signin' } = {}) {
  // Check if already on application form wizard before doing any discovery
  const isAlreadyOnWizard = await page.$([
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button[data-automation-id="bottom-navigation-next-button"]',
    'input[data-automation-id="legalNameSection_firstName"]',
    'input[data-automation-id="phone-number"]',
    '[data-automation-id*="wizardStep"]',
  ].join(', ')).catch(() => null);

  if (isAlreadyOnWizard && await isAlreadyOnWizard.isVisible().catch(() => false)) {
    console.log('   Already on Workday application form wizard — skipping discovery.');
    return true;
  }

  if (!await isWorkdayLogin(page)) {
    await discoverApplicationForm(page, page.url(), { mode });
  }

  // If already past login and on form/wizard, authentication is already confirmed
  if (!await isWorkdayLogin(page)) {
    console.log('   Already authenticated on Workday application form.');
    return true;
  }

  console.log(`   Workday auth mode: "${mode}"`);

  // Mode: "signin" -> call workdayLogin() only (skip workdayCreateAccount)
  if (mode === 'signin') {
    if (email && password) {
      console.log(`   Logging in to Workday as ${email}...`);
      const loggedIn = await workdayLogin(page, email, password);
      if (loggedIn) {
        await page.waitForTimeout(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

        // Check if after sign-in we are back on JD page with Apply button visible
        const hasApplyBtn = await page.$([
          'a[data-automation-id="adventureButton"]',
          'a[data-automation-id="applyButton"]',
          'button[data-automation-id="applyButton"]',
          '[data-automation-id="jobPostingApplyButton"]',
          'a:has-text("Apply for this job")',
          'button:has-text("Apply for this job")',
        ].join(', ')).catch(() => null);

        if (hasApplyBtn && await hasApplyBtn.isVisible().catch(() => false)) {
          console.log('   Logged in, on JD page — clicking Apply to enter application wizard...');
          await discoverApplicationForm(page, page.url(), { mode });
        }

        return true;
      }
      console.log('   ❌ Sign-in failed with provided credentials in signin mode.');
      return false;
    }
    console.log('   ❌ Missing email or password for Workday signin mode.');
    return false;
  }

  // Mode: "signup" -> call workdayCreateAccount() then workdayLogin()
  if (mode === 'signup') {
    if (email) {
      console.log(`   Creating new Workday account for ${email}...`);
      const newPassword = await workdayCreateAccount(page, email, otpEmail, otpPassword, password);
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
          if (!loggedIn) {
            console.log('   ❌ Sign-in failed after account creation.');
            return false;
          }
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
          console.log('   ✅ Sign-in confirmed after account creation.');
          return true;
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
