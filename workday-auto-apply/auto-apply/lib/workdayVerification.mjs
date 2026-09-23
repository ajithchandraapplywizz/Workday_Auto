/**
 * workdayVerification.mjs — Automated Workday Email Verification & Password Recovery via ZOHO_MAIL_READER
 *
 * Polls the local Zoho Mail Reader microservice for Workday activation/reset links or OTP codes,
 * navigates or fills them in the active Playwright browser session, and activates the account.
 */

import { extractWorkdayCompanyName } from './discovery.mjs';

/**
 * Cleans and sanitizes a Workday URL, stripping away any unwanted surrounding text,
 * HTML/markdown remnants, quotes, brackets, angle brackets, or trailing punctuation.
 * Guarantees a pure, valid URL string to paste and run directly in the current active browser.
 * 
 * @param {string} raw
 * @returns {string|null}
 */
export function sanitizeWorkdayUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  // Strip any wrapping quotes, brackets, angle brackets
  url = url.replace(/^["'`<\(\[\{]+|["'`>\)\]\}]+$/g, '');
  // Extract strictly the http/https URL part if unwanted leading/trailing text exists
  const match = url.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return null;
  url = match[0];
  // Iteratively strip trailing punctuation often attached in plain text emails
  while (/[.,;:!?)>"']$/.test(url)) {
    url = url.slice(0, -1);
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Checks if the current page indicates that email verification is required.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayVerificationPage(page) {
  try {
    if (page && typeof page.$ === 'function') {
      const hasVerificationInput = await page.$([
        'input[data-automation-id="verificationCode"]',
        'input[data-automation-id*="code" i]:visible',
        'input[data-automation-id*="verification" i]:visible',
        'button[data-automation-id*="resend" i]:visible',
        'button:has-text("Resend email"):visible',
        'button:has-text("Resend code"):visible',
      ].join(', ')).catch(() => null);

      if (hasVerificationInput) return true;
    }

    if (page && typeof page.evaluate === 'function') {
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
      return (
        bodyText.includes('verify your account') ||
        bodyText.includes('verify your email') ||
        bodyText.includes('verify email') ||
        bodyText.includes('verification email') ||
        bodyText.includes('verification code') ||
        bodyText.includes('account may need verification') ||
        bodyText.includes('need to be verified') ||
        bodyText.includes('need to be activated') ||
        bodyText.includes('activate your account') ||
        bodyText.includes('activate account') ||
        bodyText.includes('activation link') ||
        bodyText.includes('confirm your email') ||
        bodyText.includes('confirm your account') ||
        bodyText.includes('check your email') ||
        bodyText.includes('check your inbox') ||
        bodyText.includes('check your spam') ||
        bodyText.includes('we sent an email') ||
        bodyText.includes('we sent a verification') ||
        bodyText.includes('an email has been sent') ||
        bodyText.includes("we've sent an email") ||
        bodyText.includes('email was sent') ||
        bodyText.includes('a message has been sent') ||
        bodyText.includes('instructions have been sent') ||
        bodyText.includes('instructions were sent') ||
        bodyText.includes('validate your email') ||
        bodyText.includes('validate your account') ||
        bodyText.includes('enter the code') ||
        bodyText.includes('enter code') ||
        bodyText.includes('code was sent')
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks if the current page is on the Workday Forgot Password form.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayForgotPasswordPage(page) {
  try {
    if (page && typeof page.$ === 'function') {
      const resetBtn = await page.$('button[data-automation-id="resetPasswordButton"]:visible').catch(() => null);
      if (resetBtn) return true;
    }
    if (page && typeof page.evaluate === 'function') {
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
      return (
        bodyText.includes('forgot password') &&
        (bodyText.includes('reset password') || bodyText.includes('instructions to reset'))
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detects whether Workday displays an invalid password, wrong credentials, or account locked message.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function detectWrongPasswordOrLocked(page) {
  try {
    if (!page || typeof page.evaluate !== 'function') return false;
    return await page.evaluate(() => {
      // 1. Error banners or alert boxes
      const errorEls = Array.from(document.querySelectorAll(
        '.error-message, [data-automation-id*="error" i], [role="alert"], [data-uxi-element-id*="error" i], .css-1q2092k, .css-14pfav7'
      ));
      for (const el of errorEls) {
        const txt = (el.textContent || '').toLowerCase();
        if (
          txt.includes('invalid user name or password') ||
          txt.includes('invalid username or password') ||
          txt.includes('or your account might be locked') ||
          txt.includes('account might be locked') ||
          txt.includes('account has been locked') ||
          txt.includes('account is locked') ||
          txt.includes('temporarily locked') ||
          txt.includes('too many failed attempts') ||
          txt.includes('wrong password') ||
          txt.includes('incorrect password') ||
          txt.includes('invalid password') ||
          txt.includes('unable to sign in') ||
          txt.includes('cannot sign in')
        ) {
          return true;
        }
      }

      // 2. Body text check
      const body = (document.body?.innerText || '').toLowerCase();
      return (
        body.includes('invalid user name or password') ||
        body.includes('invalid username or password') ||
        body.includes('or your account might be locked') ||
        body.includes('account might be locked') ||
        body.includes('account has been locked') ||
        body.includes('account is locked due to') ||
        body.includes('your account is temporarily locked') ||
        body.includes('too many failed attempts') ||
        body.includes('wrong password') ||
        body.includes('incorrect password')
      );
    }).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Polls ZOHO_MAIL_READER for a Workday verification email and handles either link or OTP code.
 * 
 * @param {import('playwright').Page} page - Active browser page in your bot
 * @param {Object} options
 * @param {string} options.email - The applicant's email address
 * @param {string} [options.password] - Candidate password to set if a password reset / new password form appears
 * @param {string} [options.company] - Company name (e.g. "nvidia", "target")
 * @param {number} [options.startTime] - Timestamp (Date.now()) recorded when request was submitted
 * @param {number} [options.timeoutMs=60000] - Max wait time (default: 60s)
 * @returns {Promise<{ success: boolean, type: 'link'|'code', url?: string, code?: string }>}
 */
export async function resolveWorkdayVerification(page, { email, password, company, startTime, timeoutMs = 60000 }) {
  const cutoff = startTime ? (startTime - 60000) : (Date.now() - 30 * 60 * 1000);
  const pollInterval = 3000; // 3 seconds
  const deadline = Date.now() + timeoutMs;
  const effectiveCompany = company || (page ? extractWorkdayCompanyName(page.url()) : '');

  console.log(`   📧 [WorkdayBot] Waiting for verification email for ${email}${effectiveCompany ? ` (${effectiveCompany})` : ''}...`);

  let notConnectedCount = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollInterval);
    try {
      const zohoHost = process.env.ZOHO_MAIL_READER_HOST || '127.0.0.1';
      const url = new URL(`http://${zohoHost}:5000/api/zoho/workday-verification`);
      url.searchParams.set('email', email);
      if (effectiveCompany) url.searchParams.set('company', effectiveCompany);
      url.searchParams.set('receivedAfter', String(cutoff));

      const res = await fetch(url.toString());
      if (!res.ok) {
        console.warn(`   ⚠️  [WorkdayBot] Mail reader returned HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (data.found) {
        // Case A: Workday sends an Activation Link or Password Reset Link
        if (data.verificationLink) {
          const cleanLink = sanitizeWorkdayUrl(data.verificationLink);
          if (!cleanLink) {
            console.warn(`   ⚠️  [WorkdayBot] Received invalid verification link: ${data.verificationLink}`);
            continue;
          }

          console.log(`   🔗 [WorkdayBot] Captured pure link (stripped of unwanted text): ${cleanLink}`);
          console.log('   🌐 [WorkdayBot] Pasting and executing link directly in CURRENT ACTIVE browser session...');
          // Navigate to the verification link directly in the CURRENT ACTIVE browser session to preserve cookies and login state
          await page.goto(cleanLink, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

          // If link leads to a New Password / Password Reset screen:
          const pwdInputs = (typeof page.$$ === 'function')
            ? await page.$$([
                'input[data-automation-id="newPassword"]:visible',
                'input[data-automation-id="password"]:visible',
                'input[name="newPassword"]:visible',
                'input[name="password"]:visible',
                'input[type="password"]:visible',
              ].join(', ')).catch(() => [])
            : [];

          if (pwdInputs.length > 0 && password) {
            console.log('   🔑 [WorkdayBot] Password setup form detected on verification page — setting new password and confirmation password...');

            // Filter out honeypot fields ('beecatcher', 'website')
            const cleanPwdInputs = [];
            for (const inp of pwdInputs) {
              const autoId = (await inp.getAttribute('data-automation-id').catch(() => '')).toLowerCase();
              const name = (await inp.getAttribute('name').catch(() => '')).toLowerCase();
              if (autoId === 'beecatcher' || name === 'website') continue;
              cleanPwdInputs.push(inp);
            }

            let newPwdInput = null;
            let verifyPwdInput = null;

            // Identify fields by verify/confirm indicators
            for (const inp of cleanPwdInputs) {
              const autoId = (await inp.getAttribute('data-automation-id').catch(() => '')).toLowerCase();
              const name = (await inp.getAttribute('name').catch(() => '')).toLowerCase();
              const placeholder = (await inp.getAttribute('placeholder').catch(() => '')).toLowerCase();
              const aria = (await inp.getAttribute('aria-label').catch(() => '')).toLowerCase();
              const isVerify = autoId.includes('verify') || autoId.includes('confirm') ||
                               name.includes('verify') || name.includes('confirm') ||
                               placeholder.includes('verify') || placeholder.includes('confirm') ||
                               aria.includes('verify') || aria.includes('confirm');
              if (isVerify) {
                verifyPwdInput = inp;
              } else if (!newPwdInput) {
                newPwdInput = inp;
              }
            }

            if (!newPwdInput && cleanPwdInputs.length > 0) newPwdInput = cleanPwdInputs[0];
            if (!verifyPwdInput && cleanPwdInputs.length > 1) verifyPwdInput = cleanPwdInputs[1];

            const typePassword = async (inp, val, label) => {
              if (!inp) return;
              try {
                if (typeof inp.click === 'function') await inp.click().catch(() => {});
                if (typeof inp.fill === 'function') {
                  await inp.fill('').catch(() => {});
                  await inp.fill(val);
                }
                if (typeof inp.dispatchEvent === 'function') {
                  await inp.dispatchEvent('input').catch(() => {});
                  await inp.dispatchEvent('change').catch(() => {});
                }
                if (typeof inp.evaluate === 'function') {
                  await inp.evaluate(el => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                  }).catch(() => {});
                }
                await page.waitForTimeout(200);
                console.log(`   ✍️  [WorkdayBot] Filled ${label}.`);
              } catch (err) {
                console.warn(`   ⚠️  [WorkdayBot] Error filling ${label}:`, err.message);
              }
            };

            await typePassword(newPwdInput, password, 'New Password');

            if (verifyPwdInput && verifyPwdInput !== newPwdInput) {
              await typePassword(verifyPwdInput, password, 'Confirmation Password');
            } else {
              const fallbackVerify = (typeof page.$ === 'function')
                ? await page.$([
                    'input[data-automation-id*="verify" i]:visible',
                    'input[data-automation-id*="confirm" i]:visible',
                    'input[name*="verify" i]:visible',
                    'input[name*="confirm" i]:visible',
                    'input[id*="verify" i]:visible',
                    'input[id*="confirm" i]:visible',
                    'input[placeholder*="verify" i]:visible',
                    'input[aria-label*="verify" i]:visible',
                  ].join(', ')).catch(() => null)
                : null;
              if (fallbackVerify) {
                await typePassword(fallbackVerify, password, 'Confirmation Password (fallback)');
                verifyPwdInput = fallbackVerify;
              }
            }

            // Wait a moment for Workday client-side password validators to update
            await page.waitForTimeout(800);

            // Trigger submit via Enter key on the confirmation field
            if (verifyPwdInput && typeof verifyPwdInput.press === 'function') {
              await verifyPwdInput.press('Enter').catch(() => {});
              await page.waitForTimeout(500);
            }

            // Locate submit button
            const saveBtn = (typeof page.$ === 'function')
              ? await page.$([
                  'button[data-automation-id="changePasswordButton"]:not([disabled])',
                  'button[data-automation-id="resetPasswordButton"]:not([disabled])',
                  'button[data-automation-id="submitButton"]:not([disabled])',
                  'button[type="submit"]:not([disabled])',
                  'button:has-text("Change Password"):not([disabled])',
                  'button:has-text("Reset Password"):not([disabled])',
                  'button:has-text("Submit"):not([disabled])',
                  'button:has-text("Save"):not([disabled])',
                  'button[data-automation-id="changePasswordButton"]',
                  'button[data-automation-id="resetPasswordButton"]',
                  'button[data-automation-id="submitButton"]',
                  'button:has-text("Change Password")',
                  'button:has-text("Reset Password")',
                  'button:has-text("Save")',
                  'button:has-text("Submit")',
                  'button[type="submit"]',
                ].join(', ')).catch(() => null)
              : null;

            if (saveBtn && await saveBtn.isVisible().catch(() => false)) {
              console.log('   💾 [WorkdayBot] Submitting new password and confirmation on reset form...');
              await saveBtn.click({ force: true }).catch(() => saveBtn.evaluate(el => el.click()));
              await page.waitForTimeout(4000);
              try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
            }

            // Post-reset step 1: Click any "Sign In", "Continue", or "Done" button that appears
            const postActionBtn = (typeof page.$ === 'function')
              ? await page.$([
                  'button[data-automation-id*="signIn" i]:visible',
                  'a[data-automation-id*="signIn" i]:visible',
                  'button:has-text("Sign In"):visible',
                  'a:has-text("Sign In"):visible',
                  'button:has-text("Continue"):visible',
                  'a:has-text("Continue"):visible',
                  'button:has-text("Log In"):visible',
                  'a:has-text("Log In"):visible',
                  'button:has-text("Done"):visible',
                ].join(', ')).catch(() => null)
              : null;
            if (postActionBtn && await postActionBtn.isVisible().catch(() => false)) {
              console.log('   🔗 [WorkdayBot] Clicking post-reset action button ("Sign In" / "Continue")...');
              await postActionBtn.click({ force: true }).catch(() => postActionBtn.evaluate(el => el.click()));
              await page.waitForTimeout(3000);
              try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
            }

            // Post-reset step 2: If login form appears (Email + Password), automatically fill credentials and submit
            const emailInp = (typeof page.$ === 'function')
              ? await page.$('input[data-automation-id="email"]:visible, input[data-automation-id="userName"]:visible, input[type="email"]:visible, input[name="email"]:visible, input[name="userName"]:visible').catch(() => null)
              : null;
            const pwdInp = (typeof page.$ === 'function')
              ? await page.$('input[data-automation-id="password"]:visible, input[type="password"]:visible, input[name="password"]:visible').catch(() => null)
              : null;
            const submitSignIn = (typeof page.$ === 'function')
              ? await page.$('button[data-automation-id="signInSubmitButton"]:visible, button:has-text("Sign In"):visible, button[type="submit"]:visible').catch(() => null)
              : null;

            if (emailInp && pwdInp && submitSignIn && await submitSignIn.isVisible().catch(() => false)) {
              console.log(`   🔐 [WorkdayBot] Login page appeared after reset — automatically logging in as ${email}...`);
              await emailInp.click().catch(() => {});
              await emailInp.fill(email);
              await page.waitForTimeout(200);
              await pwdInp.click().catch(() => {});
              await pwdInp.fill(password);
              await page.waitForTimeout(200);
              await submitSignIn.click({ force: true }).catch(() => submitSignIn.evaluate(el => el.click()));
              await page.waitForTimeout(4000);
              try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
            }

            // Post-reset step 3: If URL contains a redirect parameter and we haven't entered the wizard yet, navigate directly to destination
            try {
              if (typeof page.url === 'function') {
                const currentUrl = page.url();
                if (currentUrl.includes('passwordreset') && currentUrl.includes('redirect=')) {
                  const u = new URL(currentUrl);
                  const redirectParam = u.searchParams.get('redirect');
                  if (redirectParam) {
                    const targetUrl = new URL(redirectParam, u.origin).toString();
                    console.log(`   🚀 [WorkdayBot] Navigating directly to post-reset redirect destination: ${targetUrl}`);
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
                    await page.waitForTimeout(3000);
                    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
                  }
                }
              }
            } catch {}
          }

          // After activation link loads, check if there is an action button (e.g. "Continue", "Sign In", "Apply")
          if (typeof page.locator === 'function') {
            const actionBtn = page.locator([
              'button:has-text("Continue")',
              'a:has-text("Continue")',
              'button[data-automation-id*="continue" i]',
              'a[data-automation-id*="continue" i]',
              'button:has-text("Sign In")',
              'a:has-text("Sign In")',
              'button[data-automation-id="adventureButton"]',
              'a[data-automation-id="adventureButton"]',
              'button[data-automation-id="jobPostingApplyButton"]',
              'a[data-automation-id="jobPostingApplyButton"]',
            ].join(', ')).first();

            if (await actionBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
              console.log('   🔗 [WorkdayBot] Clicking post-activation action button...');
              await actionBtn.click({ force: true }).catch(() => {});
              await page.waitForTimeout(2000);
              try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
            }
          }

          console.log('   ✅ [WorkdayBot] Successfully verified/activated account and set password in browser session.');
          return { success: true, type: 'link', url: cleanLink };
        }
        // Case B: Workday sends a numeric verification code / PIN
        if (data.verificationCode) {
          console.log(`   🔑 [WorkdayBot] Received verification code: ${data.verificationCode}`);
          // Fill code into the verification input on the current page
          const codeInput = page.locator([
            'input[data-automation-id="verificationCode"]',
            'input[data-automation-id*="code" i]',
            'input[data-automation-id*="verification" i]',
            'input[name="code"]',
            'input[id*="verification" i]',
            'input[type="text"]:visible',
          ].join(', ')).first();

          if (await codeInput.isVisible({ timeout: 4000 }).catch(() => false)) {
            await codeInput.fill(data.verificationCode);
          } else {
            // Fallback: keyboard type
            await page.keyboard.type(data.verificationCode, { delay: 40 });
          }

          const submitBtn = page.locator([
            'button[data-automation-id="submitButton"]',
            'button[data-automation-id*="submit" i]',
            'button[data-automation-id*="verify" i]',
            'button:has-text("Verify")',
            'button:has-text("Submit")',
            'button[type="submit"]',
          ].join(', ')).first();

          if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await submitBtn.click({ force: true });
          } else {
            await page.keyboard.press('Enter');
          }

          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
          return { success: true, type: 'code', code: data.verificationCode };
        }
      } else {
        if (data.reason === 'mailbox_not_connected') {
          notConnectedCount++;
          if (notConnectedCount >= 3) {
            console.log(`   ℹ️  [WorkdayBot] Mailbox ${email} is not connected to Zoho Mail Reader — skipping automated email poll.`);
            return { success: false, reason: 'mailbox_not_connected' };
          }
          console.log(`   ⏳ [WorkdayBot] Mailbox ${email} checking connection... (${notConnectedCount}/3)`);
          continue;
        }
        console.log(`   ⏳ [WorkdayBot] Waiting for email... (${data.reason || 'pending'})`);
      }
    } catch (err) {
      console.warn('   ⚠️  [WorkdayBot] Polling error:', err.message);
    }
  }

  throw new Error(`[WorkdayBot] Verification email timed out for ${email}`);
}

/**
 * Automatically triggers the Workday Forgot Password workflow:
 * 1. Locates and clicks "Forgot your password?" on the Sign In form
 * 2. Enters candidate's email into the reset form (avoiding honeypot 'beecatcher')
 * 3. Clicks "Reset Password" submit button
 * 4. Polls Zoho Mail API for the verification/reset link
 * 5. Opens the reset link in the browser session and sets the new password
 * 
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.password
 * @param {string} [options.company]
 * @param {number} [options.timeoutMs=75000]
 * @returns {Promise<{ success: boolean, url?: string, reason?: string }>}
 */
export async function executeWorkdayForgotPassword(page, { email, password, company, timeoutMs = 75000 }) {
  console.log(`   🔄 [WorkdayBot] Initiating automated Forgot Password recovery for ${email}...`);

  // 1. Locate and click "Forgot your password?" link/button
  const forgotBtn = await page.$([
    'button[data-automation-id="forgotPasswordLink"]',
    'a[data-automation-id="forgotPasswordLink"]',
    'button:has-text("Forgot your password?")',
    'a:has-text("Forgot your password?")',
    'button:has-text("Forgot Password")',
    'a:has-text("Forgot Password")',
    '[data-automation-id*="forgot" i]',
    'a[href*="forgotPassword" i]',
    'button[aria-label*="forgot" i]',
  ].join(', ')).catch(() => null);

  if (!forgotBtn || !(await forgotBtn.isVisible().catch(() => false))) {
    console.log('   ⚠️  [WorkdayBot] Could not locate visible "Forgot your password?" link on page.');
    return { success: false, reason: 'forgot_link_not_found' };
  }

  console.log('   🔗 [WorkdayBot] Clicking "Forgot your password?"...');
  await forgotBtn.click({ force: true }).catch(() => forgotBtn.evaluate(el => el.click()));
  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  // 2. Wait for Forgot Password form (email input and Reset Password button)
  try {
    await page.waitForSelector('button[data-automation-id="resetPasswordButton"]:visible, input[data-automation-id="email"]:visible', { timeout: 8000 });
  } catch {}

  // 3. Fill client email (explicitly ignoring honeypot 'beecatcher')
  const emailInputs = await page.$$('input[data-automation-id="email"], input[type="email"], input[name="email"], input[type="text"]');
  let emailFilled = false;
  for (const inp of emailInputs) {
    if (await inp.isVisible().catch(() => false)) {
      const autoId = await inp.getAttribute('data-automation-id').catch(() => '');
      const name = await inp.getAttribute('name').catch(() => '');
      if (autoId === 'beecatcher' || name === 'website') continue;
      await inp.fill(email);
      await page.waitForTimeout(200);
      emailFilled = true;
      break;
    }
  }

  if (!emailFilled) {
    console.log('   ⚠️  [WorkdayBot] Could not locate email input on Forgot Password form.');
    return { success: false, reason: 'email_input_not_found' };
  }

  // 4. Click "Reset Password" submit button
  const submitBtn = await page.$([
    'button[data-automation-id="resetPasswordButton"]',
    'button:has-text("Reset Password")',
    'button:has-text("Send verification link")',
    'button:has-text("Send")',
    'button[type="submit"]:visible',
  ].join(', ')).catch(() => null);

  if (!submitBtn || !(await submitBtn.isVisible().catch(() => false))) {
    console.log('   ⚠️  [WorkdayBot] Could not locate "Reset Password" submit button.');
    return { success: false, reason: 'submit_button_not_found' };
  }

  const requestTime = Date.now() - 30000;
  console.log('   📩 [WorkdayBot] Submitting client email for password reset instructions...');
  await submitBtn.click({ force: true }).catch(() => submitBtn.evaluate(el => el.click()));
  await page.waitForTimeout(3000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  // 5. Poll Zoho Mail Reader for the reset link
  console.log('   ⏳ [WorkdayBot] Polling Zoho Mail Reader for password reset email link...');
  const effectiveCompany = company || (page ? extractWorkdayCompanyName(page.url()) : '');
  const verifResult = await resolveWorkdayVerification(page, {
    email,
    password,
    company: effectiveCompany,
    startTime: requestTime,
    timeoutMs,
  }).catch((err) => {
    console.warn(`   ⚠️  [WorkdayBot] Verification poll error: ${err.message}`);
    return null;
  });

  if (!verifResult?.success) {
    console.log('   ❌ [WorkdayBot] Failed to retrieve password reset link from Zoho Mail Reader.');
    return { success: false, reason: verifResult?.reason || 'timeout' };
  }

  console.log('   ✅ [WorkdayBot] Password reset link processed successfully.');
  return { success: true, url: verifResult.url };
}
