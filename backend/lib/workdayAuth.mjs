/**
 * workdayAuth.mjs — Comprehensive Workday Authentication State Machine
 * ====================================================================
 * Robust multi-path authentication engine covering all Workday auth variants:
 *
 *   Path 0:  No-Auth Bypass (Direct redirect to form after clicking "Apply Manually")
 *   Path A:  Direct Login (company email + .env dynamic password -> redirects to form)
 *   Path B:  Account Error / Not Found -> Create Account -> redirects to form
 *   Path C1: Create Account -> redirected to Login -> login -> redirects to form
 *   Path C2: Email Verification Required:
 *            - If @gmail.com: immediately flag "Zoho Mail was not connected" & halt
 *            - If custom domain (@applyres.ai): fetch verification link via Zoho API,
 *              navigate/paste in active browser, refresh, and login
 *   Path D:  Worst-Case: Forgot Password -> submit email -> fetch reset link via Zoho API ->
 *            set new password from .env -> submit -> login -> redirects to form
 *
 * All passwords are dynamically retrieved from environment variables (process.env.WORKDAY_PASSWORD
 * or process.env.USER_PASSWORD). No hardcoded passwords.
 */

import { checkEmailDomainEligibility, fetchWorkdayMailLink } from './zohoMailClient.mjs';
import {
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  isWorkdayPasswordResetSetPage,
  detectWrongPasswordOrLocked,
  completeWorkdayPasswordResetForm,
  sanitizeWorkdayUrl,
} from './workdayVerification.mjs';

/**
 * Checks if the current page has already landed on the Workday wizard/application form.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayApplicationFormVisible(page) {
  try {
    if (!page) return false;
    const url = typeof page.url === 'function' ? page.url().toLowerCase() : '';
    if (url.includes('/apply/') || url.includes('/job-application') || url.includes('/applicationstep') || url.includes('/myinformation')) {
      return true;
    }
    return await page.evaluate(() => {
      const form = document.querySelector(
        '[data-automation-id="applicationStep"], [data-automation-id="formContainer"], [data-automation-id="formContent"], [data-automation-id="progressBar"], [data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]'
      );
      if (form) return true;
      const stepHeaders = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="step" i], [data-automation-id*="heading" i]'));
      const textMatch = stepHeaders.some(h => {
        const t = (h.textContent || '').toLowerCase();
        return t.includes('my information') || t.includes('my experience') || t.includes('application questions') || t.includes('voluntary disclosure') || t.includes('review and submit');
      });
      return textMatch;
    }).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Checks if a Workday login form is currently visible.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayLoginFormVisible(page) {
  try {
    if (!page) return false;
    const emailField = await page.$(
      'input[data-automation-id="email"], input[data-automation-id="username"], input[type="email"], input[name*="email" i], input[id*="email" i]'
    ).catch(() => null);
    if (!emailField) return false;
    return await emailField.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Attempts to submit email & password into the Workday login form.
 * @param {import('playwright').Page} page
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, hadError: boolean, error?: string}>}
 */
async function attemptLogin(page, email, password) {
  try {
    console.log(`   🔑 [WorkdayAuth] Attempting login with: ${email}`);
    const emailInput = page.locator(
      'input[data-automation-id="email"], input[data-automation-id="username"], input[type="email"], input[name*="email" i], input[id*="email" i]'
    ).first();

    if (!await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      return { success: false, hadError: false, error: 'email_field_not_found' };
    }

    await emailInput.fill(email);
    await emailInput.press('Tab');
    await page.waitForTimeout(300);

    const passwordInput = page.locator(
      'input[data-automation-id="password"], input[type="password"], input[name*="password" i], input[id*="password" i]'
    ).first();

    if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await passwordInput.fill(password);
      await passwordInput.press('Enter');
    } else {
      // Split login (Email first, then next screen for password)
      const nextBtn = page.locator(
        'button[data-automation-id="click_filter"], button:has-text("Next"), button:has-text("Continue"), button[type="submit"]'
      ).first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
        const pwd2 = page.locator('input[type="password"]').first();
        if (await pwd2.isVisible({ timeout: 3000 }).catch(() => false)) {
          await pwd2.fill(password);
          await pwd2.press('Enter');
        }
      }
    }

    // Try explicit Sign In button if enter didn't submit
    const signInBtn = page.locator(
      'button[data-automation-id="signInSubmitButton"], button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]'
    ).first();
    if (await signInBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await signInBtn.click().catch(() => {});
    }

    await page.waitForTimeout(3000);
    const hadError = await detectWrongPasswordOrLocked(page);
    return { success: !hadError, hadError };
  } catch (err) {
    return { success: false, hadError: false, error: err.message };
  }
}

