import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWrongPasswordOrLocked,
  isWorkdayForgotPasswordPage,
  isWorkdayVerificationPage,
  executeWorkdayForgotPassword,
} from './workdayVerification.mjs';
import { isWorkdayLogin } from './workday.mjs';
import { resolveCompanyEmail } from './applyWizzClient.mjs';

test('1. detectWrongPasswordOrLocked: identifies all Workday error banner variations', async () => {
  const variations = [
    'Invalid user name or password, or your account might be locked.',
    'Invalid username or password',
    'Your account has been locked due to too many failed attempts.',
    'Your account is temporarily locked',
    'wrong password entered',
    'incorrect password',
  ];

  for (const errorMsg of variations) {
    const page = {
      evaluate: async (fn) => {
        global.document = {
          querySelectorAll: () => [{ textContent: errorMsg }],
          body: { innerText: errorMsg },
        };
        return fn();
      },
    };
    const detected = await detectWrongPasswordOrLocked(page);
    assert.equal(detected, true, `Should detect error: "${errorMsg}"`);
  }

  // Non-error page
  const cleanPage = {
    evaluate: async (fn) => {
      global.document = {
        querySelectorAll: () => [],
        body: { innerText: 'Sign In with your Workday account' },
      };
      return fn();
    },
  };
  assert.equal(await detectWrongPasswordOrLocked(cleanPage), false);
});

test('2. isWorkdayForgotPasswordPage: distinguishes forgot form from regular signin', async () => {
  const forgotPage = {
    $: async (sel) => (sel.includes('resetPasswordButton') ? {} : null),
    evaluate: async () => 'Forgot Password. Enter your email to reset password.',
  };
  assert.equal(await isWorkdayForgotPasswordPage(forgotPage), true);

  const signinPage = {
    $: async () => null,
    evaluate: async () => 'Sign In with email and password.',
  };
  assert.equal(await isWorkdayForgotPasswordPage(signinPage), false);
});

test('3. isWorkdayLogin: recognizes login page with forgot-password & reset-password elements', async () => {
  const loginWithForgot = {
    url: () => 'https://fenwick.wd1.myworkdayjobs.com/Fenwick_External_Careers/login',
    evaluate: async () => ({
      hasEmailInput: true,
      hasPasswordInput: true,
      hasForgotPasswordBtn: true,
      hasResetPasswordBtn: false,
    }),
  };
  assert.equal(await isWorkdayLogin(loginWithForgot), true);
});

test('4. executeWorkdayForgotPassword: fills email, avoids honeypot, clicks reset button', async () => {
  let clickedForgot = false;
  let filledEmail = '';
  let filledHoneypot = false;
  let clickedReset = false;

  const mockEmailInput = {
    isVisible: async () => true,
    getAttribute: async (attr) => (attr === 'data-automation-id' ? 'email' : ''),
    fill: async (val) => { filledEmail = val; },
  };

  const mockHoneypot = {
    isVisible: async () => true,
    getAttribute: async (attr) => (attr === 'data-automation-id' ? 'beecatcher' : 'website'),
    fill: async () => { filledHoneypot = true; },
  };

  const mockPage = {
    url: () => 'https://target.wd5.myworkdayjobs.com/target/job/123/apply',
    $: async (sel) => {
      if (sel.includes('forgotPasswordLink') || sel.includes('Forgot your password')) {
        return {
          isVisible: async () => true,
          click: async () => { clickedForgot = true; },
        };
      }
      if (sel.includes('resetPasswordButton') || sel.includes('Reset Password')) {
        return {
          isVisible: async () => true,
          click: async () => { clickedReset = true; },
        };
      }
      return null;
    },
    $$: async (sel) => {
      if (sel.includes('password') || sel.includes('newPassword')) {
        return [
          {
            isVisible: async () => true,
            getAttribute: async (attr) => (attr === 'data-automation-id' ? 'newPassword' : ''),
            fill: async () => {},
          },
        ];
      }
      return [mockHoneypot, mockEmailInput];
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForSelector: async () => {},
  };

  // Mock global fetch for Zoho Mail API
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    return {
      ok: true,
      json: async () => ({
        found: true,
        verificationLink: 'https://target.wd5.myworkdayjobs.com/reset-password-test',
        subject: 'Reset your password',
      }),
    };
  };

  try {
    mockPage.goto = async () => {};
    const result = await executeWorkdayForgotPassword(mockPage, {
      email: 'candidate@applywizard.ai',
      password: 'NewPassword@2026',
      company: 'target',
      timeoutMs: 5000,
    });

    assert.equal(clickedForgot, true, 'Must click "Forgot your password?"');
    assert.equal(filledEmail, 'candidate@applywizard.ai', 'Must fill client email');
    assert.equal(filledHoneypot, false, 'Must NEVER fill beecatcher honeypot');
    assert.equal(clickedReset, true, 'Must click "Reset Password" submit button');
    assert.equal(result.success, true, 'Recovery must succeed');
  } finally {
    global.fetch = originalFetch;
  }
});

test('5. Production data integrity: resolveCompanyEmail never uses dummy emails', () => {
  const client = {
    personal_email: 'laptap005@gmail.com',
    company_email: 'nikhila.lankela@applywizard.ai',
    first_name: 'Nikhila',
    last_name: 'Lankela',
  };

  const email = resolveCompanyEmail(client, 'Nikhila Lankela');
  assert.equal(email, 'nikhila.lankela@applywizard.ai');
  assert.equal(email.includes('laptap005'), false);
  assert.equal(email.endsWith('@applywizard.ai'), true);
});
