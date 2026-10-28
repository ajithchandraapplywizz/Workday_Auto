import { test, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkdayVerificationPage, resolveWorkdayVerification } from '../lib/workdayVerification.mjs';

describe('Workday Email Verification (workdayVerification.mjs)', () => {
  it('isWorkdayVerificationPage detects verification prompt in body text', async () => {
    const mockPageVerification = {
      evaluate: async () => 'Please verify your account. We sent a verification email to applicant@domain.com. Check your spam folder.',
    };
    assert.equal(await isWorkdayVerificationPage(mockPageVerification), true);

    const mockPageCode = {
      evaluate: async () => 'A verification code was sent to your email. Enter the code below.',
    };
    assert.equal(await isWorkdayVerificationPage(mockPageCode), true);

    const mockPageRegular = {
      evaluate: async () => 'Welcome to Careers at Workday. Please sign in or create an account.',
    };
    assert.equal(await isWorkdayVerificationPage(mockPageRegular), false);
  });

  it('resolveWorkdayVerification handles activation link', async () => {
    let visitedUrl = '';
    const mockPage = {
      url: () => 'https://workday.wd5.myworkdayjobs.com/en-US/Careers/job/Engineer',
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      goto: async (url) => { visitedUrl = url; },
    };

    // Mock global fetch for Zoho Mail endpoints
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/zoho/ui/users')) {
        return {
          ok: true,
          json: async () => ({
            users: [{ email: 'candidate@applywizz.com', accountId: 'acc1', connected: true }],
          }),
        };
      }
      if (u.includes('/api/zoho/ui/inbox')) {
        return {
          ok: true,
          json: async () => ({
            accountId: 'acc1',
            messages: [
              {
                folderId: 'f1',
                messageId: 'm1',
                receivedTime: Date.now(),
                from: 'workday@myworkday.com',
                subject: 'Activate your Workday Account',
              },
            ],
          }),
        };
      }
      if (u.includes('/api/zoho/ui/message')) {
        return {
          ok: true,
          json: async () => ({
            message: {
              htmlContent: '<a href="https://workday.wd5.myworkdayjobs.com/verify?token=abc123xyz">Activate Account</a>',
              textContent: 'https://workday.wd5.myworkdayjobs.com/verify?token=abc123xyz',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      const result = await resolveWorkdayVerification(mockPage, {
        email: 'candidate@applywizz.com',
        company: 'workday',
        startTime: Date.now() - 1000,
        timeoutMs: 10000,
      });

      assert.equal(result.success, true);
      assert.equal(result.type, 'link');
      assert.equal(result.url, 'https://workday.wd5.myworkdayjobs.com/verify?token=abc123xyz');
      assert.equal(visitedUrl, 'https://workday.wd5.myworkdayjobs.com/verify?token=abc123xyz');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolveWorkdayVerification handles numeric verification code', async () => {
    let filledCode = '';
    let submitClicked = false;

    const mockPage = {
      url: () => 'https://workday.wd5.myworkdayjobs.com/en-US/Careers/job/Engineer',
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      locator: (selector) => {
        if (selector.includes('input')) {
          return {
            first: () => ({
              isVisible: async () => true,
              fill: async (val) => { filledCode = val; },
            }),
          };
        }
        return {
          first: () => ({
            isVisible: async () => true,
            click: async () => { submitClicked = true; },
          }),
        };
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/zoho/ui/users')) {
        return {
          ok: true,
          json: async () => ({
            users: [{ email: 'candidate@applywizz.com', accountId: 'acc1', connected: true }],
          }),
        };
      }
      if (u.includes('/api/zoho/ui/inbox')) {
        return {
          ok: true,
          json: async () => ({
            accountId: 'acc1',
            messages: [
              {
                folderId: 'f1',
                messageId: 'm2',
                receivedTime: Date.now(),
                from: 'workday@myworkday.com',
                subject: 'Your verification code is 748291',
              },
            ],
          }),
        };
      }
      if (u.includes('/api/zoho/ui/message')) {
        return {
          ok: true,
          json: async () => ({
            message: {
              htmlContent: '<p>Your verification code is 748291</p>',
              textContent: 'Your verification code is 748291',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      const result = await resolveWorkdayVerification(mockPage, {
        email: 'candidate@applywizz.com',
        company: 'workday',
        startTime: Date.now() - 1000,
        timeoutMs: 10000,
      });

      assert.equal(result.success, true);
      assert.equal(result.type, 'code');
      assert.equal(result.code, '748291');
      assert.equal(filledCode, '748291');
      assert.equal(submitClicked, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
