/**
 * workdayVerification.mjs — Automated Workday Email Verification & Password Recovery via ZOHO_MAIL_READER
 *
 * Polls the local Zoho Mail Reader microservice for Workday activation/reset links or OTP codes,
 * navigates or fills them in the active Playwright browser session, and activates the account.
 */

import { extractWorkdayCompanyName, isInNavOrHeader, isWorkdayWizardVisible } from './discovery.mjs';

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
 * Returns true if page is a Workday password reset / set page.
 */
export async function isWorkdayPasswordResetSetPage(page) {
  try {
    if (!page) return false;
    const url = typeof page.url === 'function' ? page.url() : '';
    if (url.includes('/passwordreset/')) return true;

    if (typeof page.evaluate === 'function') {
      return await page.evaluate(() => {
        const u = window.location.href || '';
        if (u.includes('/passwordreset/')) return true;

        const inputs = Array.from(document.querySelectorAll('input')).filter(i => {
          const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
          const name = (i.name || '').toLowerCase();
          return autoId !== 'beecatcher' && name !== 'website' && i.offsetParent !== null;
        });

        const buttons = Array.from(document.querySelectorAll('button, a')).filter(b => b.offsetParent !== null);

        const hasResetBtn = buttons.some(b => {
          const autoId = (b.getAttribute('data-automation-id') || '').toLowerCase();
          const text = (b.textContent || '').trim().toLowerCase();
          return autoId.includes('resetpassword') || autoId.includes('changepassword') ||
                 text === 'reset password' || text === 'change password' || text.includes('reset password');
        });

        const hasNewOrVerifyPwd = inputs.some(i => {
          const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
          const name = (i.name || '').toLowerCase();
          return autoId.includes('newpassword') || autoId.includes('verify') || name.includes('newpassword') || name.includes('verify');
        });

        const hasEmail = inputs.some(i => {
          const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
          const name = (i.name || '').toLowerCase();
          return (i.type === 'email' || autoId.includes('email') || name.includes('email') || autoId.includes('username')) && !autoId.includes('password');
        });

        const pwdCount = inputs.filter(i => i.type === 'password' || (i.getAttribute('data-automation-id') || '').toLowerCase().includes('password')).length;

        return (hasResetBtn && (hasNewOrVerifyPwd || pwdCount >= 2 || !hasEmail)) || (pwdCount >= 2 && !hasEmail && u.includes('password'));
      }).catch(() => false);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Automatically completes the Workday Password Setup / Password Reset form.
 * 1. Locates new password and verify password fields with SPA wait/polling
 * 2. Types password with events (input, change, blur) and React native value setter
 * 3. Clicks Reset Password / Change Password / Submit button
 * 4. Handles post-reset navigation, clicking "Sign In" / "Continue" or automatically entering credentials to log in!
 *
 * @param {import('playwright').Page} page
 * @param {string} [email]
 * @param {string} [password]
 * @returns {Promise<boolean>} True if password setup form was detected and submitted
 */
export async function completeWorkdayPasswordResetForm(page, email, password) {
  const targetPassword = password || process.env.WORKDAY_PASSWORD || 'Applywizz@2026789';
  const targetEmail = email || process.env.WORKDAY_EMAIL || '';
  if (!page) return false;

  console.log('   🔍 [WorkdayBot] Checking for Workday password reset / set form...');

  const url = typeof page.url === 'function' ? page.url() : '';
  const isLikelyResetUrl = url.includes('/passwordreset/') || url.includes('password') || url.includes('reset');
  const maxAttempts = isLikelyResetUrl ? 8 : 1;
  let formReady = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isReset = await isWorkdayPasswordResetSetPage(page);
    if (isReset) {
      const inputCount = (typeof page.evaluate === 'function')
        ? await page.evaluate(() => {
            return document.querySelectorAll('input[type="password"], input[data-automation-id*="password" i], input[data-automation-id*="Password" i]').length;
          }).catch(() => 0)
        : 1;
      if (inputCount >= 1) {
        formReady = true;
        break;
      }
    }
    if (attempt < maxAttempts - 1) {
      await page.waitForTimeout(600);
    }
  }

  if (!formReady) {
    console.log('   ℹ️  [WorkdayBot] Password reset form not detected within timeout.');
    return false;
  }

  console.log('   🔑 [WorkdayBot] Password setup form detected — setting new password and confirmation password...');

  // 1. Fill fields in DOM with full React event dispatching
  if (typeof page.evaluate === 'function') {
    await page.evaluate((pwd) => {
      const rawInputs = Array.from(document.querySelectorAll('input')).filter(i => {
        const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
        const name = (i.name || '').toLowerCase();
        return autoId !== 'beecatcher' && name !== 'website' && i.offsetParent !== null;
      });

      const pwdInputs = rawInputs.filter(i => {
        const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
        const type = (i.type || '').toLowerCase();
        return type === 'password' || autoId.includes('password');
      });

      if (pwdInputs.length === 0) return { success: false, filled: 0 };

      let newInp = pwdInputs.find(i => {
        const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
        const name = (i.name || '').toLowerCase();
        return (autoId.includes('new') || name.includes('new')) && !autoId.includes('verify') && !name.includes('verify');
      }) || pwdInputs[0];

      let verifyInp = pwdInputs.find(i => {
        const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
        const name = (i.name || '').toLowerCase();
        const ph = (i.placeholder || '').toLowerCase();
        return autoId.includes('verify') || autoId.includes('confirm') || name.includes('verify') || name.includes('confirm') || ph.includes('verify') || ph.includes('confirm');
      }) || (pwdInputs.length > 1 ? pwdInputs[1] : null);

      const setVal = (el, val) => {
        if (!el) return;
        el.focus();
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          setter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      if (newInp) setVal(newInp, pwd);
      if (verifyInp) setVal(verifyInp, pwd);

      return {
        success: true,
        hasNew: !!newInp,
        hasVerify: !!verifyInp,
        count: pwdInputs.length,
      };
    }, targetPassword).catch(() => ({ success: false }));
  }

  // 2. Also fill via Playwright handles to ensure Playwright's browser layer synchronizes keystrokes
  if (typeof page.$$ === 'function') {
    const pwHandles = await page.$$([
      'input[data-automation-id="newPassword"]',
      'input[data-automation-id="verifyPassword"]',
      'input[data-automation-id="verifyNewPassword"]',
      'input[type="password"]',
    ].join(', ')).catch(() => []);

    for (const h of pwHandles) {
      if (await h.isVisible().catch(() => false)) {
        const autoId = (await h.getAttribute('data-automation-id').catch(() => '')).toLowerCase();
        if (autoId === 'beecatcher') continue;
        await h.fill(targetPassword).catch(() => {});
        await page.waitForTimeout(100);
      }
    }
  }

  console.log('   ✍️  [WorkdayBot] Successfully filled New Password and Confirmation Password.');
  await page.waitForTimeout(600);

  // 3. Locate and click submit button
  console.log('   💾 [WorkdayBot] Submitting new password and confirmation on reset form...');
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
    await saveBtn.click({ force: true }).catch(() => saveBtn.evaluate(el => el.click()));
  } else if (page.keyboard) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  await page.waitForTimeout(4000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(2000);

  // 4. Post-reset check: If application wizard is already reached, return immediately
  if (typeof isWorkdayWizardVisible === 'function' && await isWorkdayWizardVisible(page)) {
    console.log('   ✅ [WorkdayBot] Application wizard already reached post-reset!');
    return true;
  }

  // 5. Post-reset check: Click any "Sign In" or "Continue" action button
  const postActionBtn = (typeof page.$ === 'function')
    ? await page.$([
        'button[data-automation-id*="signIn" i]:visible',
        'a[data-automation-id*="signIn" i]:visible',
        'button:has-text("Sign In"):visible',
        'a:has-text("Sign In"):visible',
        'button:has-text("Continue"):visible',
        'a:has-text("Continue"):visible',
        'button[data-automation-id*="continue" i]:visible',
        'a[data-automation-id*="continue" i]:visible',
        'button:has-text("Log In"):visible',
        'a:has-text("Log In"):visible',
        'button[data-automation-id="adventureButton"]:visible',
        'a[data-automation-id="adventureButton"]:visible',
        'button[data-automation-id="jobPostingApplyButton"]:visible',
        'a[data-automation-id="jobPostingApplyButton"]:visible',
      ].join(', ')).catch(() => null)
    : null;

  if (postActionBtn && !await isInNavOrHeader(postActionBtn)) {
    console.log('   🔗 [WorkdayBot] Clicking post-reset action button ("Sign In" / "Continue")...');
    await postActionBtn.click({ force: true }).catch(() => postActionBtn.evaluate(el => el.click()));
    await page.waitForTimeout(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  }

  // 6. Post-reset check: If login form appears (Email + Password), automatically fill credentials and submit
  const emailInp = (typeof page.$ === 'function')
    ? await page.$('input[data-automation-id="email"]:visible, input[data-automation-id="userName"]:visible, input[type="email"]:visible, input[name="email"]:visible, input[name="userName"]:visible').catch(() => null)
    : null;
  const pwdInp = (typeof page.$ === 'function')
    ? await page.$('input[data-automation-id="password"]:visible, input[type="password"]:visible, input[name="password"]:visible').catch(() => null)
    : null;
  const submitSignIn = (typeof page.$ === 'function')
    ? await page.$('button[data-automation-id="signInSubmitButton"]:visible, button:has-text("Sign In"):visible, button[type="submit"]:visible').catch(() => null)
    : null;

  if (emailInp && pwdInp && submitSignIn && targetEmail) {
    console.log(`   🔐 [WorkdayBot] Sign-in form visible post-reset — automatically logging in as ${targetEmail}...`);
    await emailInp.click().catch(() => {});
    await emailInp.fill(targetEmail);
    await page.waitForTimeout(200);
    await pwdInp.click().catch(() => {});
    await pwdInp.fill(targetPassword);
    await page.waitForTimeout(200);
    await submitSignIn.click({ force: true }).catch(() => submitSignIn.evaluate(el => el.click()));
    await page.waitForTimeout(4000);
    try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  }

  // 7. Post-reset check: If URL still contains a redirect parameter, navigate directly to destination
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

  console.log('   ✅ [WorkdayBot] Password reset form submitted and post-reset flow executed.');
  return true;
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

          // Complete password setup form if present on the page
          const resetCompleted = await completeWorkdayPasswordResetForm(page, email, password);

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

          const onWizard = typeof isWorkdayWizardVisible === 'function' ? await isWorkdayWizardVisible(page) : false;
          console.log(`   ✅ [WorkdayBot] Account verification / password link processed successfully${onWizard ? ' (Application Wizard active)' : ''}.`);
          return { success: true, type: 'link', url: cleanLink, passwordReset: resetCompleted, onWizard };
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

  // Safety net: check if page is still on Password Reset Set form
  if (await isWorkdayPasswordResetSetPage(page)) {
    console.log('   🔑 [WorkdayBot] Page still on Password Reset form — completing password reset now...');
    await completeWorkdayPasswordResetForm(page, email, password);
  }

  const onWizard = typeof isWorkdayWizardVisible === 'function' ? await isWorkdayWizardVisible(page) : false;
  console.log(`   ✅ [WorkdayBot] Password reset link processed successfully${onWizard ? ' (Application Wizard active)' : ''}.`);
  return { success: true, url: verifResult.url, onWizard };
}
