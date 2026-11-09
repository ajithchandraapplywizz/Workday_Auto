import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractWorkdayTenant,
  isWorkdayCompanyMatch,
  extractWorkdayAuthDetails,
  sanitizeWorkdayUrl,
} from '../lib/zohoMailClient.mjs';

test('extractWorkdayTenant correctly extracts tenant subdomains', () => {
  assert.equal(
    extractWorkdayTenant('https://ncr.wd1.myworkdayjobs.com/ext_us/job/ATLANTA-GA-USA/AI-Engineer_R0158787'),
    'ncr'
  );
  assert.equal(
    extractWorkdayTenant('https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/Mount-Laurel-NJ/Business-Analyst_1519426'),
    'td'
  );
  assert.equal(
    extractWorkdayTenant('https://xcelenergy.wd1.myworkdayjobs.com/External/job/Minneapolis-MN/Consultant_JR117358'),
    'xcelenergy'
  );
  assert.equal(
    extractWorkdayTenant('https://sec.wd3.myworkdayjobs.com/Samsung_Careers/job/1530-FM-973-Taylor-TX-USA/Senior-ML'),
    'sec'
  );
});

test('isWorkdayCompanyMatch accurately matches target company and tenant', () => {
  // Matching by tenant
  assert.equal(
    isWorkdayCompanyMatch({
      from: 'NCR@otp.workday.com',
      subject: 'Verify your candidate account',
      tenant: 'ncr',
    }),
    true
  );

  // Matching by company name
  assert.equal(
    isWorkdayCompanyMatch({
      from: 'TD@otp.workday.com',
      subject: 'Verify your candidate account',
      body: 'TD Careers / Carrières à la TD : Click this link...',
      company: 'TD Bank',
    }),
    true
  );

  // Rejecting mismatched company email
  assert.equal(
    isWorkdayCompanyMatch({
      from: 'TD@otp.workday.com',
      subject: 'Verify your candidate account',
      body: 'TD Careers: Click this link...',
      company: 'NCR Voyix',
      tenant: 'ncr',
    }),
    false
  );
});

test('extractWorkdayAuthDetails extracts pure link from user reference NCR Voyix email snippet', () => {
  const userEmailText = `
Please note this link will expire in 24 hours. This token is only available for a single use. If you click on the link a second time, you will receive an error stating the token is invalid. If you need an additional link for your password, please go back to the Candidate Home page, enter your email address related to your application and select "Forgot Password".

Click this link to confirm your email address and complete setup for your candidate account
https://ncr.wd1.myworkdayjobs.com/ext_us/activate/kw52l3esdak8n76869gfaw6j422c6o9koitne13hjt26gxlbuqubtbstp4ao4exnqspaa24b0i1hi48u9rm46yq5e9g1c1zgx8h/?redirect=%2Fen-US%2Fext_us%2Fjob%2FATLANTA%252C-GA%252C-USA%2FAI-Engineer_R0158787%2Fapply%2FapplyManually%3Fsource%3DApplicant-Facing_LinkedIn
The link will expire after 24 hours.

NCR Voyix Corporation 864 Spring St NW, Atlanta, GA 30308-1007
©2023 NCR Voyix Corporation. All rights reserved. ncrvoyix.com
  `;

  const authDetails = extractWorkdayAuthDetails('', userEmailText, 'Verify your candidate account', {
    company: 'NCR Voyix',
    jobUrl: 'https://ncr.wd1.myworkdayjobs.com/ext_us/job/ATLANTA-GA-USA/AI-Engineer_R0158787',
  });

  assert.equal(authDetails.found, true);
  assert.equal(authDetails.type, 'link');
  assert.equal(
    authDetails.verificationLink,
    'https://ncr.wd1.myworkdayjobs.com/ext_us/activate/kw52l3esdak8n76869gfaw6j422c6o9koitne13hjt26gxlbuqubtbstp4ao4exnqspaa24b0i1hi48u9rm46yq5e9g1c1zgx8h/?redirect=%2Fen-US%2Fext_us%2Fjob%2FATLANTA%252C-GA%252C-USA%2FAI-Engineer_R0158787%2Fapply%2FapplyManually%3Fsource%3DApplicant-Facing_LinkedIn'
  );
});

test('extractWorkdayAuthDetails filters out other company links when tenant is provided', () => {
  const mixedEmailHtml = `
    <div>Click below to verify:</div>
    <a href="https://xcelenergy.wd1.myworkdayjobs.com/External/activate/tok123?redirect=xcel">Xcel Verify</a>
    <a href="https://ncr.wd1.myworkdayjobs.com/ext_us/activate/tok456?redirect=ncr">NCR Verify</a>
  `;

  const authDetails = extractWorkdayAuthDetails(mixedEmailHtml, '', 'Verify Account', {
    company: 'NCR Voyix',
    tenant: 'ncr',
  });

  assert.equal(authDetails.found, true);
  assert.equal(
    authDetails.verificationLink,
    'https://ncr.wd1.myworkdayjobs.com/ext_us/activate/tok456?redirect=ncr'
  );
});

test('sanitizeWorkdayUrl strips quotes, markdown, and trailing punctuation', () => {
  const dirty1 = '  "https://ncr.wd1.myworkdayjobs.com/ext_us/activate/xyz/?redirect=test." ';
  const dirty2 = '<https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/activate/abc/?redirect=td>;';
  const dirty3 = '[https://xcelenergy.wd1.myworkdayjobs.com/External/activate/def/?redirect=xcel]';

  assert.equal(
    sanitizeWorkdayUrl(dirty1),
    'https://ncr.wd1.myworkdayjobs.com/ext_us/activate/xyz/?redirect=test'
  );
  assert.equal(
    sanitizeWorkdayUrl(dirty2),
    'https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/activate/abc/?redirect=td'
  );
  assert.equal(
    sanitizeWorkdayUrl(dirty3),
    'https://xcelenergy.wd1.myworkdayjobs.com/External/activate/def/?redirect=xcel'
  );
});
