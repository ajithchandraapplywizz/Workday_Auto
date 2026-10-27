/**
 * zohoMailClient.mjs — Integration with Zoho Mail Reader on Render
 *
 * Provides real-time polling of client mailboxes for Workday confirmation links,
 * account activation URLs, password reset links, and 6-digit OTP codes.
 */

import { sanitizeWorkdayUrl } from './workdayVerification.mjs';

const ZOHO_BASE_URL = process.env.ZOHO_MAIL_READER_URL || 'https://zoho-mail-reader.onrender.com';

let usersCache = null;
let usersCacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Endpoint 1: List all accounts registered in Zoho and connection status.
 * GET https://zoho-mail-reader.onrender.com/api/zoho/ui/users
 */
export async function listZohoUsers({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && usersCache && now - usersCacheTime < CACHE_TTL_MS) {
    return usersCache;
  }
  try {
    const res = await fetch(`${ZOHO_BASE_URL}/api/zoho/ui/users`, {
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    usersCache = Array.isArray(data.users) ? data.users : [];
    usersCacheTime = now;
    return usersCache;
  } catch (err) {
    console.warn(`  ⚠️ [ZohoMail] Failed to list users: ${err.message}`);
    return null;
  }
}

/**
 * Get account details for a specific candidate email.
 */
export async function getZohoUser(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  const users = await listZohoUsers();
  if (!users) return null;
  return users.find((u) => u.email?.toLowerCase() === clean) || null;
}

/**
 * Ensure admin login on Zoho Mail Reader so all mailboxes can be accessed.
 */
export async function ensureZohoAdminLogin() {
  const username = process.env.ZOHO_ADMIN_USERNAME || 'Created@123';
  const password = process.env.ZOHO_ADMIN_PASSWORD || 'Applywizz@2026';
  try {
    const res = await fetch(`${ZOHO_BASE_URL}/api/zoho/ui/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      console.log(`   ✓ [ZohoMail] Logged into Zoho Mail Reader as admin (${username})`);
      return true;
    }
  } catch (err) {
    console.warn(`  ⚠️ [ZohoMail] Admin login notice: ${err.message}`);
  }
  return false;
}

/**
 * Endpoint 2: Get candidate inbox messages.
 * GET https://zoho-mail-reader.onrender.com/api/zoho/ui/inbox?email={CANDIDATE_EMAIL}&limit={LIMIT}&start={START}
 */
export async function getZohoInbox(email, { limit = 5, start = 1 } = {}) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  try {
    const url = `${ZOHO_BASE_URL}/api/zoho/ui/inbox?email=${encodeURIComponent(clean)}&limit=${limit}&start=${start}`;
    let res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (res.status === 401 || res.status === 403) {
      await ensureZohoAdminLogin();
      res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`  ⚠️ [ZohoMail] Failed to get inbox for ${clean}: ${err.message}`);
    return null;
  }
}

/**
 * Endpoint 3: Get full message body (HTML and plain text).
 * GET https://zoho-mail-reader.onrender.com/api/zoho/ui/message?email={EMAIL}&accountId={ACCOUNT_ID}&folderId={FOLDER_ID}&messageId={MESSAGE_ID}
 */
export async function getZohoMessage(email, { accountId, folderId, messageId }) {
  if (!email || !folderId || !messageId) return null;
  const clean = String(email).trim().toLowerCase();
  try {
    const params = new URLSearchParams({
      email: clean,
      accountId: String(accountId || ''),
      folderId: String(folderId),
      messageId: String(messageId),
    });
    const url = `${ZOHO_BASE_URL}/api/zoho/ui/message?${params.toString()}`;
    let res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (res.status === 401 || res.status === 403) {
      await ensureZohoAdminLogin();
      res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`  ⚠️ [ZohoMail] Failed to fetch message ${messageId}: ${err.message}`);
    return null;
  }
}

function unescapeHtml(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Robust Workday link & OTP code extractor from HTML and plain-text email bodies.
 */
export function extractWorkdayAuthDetails(html = '', text = '', subject = '') {
  const cleanHtml = String(html || '');
  const cleanText = String(text || '');
  const combined = `${cleanHtml}\n${cleanText}`;
  const subjLower = String(subject || '').toLowerCase();

  // 1. Extract href links from HTML (prioritizing primary CTA buttons / links)
  const hrefMatches = Array.from(cleanHtml.matchAll(/href=["'](https?:\/\/[^"'>]+)["']/gi))
    .map((m) => unescapeHtml(m[1]).trim());

  // 2. Extract plain text URLs
  const textMatches = Array.from(combined.matchAll(/https?:\/\/[^\s"'<>]+/gi))
    .map((m) => unescapeHtml(m[0]).trim());

  const allCandidates = [...new Set([...hrefMatches, ...textMatches])];

  // Check URLs for Workday verification or password reset links
  for (const rawUrl of allCandidates) {
    const cleanUrl = sanitizeWorkdayUrl(rawUrl);
    if (!cleanUrl) continue;
    const uLower = cleanUrl.toLowerCase();

    // Check for Password Reset link
    if (
      uLower.includes('passwordreset') ||
      uLower.includes('resetpassword') ||
      (uLower.includes('reset') && (uLower.includes('token=') || uLower.includes('code='))) ||
      subjLower.includes('reset') ||
      subjLower.includes('password')
    ) {
      if (
        uLower.includes('myworkday') ||
        uLower.includes('workday') ||
        uLower.includes('passwordreset') ||
        uLower.includes('token=') ||
        uLower.includes('code=')
      ) {
        console.log(`   🎉 [ZohoMail] Found Workday password reset link: ${cleanUrl}`);
        return {
          found: true,
          type: 'reset',
          verificationLink: cleanUrl,
        };
      }
    }

    // Check for Email Verification / Account Activation link
    if (
      uLower.includes('myworkday') ||
      uLower.includes('workday') ||
      uLower.includes('verify') ||
      uLower.includes('activate') ||
      uLower.includes('token=') ||
      uLower.includes('code=')
    ) {
      console.log(`   🎉 [ZohoMail] Found Workday verification link: ${cleanUrl}`);
      return {
        found: true,
        type: 'link',
        verificationLink: cleanUrl,
      };
    }
  }

  // 3. Extract 6-digit OTP code if present in body or subject
  const codeMatch = combined.match(/\b([0-9]{6})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    console.log(`   🎉 [ZohoMail] Found 6-digit Workday verification code: ${code}`);
    return {
      found: true,
      type: 'code',
      verificationCode: code,
    };
  }

  return { found: false };
}

/**
 * Poll Zoho Mail for recent Workday activation link, password reset link, or OTP code.
 *
 * @param {object} opts
 * @param {string} opts.email - Applicant's company email
 * @param {string} [opts.company] - Company name (e.g. "cambiumlearning", "wellsfargo")
 * @param {number} [opts.cutoffTime] - Ignore messages received before this timestamp (ms)
 * @param {number} [opts.timeoutMs=60000] - Total timeout (ms)
 * @param {number} [opts.pollIntervalMs=3000] - Poll frequency (ms)
 * @returns {Promise<{ found: boolean, type?: 'link'|'reset'|'code', verificationLink?: string, verificationCode?: string, subject?: string, reason?: string }>}
 */
export async function pollZohoWorkdayAuth({
  email,
  company = '',
  cutoffTime = null,
  timeoutMs = 60000,
  pollIntervalMs = 3000,
}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return { found: false, reason: 'missing_email' };

  const deadline = Date.now() + timeoutMs;
  const cutoff = cutoffTime || (Date.now() - 5 * 60 * 1000); // default last 5 minutes

  console.log(`   📧 [ZohoMail] Polling Zoho Mail Reader for ${cleanEmail} (cutoff: ${new Date(cutoff).toLocaleTimeString()})...`);

  // 1. Verify user connection in Zoho
  let userAccountId = null;
  const user = await getZohoUser(cleanEmail);
  if (user) {
    userAccountId = user.accountId;
    console.log(`   ✓ [ZohoMail] Candidate account verified in Zoho: ${cleanEmail} (Connected: ${user.connected})`);
    if (user.connected === false) {
      console.log(`   ⚠️ [ZohoMail] Candidate mailbox is marked disconnected in Zoho!`);
    }
  }

  let notConnectedCount = 0;

  while (Date.now() < deadline) {
    try {
      const inboxData = await getZohoInbox(cleanEmail, { limit: 5, start: 1 });
      if (!inboxData) {
        notConnectedCount++;
        if (notConnectedCount >= 4) {
          return { found: false, reason: 'mailbox_not_connected' };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      const accountId = userAccountId || inboxData.accountId;
      const messages = Array.isArray(inboxData.messages) ? inboxData.messages : [];

      for (const msg of messages) {
        const received = Number(msg.receivedTime) || 0;
        // Ignore old emails (allow 20s margin for clock skew)
        if (received && received < cutoff - 20000) continue;

        const subj = (msg.subject || '').toLowerCase();
        const from = (msg.from || '').toLowerCase();
        const compLower = (company || '').toLowerCase();

        const isMatch =
          from.includes('workday') ||
          from.includes('myworkday') ||
          (compLower && from.includes(compLower)) ||
          subj.includes('workday') ||
          subj.includes('verify') ||
          subj.includes('verification') ||
          subj.includes('activate') ||
          subj.includes('activation') ||
          subj.includes('reset') ||
          subj.includes('password') ||
          subj.includes('confirm') ||
          subj.includes('security code') ||
          subj.includes('one-time') ||
          subj.includes('otp');

        if (!isMatch) continue;

        // Fetch full email content
        const msgDetails = await getZohoMessage(cleanEmail, {
          accountId,
          folderId: msg.folderId,
          messageId: msg.messageId,
        });

        if (!msgDetails?.message) continue;

        const html = msgDetails.message.htmlContent || '';
        const text = msgDetails.message.textContent || '';
        const authDetails = extractWorkdayAuthDetails(html, text, msg.subject);

        if (authDetails.found) {
          return {
            ...authDetails,
            subject: msg.subject,
            messageId: msg.messageId,
          };
        }
      }
    } catch (err) {
      // transient poll error
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.log(`   ⏳ [ZohoMail] No matching verification email received for ${cleanEmail} within timeout.`);
  return { found: false, reason: 'timeout' };
}
