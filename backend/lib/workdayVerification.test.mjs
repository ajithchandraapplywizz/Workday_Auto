import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkdayVerificationPage,
  isWorkdayForgotPasswordPage,
  detectWrongPasswordOrLocked,
} from './workdayVerification.mjs';

test('detectWrongPasswordOrLocked correctly identifies Workday error messages', async () => {
  const mockPage1 = {
    evaluate: async (fn) => {
      global.document = {
        querySelectorAll: () => [
          { textContent: 'Invalid user name or password, or your account might be locked.' }
        ],
        body: { innerText: 'Invalid user name or password, or your account might be locked.' }
      };
      return fn();
    }
  };
  assert.equal(await detectWrongPasswordOrLocked(mockPage1), true);

  const mockPage2 = {
    evaluate: async (fn) => {
      global.document = {
        querySelectorAll: () => [],
        body: { innerText: 'Your account has been locked due to too many failed attempts.' }
      };
      return fn();
    }
  };
  assert.equal(await detectWrongPasswordOrLocked(mockPage2), true);

  const mockPage3 = {
    evaluate: async (fn) => {
      global.document = {
        querySelectorAll: () => [],
        body: { innerText: 'Welcome to Workday Careers. Please sign in.' }
      };
      return fn();
    }
  };
  assert.equal(await detectWrongPasswordOrLocked(mockPage3), false);
});

test('isWorkdayForgotPasswordPage correctly identifies Forgot Password screens', async () => {
  const mockForgotPage = {
    $: async (selector) => {
      if (selector.includes('resetPasswordButton')) return {};
      return null;
    },
    evaluate: async () => 'Forgot Password\nEnter your email address to reset password'
  };
  assert.equal(await isWorkdayForgotPasswordPage(mockForgotPage), true);

  const mockNonForgotPage = {
    $: async () => null,
    evaluate: async () => 'Sign In\nEnter your email and password'
  };
  assert.equal(await isWorkdayForgotPasswordPage(mockNonForgotPage), false);
});

test('isWorkdayVerificationPage correctly identifies email verification screens', async () => {
  const mockVerifPage = {
    $: async () => null,
    evaluate: async () => 'Please verify your email. We sent an email with an activation link.'
  };
  assert.equal(await isWorkdayVerificationPage(mockVerifPage), true);

  const mockNormalPage = {
    $: async () => null,
    evaluate: async () => 'Job Application Step 1 of 5'
  };
  assert.equal(await isWorkdayVerificationPage(mockNormalPage), false);
});