/**
 * Attempts to register a new account on Workday.
 * @param {import('playwright').Page} page
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, redirectedToLogin: boolean, error?: string}>}
 */
async function attemptCreateAccount(page, email, password) {
  try {
    console.log(`   📝 [WorkdayAuth] Attempting Create Account for: ${email}`);
    const createBtn = page.locator(
      'a:has-text("Create Account"), button:has-text("Create Account"), a:has-text("Sign Up"), button:has-text("Sign Up"), [data-automation-id="createAccountLink"], [data-automation-id="createAccountButton"]'
    ).first();

    if (!await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      return { success: false, redirectedToLogin: false, error: 'create_account_button_not_found' };
    }

    await createBtn.click();
    await page.waitForTimeout(2000);

    const emailInput = page.locator(
      'input[data-automation-id="email"], input[data-automation-id="username"], input[type="email"]'
    ).first();
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill(email);
      await emailInput.press('Tab');
    }

    const pwdInputs = page.locator('input[type="password"], input[data-automation-id*="password" i]');
    const count = await pwdInputs.count().catch(() => 0);
    if (count > 0) {
      await pwdInputs.first().fill(password);
      await pwdInputs.first().press('Tab');
      if (count > 1) {
        await pwdInputs.nth(1).fill(password);
        await pwdInputs.nth(1).press('Tab');
      }
    }

    // Accept terms/consent checkbox if present
    const consentCheckbox = page.locator(
      'input[type="checkbox"][data-automation-id*="consent" i], input[type="checkbox"][data-automation-id*="agree" i], [data-automation-id*="createAccountConsentCheckbox"]'
    ).first();
    if (await consentCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      const checked = await consentCheckbox.isChecked().catch(() => false);
      if (!checked) await consentCheckbox.check({ force: true }).catch(() => {});
    }

    const submitBtn = page.locator(
      'button[data-automation-id="createAccountSubmitButton"], button[type="submit"], button:has-text("Create Account"), button:has-text("Sign Up")'
    ).first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(3000);

    // Check if redirected to login page
    const loginFormVisible = await isWorkdayLoginFormVisible(page);
    return { success: true, redirectedToLogin: loginFormVisible };
  } catch (err) {
    return { success: false, redirectedToLogin: false, error: err.message };
  }
}

/**
 * Main Workday Authentication Orchestrator.
 * Follows the strict Progression: Path 0 -> Path A -> Path B -> Path C1/C2 -> Path D
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.email - Candidate company email
 * @param {string} [opts.company] - Company name for Zoho Mail subject matching
 * @param {string} [opts.password] - Optional password override (defaults to process.env.WORKDAY_PASSWORD)
 * @returns {Promise<{success: boolean, path: string, reason?: string}>}
 */
