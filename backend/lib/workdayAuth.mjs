/**
 * workdayAuth.mjs — Comprehensive Workday Authentication State Machine
 * ====================================================================
 * Bridges the battle-tested, heavily-trained Workday authentication logic
 * from workday.mjs, discovery.mjs, and workdayVerification.mjs.
 *
 * Guaranteed 100% parity with the production-verified auth flow:
 * 1. Entry & Gateway Discovery (Apply button, Apply Manually menu, Continue Application drafts)
 * 2. Adaptive Gateway handling (Social SSO, "Sign in with email", Create Account toggle)
 * 3. Robust email & password input filling with single-step gateway advancement
 * 4. Cookie notice & modal dialog dismissal
 * 5. Sign-in submission (excluding navigation and header buttons)
 * 6. Automated Create Account registration + consent checkbox loops
 * 7. Real-time Zoho Mail polling for email verification & Forgot Password recovery
 * 8. Active "Resend Account Verification" detection and click trigger
 * 9. Already Applied detection to prevent duplicate submissions
 */

import {
  handleWorkday,
  workdayLogin,
  workdayCreateAccount,
  isWorkdayLogin,
  isWorkdaySignInPage,
} from './workday.mjs';

import {
  ensureWorkdayApplicationWizard,
  handleAdaptiveGateway,
  clickGatewaySignIn,
  clickGatewayCreateAccount,
  isWorkdayWizardVisible,
  isWorkdayAlreadyApplied,
  isSignInFormVisible,
  prescanGatewayElements,
  extractWorkdayCompanyName,
  isInNavOrHeader,
} from './discovery.mjs';

import {
  resolveWorkdayVerification,
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  isWorkdayPasswordResetSetPage,
  completeWorkdayPasswordResetForm,
  detectWrongPasswordOrLocked,
  executeWorkdayForgotPassword,
  sanitizeWorkdayUrl,
} from './workdayVerification.mjs';

import {
  extractWorkdayAuthDetails,
  pollZohoWorkdayAuth,
} from './zohoMailClient.mjs';

export {
  handleWorkday,
  workdayLogin,
  workdayCreateAccount,
  isWorkdayLogin,
  isWorkdaySignInPage,
  ensureWorkdayApplicationWizard,
  handleAdaptiveGateway,
  clickGatewaySignIn,
  clickGatewayCreateAccount,
  isWorkdayWizardVisible,
  isWorkdayAlreadyApplied,
  isSignInFormVisible,
  prescanGatewayElements,
  extractWorkdayCompanyName,
  isInNavOrHeader,
  resolveWorkdayVerification,
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  isWorkdayPasswordResetSetPage,
  completeWorkdayPasswordResetForm,
  detectWrongPasswordOrLocked,
  executeWorkdayForgotPassword,
  sanitizeWorkdayUrl,
  extractWorkdayAuthDetails,
  pollZohoWorkdayAuth,
};

/**
 * Checks if the Workday application form/wizard is currently visible.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayApplicationFormVisible(page) {
  return await isWorkdayWizardVisible(page);
}

/**
 * Checks if a Workday login form is currently visible.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayLoginFormVisible(page) {
  return (await isSignInFormVisible(page)) || (await isWorkdayLogin(page));
}

/**
 * Unified Workday Authentication Orchestrator.
 * Delegates directly to the heavily-trained Workday state machine (workday.mjs).
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.email - Candidate company email
 * @param {string} [opts.company] - Company name for Zoho Mail subject matching
 * @param {string} [opts.password] - Universal Workday password
 * @param {object} [opts.profile] - Candidate profile object
 * @returns {Promise<{success: boolean, path: string, reason?: string, alreadyApplied?: boolean}>}
 */
export async function executeWorkdayAuth(page, { email, company = '', password = null, profile = null } = {}) {
  const dynamicPassword = password
    || process.env.WORKDAY_PASSWORD
    || process.env.USER_PASSWORD
    || process.env.APPLYWIZZ_PASSWORD
    || 'Applywizz@2026789';

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) {
    console.error('   ❌ [WorkdayAuth] Missing candidate email. Aborting auth.');
    return { success: false, path: 'none', reason: 'missing_candidate_email' };
  }

  console.log(`\n🔑 [WorkdayAuth] Starting heavily-trained Workday auth for ${cleanEmail} (Company: ${company || 'Unknown'})...`);

  // 1. Direct check: If application wizard is ALREADY visible (no-auth or already open)
  if (await isWorkdayWizardVisible(page)) {
    console.log('   🎉 [WorkdayAuth] Application wizard already visible — bypassing auth.');
    return { success: true, path: 'already_on_wizard' };
  }

  // 2. Direct check: If candidate already applied
  if (await isWorkdayAlreadyApplied(page)) {
    console.log(`   ℹ️ [WorkdayAuth] Candidate ${cleanEmail} has ALREADY APPLIED to this job.`);
    return { success: false, alreadyApplied: true, path: 'already_applied', reason: 'already_applied' };
  }

  // 3. Delegate to the fully-trained, production-verified handleWorkday state machine
  const authProfile = profile || { personal: { email: cleanEmail } };
  try {
    const authResult = await handleWorkday(page, {
      email: cleanEmail,
      password: dynamicPassword,
      mode: 'signin',
      profile: authProfile,
    });

    if (authResult === 'already_applied' || (await isWorkdayAlreadyApplied(page))) {
      console.log(`   ℹ️ [WorkdayAuth] Candidate ${cleanEmail} ALREADY APPLIED after auth verification.`);
      return { success: false, alreadyApplied: true, path: 'already_applied', reason: 'already_applied' };
    }

    if (authResult === 'mailbox_not_connected') {
      console.log(`   ❌ [WorkdayAuth] Zoho Mailbox not connected for ${cleanEmail}`);
      return { success: false, path: 'zoho_not_connected', reason: 'Zoho Mail was not connected' };
    }

    if (authResult === true || (await isWorkdayWizardVisible(page))) {
      console.log(`   🎉 [WorkdayAuth] Authentication succeeded! Application wizard is active.`);
      return { success: true, path: 'handle_workday_success' };
    }

    // 4. Fail-safe hydration check: Wait briefly in case wizard became active after transient delay
    await page.waitForTimeout(2000);
    if (await isWorkdayWizardVisible(page)) {
      return { success: true, path: 'wizard_visible_delayed' };
    }

    return { success: false, path: 'auth_exhausted', reason: 'Auth failed across all paths' };
  } catch (err) {
    console.error(`   ❌ [WorkdayAuth] Exception during handleWorkday execution: ${err.message}`);
    if (await isWorkdayWizardVisible(page).catch(() => false)) {
      return { success: true, path: 'recovered_on_wizard' };
    }
    return { success: false, path: 'error', reason: err.message };
  }
}
