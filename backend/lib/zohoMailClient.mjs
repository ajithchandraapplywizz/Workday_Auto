/**
 * zohoMailClient.mjs — Integration with Zoho Mail Reader on Render
 *
 * Provides real-time polling of client mailboxes for Workday confirmation links,
 * account activation URLs, password reset links, and 6-digit OTP codes.
 */

import { sanitizeWorkdayUrl } from './workdayVerification.mjs';
export { sanitizeWorkdayUrl };

const ZOHO_BASE_URL = process.env.ZOHO_MAIL_READER_URL || 'https://zoho-mail-reader.onrender.com';
const BASE_UI_URL = `${ZOHO_BASE_URL}/api/zoho/ui`;

let usersCache = null;
let usersCacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Robust JSON fetch with retry and 70s timeout to survive Render cold starts.
 */
export async function getJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(70000) });
      if (res.status === 401 || res.status === 403) {
        await ensureZohoAdminLogin();
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        if (res.status === 400 || res.status === 404) throw err;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.status === 400 || err.status === 404 || i === retries) throw err;
      await sleep(3000);
    }
  }
}

/**
 * Decode HTML entities in extracted URLs.
 */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x3D;/gi, '=')
    .replace(/&#61;/g, '=')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract all http/https links from HTML and plain text bodies.
 */
export function extractLinks(html, text) {
  const links = [];
  if (html) {
    for (const m of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      links.push(decodeEntities(m[1]));
    }
  }
  if (!links.length && text) {
    for (const m of String(text).matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
      links.push(decodeEntities(m[0]));
    }
  }
  return links.filter((l) => /^https?:\/\//i.test(l));
}

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
    const data = await getJson(`${BASE_UI_URL}/users`, 1);
    usersCache = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
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
 * Check if candidate's mailbox is connected in Zoho Mail Reader.
 */
export async function isZohoMailboxConnected(email) {
  if (!email) return false;
  const clean = String(email).trim().toLowerCase();
  try {
    const user = await getZohoUser(clean);
    if (user) {
      if (user.connected === false || user.status === 'not_connected' || user.status === 'disconnected') {
        return false;
      }
      if (user.connected === true || user.status === 'active') {
        return true;
      }
    }
    const probe = await getZohoInbox(clean, { limit: 1 });
    return Boolean(probe && probe.accountId);
  } catch {
    return false;
  }
}

/**
 * Ensure admin login on Zoho Mail Reader so all mailboxes can be accessed.
 */
export async function ensureZohoAdminLogin() {
  const username = process.env.ZOHO_ADMIN_USERNAME || 'Created@123';
  const password = process.env.ZOHO_ADMIN_PASSWORD || 'Applywizz@2026';
  try {
    const res = await fetch(`${BASE_UI_URL}/login`, {
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
    const url = `${BASE_UI_URL}/inbox?email=${encodeURIComponent(clean)}&limit=${limit}&start=${start}`;
    return await getJson(url, 1);
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
    const url = `${BASE_UI_URL}/message?${params.toString()}`;
    return await getJson(url, 1);
  } catch (err) {
    console.warn(`  ⚠️ [ZohoMail] Failed to fetch message ${messageId}: ${err.message}`);
    return null;
  }
}

/**
 * Extract the Workday tenant subdomain from a URL or hostname.
 * e.g. "https://ncr.wd1.myworkdayjobs.com/ext_us/job/..." -> "ncr"
 *      "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/..." -> "td"
 *      "https://xcelenergy.wd1.myworkdayjobs.com/..." -> "xcelenergy"
 */
export function extractWorkdayTenant(url = '') {
  if (!url || typeof url !== 'string') return '';
  try {
    const raw = url.startsWith('http') ? url : `https://${url}`;
    const host = new URL(raw).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9_-]+)\.wd[0-9]*\.myworkday/i);
    if (match) return match[1].toLowerCase();
    const parts = host.split('.');
    if (parts.length >= 3 && host.includes('workday')) {
      return parts[0].toLowerCase();
    }
  } catch {}
  return '';
}

/**
 * Check if an email from/subject/body/link matches the target company or tenant.
 */
export function isWorkdayCompanyMatch({ from = '', subject = '', body = '', link = '', company = '', tenant = '' } = {}) {
  const normTenant = String(tenant || '').trim().toLowerCase();
  const normCompany = String(company || '').trim().toLowerCase();
  const cleanFrom = String(from || '').toLowerCase();
  const cleanSub = String(subject || '').toLowerCase();
  const cleanBody = String(body || '').toLowerCase();
  const cleanLink = String(link || '').toLowerCase();

  // 1. Tenant match (highest confidence)
  if (normTenant) {
    if (cleanLink.includes(`${normTenant}.`) || cleanLink.includes(`/${normTenant}/`) || cleanLink.includes(`/${normTenant}_`)) {
      return true;
    }
    if (cleanFrom.includes(`${normTenant}@`) || cleanFrom.includes(normTenant)) {
      return true;
    }
    if (cleanSub.includes(normTenant) || cleanBody.includes(normTenant)) {
      return true;
    }
  }

  // 2. Company name match
  if (normCompany) {
    const tokens = normCompany
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !['inc', 'corp', 'corporation', 'llc', 'ltd', 'company', 'co', 'the', 'group'].includes(t));

    for (const tok of tokens) {
      if (cleanFrom.includes(tok) || cleanSub.includes(tok) || cleanBody.includes(tok) || cleanLink.includes(tok)) {
        return true;
      }
    }
  }

  // 3. Fallback: if no specific company/tenant was requested, match general Workday auth email
  if (!normTenant && !normCompany) {
    return cleanFrom.includes('workday') || cleanSub.includes('workday') || cleanLink.includes('workday');
  }

  return false;
}

