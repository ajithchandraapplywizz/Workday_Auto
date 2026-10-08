// backend/tests/test_zoho_mail_reader.mjs
// Live integration test for Zoho Mail Reader API and Workday Authentication State Machine

import {
  listZohoUsers,
  getZohoUser,
  getZohoInbox,
  getZohoMessage,
  extractWorkdayAuthDetails,
} from '../lib/zohoMailClient.mjs';

async function main() {
  console.log('═'.repeat(75));
  console.log('🧪 LIVE INTEGRATION TEST: ZOHO MAIL READER API & WORKDAY AUTH RECOVERY');
  console.log('═'.repeat(75));

  const testEmail = 'zakirhussain.shaik@applywizard.ai';

  // 1. Endpoint 1: List All Users & Connection Status
  console.log('\n📡 1. Testing Endpoint 1: GET /api/zoho/ui/users...');
  const users = await listZohoUsers();
  if (!users || !Array.isArray(users)) {
    console.error('❌ Failed to fetch users from Zoho Mail Reader!');
    process.exit(1);
  }
  console.log(`   ✓ Successfully retrieved ${users.length} registered candidate mailboxes.`);
  
  const candidateUser = await getZohoUser(testEmail);
  if (!candidateUser) {
    console.error(`❌ Could not locate ${testEmail} in users list!`);
    process.exit(1);
  }
  console.log(`   ✓ Found test candidate: ${candidateUser.email}`);
  console.log(`     • Account ID: ${candidateUser.accountId}`);
  console.log(`     • Display Name: ${candidateUser.displayName}`);
  console.log(`     • Connected: ${candidateUser.connected} (Status: ${candidateUser.status})`);

  // 2. Endpoint 2: Get Candidate Inbox (List of Messages)
  console.log(`\n📬 2. Testing Endpoint 2: GET /api/zoho/ui/inbox for ${testEmail}...`);
  const inbox = await getZohoInbox(testEmail, { limit: 5, start: 1 });
  if (!inbox || !Array.isArray(inbox.messages)) {
    console.error(`❌ Failed to fetch inbox messages for ${testEmail}!`);
    process.exit(1);
  }
  console.log(`   ✓ Successfully fetched inbox (total matched: ${inbox.totalMatched}, returned: ${inbox.messages.length}):`);
  inbox.messages.forEach((m, idx) => {
    console.log(`     [#${idx + 1}] ID: ${m.messageId} | Subject: "${m.subject}" | From: ${m.from} | Time: ${new Date(Number(m.receivedTime)).toLocaleString()}`);
  });

  // 3. Endpoint 3: Get Full Email Body (HTML & Plain Text)
  const sampleMsg = inbox.messages[0];
  console.log(`\n📄 3. Testing Endpoint 3: GET /api/zoho/ui/message for Message ID: ${sampleMsg.messageId}...`);
  const msgDetails = await getZohoMessage(testEmail, {
    accountId: candidateUser.accountId,
    folderId: sampleMsg.folderId,
    messageId: sampleMsg.messageId,
  });

  if (!msgDetails?.message) {
    console.error('❌ Failed to retrieve full message details!');
    process.exit(1);
  }

  const htmlLen = (msgDetails.message.htmlContent || '').length;
  const textLen = (msgDetails.message.textContent || '').length;
  console.log(`   ✓ Successfully fetched full email content:`);
  console.log(`     • Subject: "${msgDetails.message.subject}"`);
  console.log(`     • HTML Body Length: ${htmlLen} chars`);
  console.log(`     • Plain Text Body Length: ${textLen} chars`);

  // 4. Test link and OTP extraction with simulated Workday emails
  console.log('\n🔍 4. Testing Link & Code Parsing on Workday Email Templates...');

  // Case A: Workday Email Verification / Activation Link (with HTML entities)
  const mockActivationHtml = `
    <html>
      <body>
        <p>Dear Candidate,</p>
        <p>Please activate your Workday account by clicking below:</p>
        <a href="https://cambiumlearning.wd1.myworkdayjobs.com/cambium_careers/activate?token=ABC123XYZ&amp;lang=en-US">Activate Account</a>
      </body>
    </html>
  `;
  const activationParsed = extractWorkdayAuthDetails(mockActivationHtml, '', 'Verify Your Workday Account');
  console.log('   [Case A: Activation Link]');
  console.log('     Found:', activationParsed.found);
  console.log('     Type:', activationParsed.type);
  console.log('     Extracted Link:', activationParsed.verificationLink);
  if (!activationParsed.found || activationParsed.type !== 'link' || activationParsed.verificationLink.includes('&amp;')) {
    console.error('❌ Failed Case A: Activation link was not parsed or HTML entity was not unescaped!');
    process.exit(1);
  }

  // Case B: Workday Password Reset Link
  const mockResetHtml = `
    <html>
      <body>
        <p>We received a request to reset your password.</p>
        <a href="https://cambiumlearning.wd1.myworkdayjobs.com/cambium_careers/passwordReset?token=RESET_SECURE_TOKEN_999">Reset Your Password</a>
      </body>
    </html>
  `;
  const resetParsed = extractWorkdayAuthDetails(mockResetHtml, '', 'Reset Your Workday Password');
  console.log('   [Case B: Password Reset Link]');
  console.log('     Found:', resetParsed.found);
  console.log('     Type:', resetParsed.type);
  console.log('     Extracted Link:', resetParsed.verificationLink);
  if (!resetParsed.found || resetParsed.type !== 'reset') {
    console.error('❌ Failed Case B: Password reset link was not properly identified!');
    process.exit(1);
  }

  // Case C: 6-Digit Verification Code (OTP)
  const mockOtpHtml = `
    <div>Your single-use Workday security code is 849201. This code expires in 15 minutes.</div>
  `;
  const otpParsed = extractWorkdayAuthDetails(mockOtpHtml, '', 'Workday Verification Code');
  console.log('   [Case C: 6-Digit OTP Code]');
  console.log('     Found:', otpParsed.found);
  console.log('     Type:', otpParsed.type);
  console.log('     Verification Code:', otpParsed.verificationCode);
  if (!otpParsed.found || otpParsed.type !== 'code' || otpParsed.verificationCode !== '849201') {
    console.error('❌ Failed Case C: 6-digit OTP code was not extracted correctly!');
    process.exit(1);
  }

  console.log('\n═'.repeat(75));
  console.log('🎉 ALL ZOHO MAIL READER INTEGRATION TESTS PASSED CLEANLY (100% SUCCESS)');
  console.log('═'.repeat(75));
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
