/**
 * workdayVerification.mjs — Automated Workday Email Verification via ZOHO_MAIL_READER
 *
 * Polls the local Zoho Mail Reader microservice for Workday activation links or OTP codes,
 * navigates or fills them in the active Playwright browser session, and activates the account.
 */

import { extractWorkdayCompanyName } from './discovery.mjs';

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
 * Polls ZOHO_MAIL_READER for a Workday verification email and handles either link or OTP code.
 * 
 * @param {import('playwright').Page} page - Active browser page in your bot
 * @param {Object} options
 * @param {string} options.email - The applicant's email address
 * @param {string} [options.company] - Company name (e.g. "nvidia", "target")
 * @param {number} [options.startTime] - Timestamp (Date.now()) recorded when "Create Account" was clicked
 * @param {number} [options.timeoutMs=60000] - Max wait time (default: 60s)
 * @returns {Promise<{ success: boolean, type: 'link'|'code', url?: string, code?: string }>}
 */
export async function resolveWorkdayVerification(page, { email, company, startTime, timeoutMs = 60000 }) {
  const cutoff = startTime || (Date.now() - 30000);
  const pollInterval = 3000; // 3 seconds
  const deadline = Date.now() + timeoutMs;
  const effectiveCompany = company || (page ? extractWorkdayCompanyName(page.url()) : '');

  console.log(`   📧 [WorkdayBot] Waiting for verification email for ${email}${effectiveCompany ? ` (${effectiveCompany})` : ''}...`);

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollInterval);
    try {
      const url = new URL('http://localhost:5000/api/zoho/workday-verification');
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
        // Case A: Workday sends an Activation Link (most common)
        if (data.verificationLink) {
          console.log(`   🔗 [WorkdayBot] Received activation link: ${data.verificationLink}`);
          // Navigate to the activation link in the SAME browser session to preserve cookies
          await page.goto(data.verificationLink, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

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

          console.log('   ✅ [WorkdayBot] Successfully activated account via link in current isolated browser.');
          return { success: true, type: 'link', url: data.verificationLink };
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
          console.log(`   ℹ️  [WorkdayBot] Mailbox ${email} is not connected to Zoho Mail Reader — skipping automated email poll.`);
          return { success: false, reason: 'mailbox_not_connected' };
        }
        console.log(`   ⏳ [WorkdayBot] Waiting for email... (${data.reason || 'pending'})`);
      }
    } catch (err) {
      console.warn('   ⚠️  [WorkdayBot] Polling error:', err.message);
    }
  }

  throw new Error(`[WorkdayBot] Verification email timed out for ${email}`);
}
