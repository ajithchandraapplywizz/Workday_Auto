import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWorkdayAuthDetails,
  isWorkdayCompanyMatch,
  extractLinks,
  decodeEntities,
} from '../lib/zohoMailClient.mjs';

test('extractWorkdayAuthDetails extracts authentic password reset links with high score', () => {
  const html = `
    <html>
      <body>
        <p>Hello John,</p>
        <p>You requested a password reset for your Workday account at Unum.</p>
        <p><a href="https://unum.wd1.myworkdayjobs.com/en-US/Unum/passwordreset/token_abc123456789">Click here to reset your password</a></p>
      </body>
    </html>
  `;
  const text = 'Click here: https://unum.wd1.myworkdayjobs.com/en-US/Unum/passwordreset/token_abc123456789';
  const subject = 'Password Reset Request';

  const result = extractWorkdayAuthDetails(html, text, subject, {
    company: 'Unum',
    tenant: 'unum',
    jobUrl: 'https://unum.wd1.myworkdayjobs.com/en-US/Unum/job/1234',
  });

  assert.equal(result.found, true);
  assert.equal(result.type, 'reset');
  assert.equal(
    result.verificationLink,
    'https://unum.wd1.myworkdayjobs.com/en-US/Unum/passwordreset/token_abc123456789'
  );
});

test('extractWorkdayAuthDetails handles plain text emails where html has only navigation links', () => {
  const html = `
    <div><a href="https://www.workday.com">Workday Home</a></div>
  `;
  const text = 'Reset your password here: https://pnc.wd5.myworkdayjobs.com/passwordreset?token=xyz987';
  const subject = 'Your Workday Password Reset Link';

  const result = extractWorkdayAuthDetails(html, text, subject, {
    company: 'PNC',
    tenant: 'pnc',
    jobUrl: 'https://pnc.wd5.myworkdayjobs.com/en-US/PNC/job/567',
  });

  assert.equal(result.found, true);
  assert.equal(result.type, 'reset');
  assert.equal(
    result.verificationLink,
    'https://pnc.wd5.myworkdayjobs.com/passwordreset?token=xyz987'
  );
});

test('isWorkdayCompanyMatch recognizes Workday auth and reset emails without false negative drop', () => {
  // Case A: Workday notification email where from and subject are generic Workday sender
  const matchA = isWorkdayCompanyMatch({
    from: 'myworkday@myworkday.com',
    subject: 'Password Reset Request',
    body: 'Your Unum career account password reset request.',
    company: 'Unum',
    tenant: 'unum',
  });
  assert.equal(matchA, true, 'Should match when tenant is mentioned in body');

  // Case B: Workday notification where tenant is in the reset URL link
  const matchB = isWorkdayCompanyMatch({
    from: 'notifications@myworkday.com',
    subject: 'Workday Account Notification',
    body: 'Click here to proceed: https://unum.wd1.myworkdayjobs.com/passwordreset/123',
    link: 'https://unum.wd1.myworkdayjobs.com/passwordreset/123',
    company: 'Unum',
    tenant: 'unum',
  });
  assert.equal(matchB, true, 'Should match when tenant is in the link/body');
});

test('extractLinks parses both HTML href and raw plain-text URLs with entity decoding', () => {
  const html = '<a href="https://wd5.myworkdayjobs.com/test?a&#x3D;1&amp;b&#x3D;2">Link</a>';
  const text = 'Direct link: https://wd5.myworkdayjobs.com/reset/token123';

  const links = extractLinks(html, text);
  assert.equal(links.length, 2);
  assert.ok(links.some(l => l.includes('test?a=1&b=2')));
  assert.ok(links.some(l => l.includes('/reset/token123')));
});