export async function executeWorkdayAuth(page, { email, company = '', password = null }) {
  const dynamicPassword = password
    || process.env.WORKDAY_PASSWORD
    || process.env.USER_PASSWORD
    || process.env.APPLYWIZZ_PASSWORD;

  if (!dynamicPassword) {
    throw new Error('[WorkdayAuth] No password configured in environment (WORKDAY_PASSWORD or USER_PASSWORD required).');
  }

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) {
    return { success: false, path: 'none', reason: 'missing_candidate_email' };
  }

  console.log(`\n🚀 [WorkdayAuth] Starting unified auth workflow for ${cleanEmail} (Company: ${company || 'Unknown'})...`);

  // ──────────────────────────────────────────────────────────────────────────
  // PATH 0: No-Auth Detection (Check before and after clicking Apply)
  // ──────────────────────────────────────────────────────────────────────────
  if (await isWorkdayApplicationFormVisible(page)) {
    console.log('   🎉 [WorkdayAuth] Path 0: Direct No-Auth access confirmed — application form already visible.');
    return { success: true, path: 'path_0_no_auth_direct' };
  }

  // Click "Apply" or "Apply Manually" if present on landing page
  const applyBtn = page.locator([
    'a[data-automation-id="adventureButton"]:has-text("Apply Manually")',
    'button[data-automation-id="adventureButton"]:has-text("Apply Manually")',
    'a:has-text("Apply Manually")',
    'button:has-text("Apply Manually")',
    'a[data-automation-id="adventureButton"]',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
  ].join(', ')).first();

  if (await applyBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
    console.log('   👆 [WorkdayAuth] Clicking Apply / Apply Manually...');
    await applyBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);

    // Verify if Apply Manually bypassed auth entirely
    if (await isWorkdayApplicationFormVisible(page)) {
      console.log('   🎉 [WorkdayAuth] Path 0: Bypassed auth via "Apply Manually" directly to form!');
      return { success: true, path: 'path_0_apply_manually_no_auth' };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PATH A: Attempt Direct Login
  // ──────────────────────────────────────────────────────────────────────────
  if (await isWorkdayLoginFormVisible(page)) {
    const loginRes = await attemptLogin(page, cleanEmail, dynamicPassword);
    if (loginRes.success && await isWorkdayApplicationFormVisible(page)) {
      console.log('   🎉 [WorkdayAuth] Path A: Direct login succeeded!');
      return { success: true, path: 'path_a_direct_login' };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PATH B: Account Not Found / Locked / Red Error -> Create Account
  // ──────────────────────────────────────────────────────────────────────────
  const hasError = await detectWrongPasswordOrLocked(page);
  const isVerification = await isWorkdayVerificationPage(page);

  if (!isVerification && (hasError || await isWorkdayLoginFormVisible(page))) {
    console.log('   ⚠️ [WorkdayAuth] Login failed or account error detected. Transitioning to Path B (Create Account)...');
    const createRes = await attemptCreateAccount(page, cleanEmail, dynamicPassword);

    if (await isWorkdayApplicationFormVisible(page)) {
      console.log('   🎉 [WorkdayAuth] Path B: Create account succeeded directly to application form!');
      return { success: true, path: 'path_b_create_account' };
    }

    // PATH C1: Create account redirected back to login form
    if (createRes.redirectedToLogin || await isWorkdayLoginFormVisible(page)) {
      console.log('   🔄 [WorkdayAuth] Path C1: Re-attempting login after account creation...');
      const reLogin = await attemptLogin(page, cleanEmail, dynamicPassword);
      if (reLogin.success && await isWorkdayApplicationFormVisible(page)) {
        console.log('   🎉 [WorkdayAuth] Path C1: Login after account creation succeeded!');
        return { success: true, path: 'path_c1_create_then_login' };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PATH C2: Email Verification Required via Zoho Mail API
  // ──────────────────────────────────────────────────────────────────────────
  if (await isWorkdayVerificationPage(page)) {
    console.log('   📩 [WorkdayAuth] Path C2: Email verification screen detected.');

    // STRICT DOMAIN GUARD: If email ends with @gmail.com, do not poll Zoho
    const domainEligibility = checkEmailDomainEligibility(cleanEmail);
    if (domainEligibility === 'gmail' || domainEligibility === 'not_connected') {
      console.log(`   ❌ [WorkdayAuth] Email domain (${cleanEmail}) is not Zoho connected. Marking as Zoho Mail was not connected.`);
      return {
        success: false,
        path: 'path_c2_email_verification_halted',
        reason: 'Zoho Mail was not connected',
      };
    }

    console.log(`   📡 [WorkdayAuth] Domain ${cleanEmail} is Zoho-connected. Polling Zoho Mail API for ${company || 'Workday'} verification email...`);
    const mailResult = await fetchWorkdayMailLink({
      email: cleanEmail,
      company,
      type: 'verification',
      timeoutMs: 90000,
    });

    if (mailResult.found && mailResult.link) {
      console.log(`   🔗 [WorkdayAuth] Verification link extracted! Navigating to: ${mailResult.link}`);
      await page.goto(mailResult.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      if (await isWorkdayApplicationFormVisible(page)) {
        console.log('   🎉 [WorkdayAuth] Path C2: Email verification link unlocked the application form!');
        return { success: true, path: 'path_c2_zoho_verification_link' };
      }

      // If landing page after verification requires login:
      if (await isWorkdayLoginFormVisible(page)) {
        const postVerLogin = await attemptLogin(page, cleanEmail, dynamicPassword);
        if (postVerLogin.success && await isWorkdayApplicationFormVisible(page)) {
          console.log('   🎉 [WorkdayAuth] Path C2: Logged in successfully after email verification!');
          return { success: true, path: 'path_c2_zoho_verified_then_login' };
        }
      }
    } else if (mailResult.found && mailResult.code) {
      // 6-digit OTP code input
      const codeInput = page.locator('input[data-automation-id*="code" i], input[data-automation-id="verificationCode"]').first();
      if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await codeInput.fill(mailResult.code);
        await codeInput.press('Enter');
        await page.waitForTimeout(3000);
        if (await isWorkdayApplicationFormVisible(page)) {
          return { success: true, path: 'path_c2_zoho_otp_code' };
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PATH D: Worst-Case Fallback - Forgot Password Reset
  // ──────────────────────────────────────────────────────────────────────────
  console.log('   ⚠️ [WorkdayAuth] Primary login/create paths exhausted. Entering Path D: Forgot Password Fallback...');

  const domainEligibility = checkEmailDomainEligibility(cleanEmail);
  if (domainEligibility === 'gmail' || domainEligibility === 'not_connected') {
    return {
      success: false,
      path: 'path_d_forgot_password_aborted',
      reason: 'Zoho Mail was not connected',
    };
  }

  const forgotBtn = page.locator([
    'a[data-automation-id="forgotPasswordLink"]',
    'a:has-text("Forgot Password")',
    'button:has-text("Forgot Password")',
    'a:has-text("Forgot password")',
    'button:has-text("Forgot password")',
  ].join(', ')).first();

  if (await forgotBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await forgotBtn.click();
    await page.waitForTimeout(2000);

    const emailForgotInput = page.locator(
      'input[data-automation-id="email"], input[type="email"], input[name*="email" i]'
    ).first();

    if (await emailForgotInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailForgotInput.fill(cleanEmail);
      await emailForgotInput.press('Tab');

      const submitResetBtn = page.locator(
        'button[data-automation-id="resetPasswordButton"], button[type="submit"], button:has-text("Submit"), button:has-text("Reset")'
      ).first();
      if (await submitResetBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitResetBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      console.log('   📨 [WorkdayAuth] Password reset requested. Polling Zoho Mail for reset link...');
      await page.waitForTimeout(3000);

      const resetResult = await fetchWorkdayMailLink({
        email: cleanEmail,
        company,
        type: 'reset',
        timeoutMs: 120000,
      });

      if (resetResult.found && resetResult.link) {
        console.log(`   🔗 [WorkdayAuth] Navigating to password reset link: ${resetResult.link}`);
        await page.goto(resetResult.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const resetSuccess = await completeWorkdayPasswordResetForm(page, cleanEmail, dynamicPassword);
        if (resetSuccess) {
          await page.waitForTimeout(2500);
          if (await isWorkdayApplicationFormVisible(page)) {
            console.log('   🎉 [WorkdayAuth] Path D: Password reset completed and redirected to application form!');
            return { success: true, path: 'path_d_password_reset_direct' };
          }
          // If redirected to login form
          if (await isWorkdayLoginFormVisible(page)) {
            const afterResetLogin = await attemptLogin(page, cleanEmail, dynamicPassword);
            if (afterResetLogin.success && await isWorkdayApplicationFormVisible(page)) {
              console.log('   🎉 [WorkdayAuth] Path D: Logged in with new password after reset!');
              return { success: true, path: 'path_d_password_reset_then_login' };
            }
          }
        }
      }
    }
  }

  // Final check if somehow on application form
  if (await isWorkdayApplicationFormVisible(page)) {
    return { success: true, path: 'fallback_application_form_visible' };
  }

  return {
    success: false,
    path: 'all_auth_paths_exhausted',
    reason: 'Could not authenticate via direct login, create account, verification link, or password reset',
  };
}