/**
 * Direct verification link extraction engine provided by user specifications.
 * Checks /users -> polls /inbox -> fetches full /message -> extracts & decodes authentic link.
 */
export async function getVerificationLink({
  email,
  company = '',
  jobUrl = '',
  triggerTime = null,
  senderIncludes = '',
  subjectIncludes = ['verify', 'confirm', 'activate', 'workday', 'welcome', 'reset', 'password'],
  limit = 10,
  intervalMs = 2500,
  timeoutMs = 60000,
} = {}) {
  const enc = encodeURIComponent(email);
  const tenant = extractWorkdayTenant(jobUrl);
  const effectiveCutoff = triggerTime ? (Number(triggerTime) - 15000) : (Date.now() - 300000);

  // Step 1: Check mailbox connection status in Zoho
  const users = await getJson(`${BASE_UI_URL}/users`, 1).catch(() => null);
  const usersStr = JSON.stringify(users || {}).toLowerCase();
  if (users && !usersStr.includes(email.toLowerCase())) {
    const probe = await getJson(`${BASE_UI_URL}/inbox?email=${enc}&limit=1`, 0).catch(() => null);
    if (!probe?.accountId) {
      throw new Error(`Mailbox not found in users list: ${email}`);
    }
  }
  console.log(`   ✓ [ZohoMail] Mailbox connection verified for ${email}`);
  if (company || tenant) {
    console.log(`   🎯 [ZohoMail] Targeted Employer Match: ${company ? `Company: "${company}"` : ''} ${tenant ? `Tenant: "${tenant}"` : ''} (Cutoff: ${new Date(effectiveCutoff).toLocaleTimeString()})`);
  }

  // Step 2: Poll inbox until deadline
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inbox = await getJson(`${BASE_UI_URL}/inbox?email=${enc}&limit=${limit}`, 0).catch(() => null);
    const messages = Array.isArray(inbox?.messages) ? inbox.messages : [];

    const validCandidates = messages
      .filter((m) => Number(m.receivedTime) >= effectiveCutoff)
      .filter((m) => !senderIncludes || (m.from || '').toLowerCase().includes(senderIncludes.toLowerCase()))
      .filter(
        (m) =>
          !subjectIncludes.length ||
          subjectIncludes.some((k) => (m.subject || '').toLowerCase().includes(k.toLowerCase()))
      )
      .sort((a, b) => Number(b.receivedTime) - Number(a.receivedTime));

    for (const match of validCandidates) {
      // Step 3: Fetch full message
      const url =
        `${BASE_UI_URL}/message?email=${enc}&accountId=${inbox.accountId}` +
        `&folderId=${match.folderId}&messageId=${match.messageId}`;
      const msgRes = await getJson(url, 1).catch(() => null);
      const message = msgRes?.message || msgRes;
      const htmlContent = message?.htmlContent || '';
      const textContent = message?.textContent || '';

      // Check company/tenant matching on envelope and body
      const isMatch = isWorkdayCompanyMatch({
        from: match.from,
        subject: match.subject,
        body: `${htmlContent} ${textContent}`,
        company,
        tenant,
      });

      if (!isMatch && (company || tenant)) {
        // Skip emails from other companies!
        continue;
      }

      // Step 4: Extract and decode authentic Workday auth link
      const authDetails = extractWorkdayAuthDetails(htmlContent, textContent, match.subject, {
        company,
        tenant,
        jobUrl,
      });

      if (authDetails.found && authDetails.verificationLink) {
        const cleanLink = sanitizeWorkdayUrl(authDetails.verificationLink) || authDetails.verificationLink;
        console.log(`   🎉 [ZohoMail] Found authentic ${authDetails.type || 'verification'} link for "${company || tenant || 'Workday'}": ${cleanLink}`);
        return cleanLink;
      }

      // Secondary fallback with noise filtering
      const links = extractLinks(htmlContent, textContent);
      const filtered = links
        .map((l) => sanitizeWorkdayUrl(l) || l)
        .filter((l) => !/privacy|terms|legal|cookie|unsubscribe|preferences|static\/|\.(png|jpg|jpeg|svg|gif|ico)/i.test(l))
        .filter((l) => /activate|verification|verify|passwordreset|resetpassword|token=/i.test(l));

      if (filtered.length > 0) {
        const bestLink = (tenant ? filtered.find(l => l.toLowerCase().includes(tenant)) : null) || filtered[0];
        console.log(`   🎉 [ZohoMail] Found authentic verification link in email (filtered): ${bestLink}`);
        return bestLink;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`No matching verification email for ${email} (${company || tenant || 'Workday'}) within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Robust Workday link & OTP code extractor from HTML and plain-text email bodies.
 */
export function extractWorkdayAuthDetails(html = '', text = '', subject = '', options = {}) {
  const company = options.company || '';
  const tenant = options.tenant || extractWorkdayTenant(options.jobUrl || '');
  const cleanHtml = String(html || '');
  const cleanText = String(text || '');
  const combined = `${cleanHtml}\n${cleanText}`;

  // 1. Extract href links and text URLs
  const allCandidates = extractLinks(cleanHtml, cleanText);

  // Helper to reject noise / non-auth links
  const isNoise = (u) => {
    return (
      /privacy|terms|legal|cookie|unsubscribe|preferences|help\.workday|support\.workday|static\/|\.(png|jpg|jpeg|svg|gif|ico)/i.test(u) ||
      /^https?:\/\/(www\.)?workday\.com\/?([a-z]{2}-[a-z]{2}\/?)?$/i.test(u)
    );
  };

  const scored = [];
  for (const rawUrl of allCandidates) {
    const cleanUrl = sanitizeWorkdayUrl(rawUrl);
    if (!cleanUrl) continue;
    if (isNoise(cleanUrl)) continue;
    if (!cleanUrl.toLowerCase().includes('myworkday') && !cleanUrl.toLowerCase().includes('workday')) continue;

    const lower = cleanUrl.toLowerCase();
    let score = 0;
    let type = 'link';

    if (/activate|verification|verify/i.test(lower)) {
      score += 160;
      type = 'link';
    } else if (/resetpassword|passwordreset|\/reset\//i.test(lower)) {
      score += 150;
      type = 'reset';
    } else if (lower.includes('token=')) {
      score += 130;
      type = 'link';
    } else if (lower.includes('/auth/') || lower.includes('/login') || lower.includes('/apply/')) {
      score += 70;
      type = 'link';
    }

    // Tenant / Company scoring alignment
    if (tenant) {
      if (lower.includes(`${tenant}.`) || lower.includes(`/${tenant}/`) || lower.includes(`/${tenant}_`)) {
        score += 300; // Exact tenant match boost
      } else {
        const linkTenant = extractWorkdayTenant(cleanUrl);
        if (linkTenant && linkTenant !== tenant) {
          score -= 400; // Penalize link from different company tenant
        }
      }
    } else if (company) {
      const compTokens = company.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
      for (const tok of compTokens) {
        if (lower.includes(tok)) score += 100;
      }
    }

    if (score > 0) {
      scored.push({ url: cleanUrl, score, type });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const top = scored[0];
    return {
      found: true,
      type: top.type,
      verificationLink: top.url,
    };
  }

  // 2. Extract 6-digit OTP code if present
  const codeMatch = combined.match(/\b([0-9]{6})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
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
 */
export async function pollZohoWorkdayAuth({
  email,
  company = '',
  jobUrl = '',
  cutoffTime = null,
  triggerTime = null,
  timeoutMs = 60000,
  pollIntervalMs = 1500,
} = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return { found: false, reason: 'missing_email' };

  const tenant = extractWorkdayTenant(jobUrl);
  const effectiveTriggerTime = triggerTime || cutoffTime || (Date.now() - 300000);
  const cutoff = effectiveTriggerTime ? (Number(effectiveTriggerTime) - 15000) : (Date.now() - 300000);

  console.log(`   📧 [ZohoMail] Polling Zoho Mail Reader for ${cleanEmail}${company ? ` (${company})` : ''}${tenant ? ` [tenant: ${tenant}]` : ''} (cutoff: ${new Date(cutoff).toLocaleTimeString()})...`);

  // Fast check: verify user in users list
  const user = await getZohoUser(cleanEmail);
  if (user) {
    console.log(`   ✓ [ZohoMail] Candidate account verified in Zoho: ${cleanEmail} (Connected: ${user.connected})`);
    if (user.connected === false || user.status === 'not_connected' || user.status === 'disconnected') {
      console.log(`   ❌ [ZohoMail] Candidate mailbox is marked disconnected in Zoho!`);
      return { found: false, reason: 'mailbox_not_connected', isZohoNotConnected: true };
    }
  } else {
    // If not found in users array, verify with a direct probe
    const probeInbox = await getZohoInbox(cleanEmail, { limit: 1 });
    if (!probeInbox?.accountId) {
      console.log(`   ❌ [ZohoMail] Candidate ${cleanEmail} is not connected in Zoho Mail Reader!`);
      return { found: false, reason: 'mailbox_not_connected', isZohoNotConnected: true };
    }
  }

  // Try direct getVerificationLink engine first
  try {
    const directLink = await getVerificationLink({
      email: cleanEmail,
      company,
      jobUrl,
      triggerTime: effectiveTriggerTime,
      timeoutMs: Math.min(timeoutMs, 45000),
      intervalMs: Math.max(pollIntervalMs, 2500),
    });
    if (directLink) {
      return {
        found: true,
        type: 'link',
        verificationLink: directLink,
      };
    }
  } catch (directErr) {
    if (directErr.message?.includes('Mailbox not found in users list')) {
      return { found: false, reason: 'mailbox_not_connected' };
    }
  }

  // Fallback to message-by-message evaluation loop
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inboxData = await getZohoInbox(cleanEmail, { limit: 5, start: 1 });
      if (inboxData?.messages) {
        const accountId = inboxData.accountId;
        for (const msg of inboxData.messages) {
          const received = Number(msg.receivedTime) || 0;
          if (received && received < cutoff) continue;

          // Company/tenant filtering on envelope
          const isEnvMatch = isWorkdayCompanyMatch({
            from: msg.from,
            subject: msg.subject,
            company,
            tenant,
          });
          if (!isEnvMatch && (company || tenant)) continue;

          const msgDetails = await getZohoMessage(cleanEmail, {
            accountId,
            folderId: msg.folderId,
            messageId: msg.messageId,
          });
          if (msgDetails?.message) {
            const html = msgDetails.message.htmlContent || '';
            const text = msgDetails.message.textContent || '';
            const authDetails = extractWorkdayAuthDetails(html, text, msg.subject, {
              company,
              tenant,
              jobUrl,
            });
            if (authDetails.found) {
              return {
                ...authDetails,
                subject: msg.subject,
                messageId: msg.messageId,
              };
            }
          }
        }
      }
    } catch {}
    await sleep(pollIntervalMs);
  }

  console.log(`   ⏳ [ZohoMail] No matching verification email received for ${cleanEmail} within timeout.`);
  return { found: false, reason: 'timeout' };
}
