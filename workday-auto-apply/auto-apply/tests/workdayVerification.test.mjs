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

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get('email'), 'candidate@applywizz.com');
      assert.equal(u.searchParams.get('company'), 'workday');
      return {
        ok: true,
        json: async () => ({
          found: true,
          verificationLink: 'https://workday.wd5.myworkdayjobs.com/verify?token=abc123xyz',
        }),
      };
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
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        found: true,
        verificationCode: '748291',
      }),
    });

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
