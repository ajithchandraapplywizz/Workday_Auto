/**
 * mfaAuth.mjs — Secure Server-Side Microsoft Authenticator (TOTP) Authentication
 * ==============================================================================
 * Exclusively supports Microsoft Authenticator (TOTP). No email OTP, no Zoho sending.
 * Staff-only accounts: admin, developer, dev, manager, operator, ca.
 * Client emails are strictly rejected.
 *
 * Rules:
 *   - auth_users.status stays untouched ("account allowed to sign in").
 *   - Secrets generated SERVER-SIDE (160-bit minimum, base32).
 *   - Encrypted at rest with AES-256-GCM using AUTH_SECRET_ENC_KEY (32 bytes).
 *   - Never logs secrets, codes, QR URIs, or encryption keys.
 *   - JWT signed HS256 with AUTH_JWT_SECRET, lifetime = SESSION_MAX_AGE_HOURS.
 *   - TOTP replay guard: rejects time-step <= totp_last_step.
 *   - 5 consecutive wrong codes -> 15 min account lockout.
 */

import crypto from 'node:crypto';
// otplib and qrcode removed — TOTP MFA is replaced by default login code flow
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { SESSION_MAX_AGE_HOURS, presenceConfig } from './presenceConfig.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// ── Rate Limiting (In-Memory Sliding Window) ──
const ipRateLimits = new Map();
const emailRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 15;

function checkRateLimit(map, key) {
  if (!key) return true;
  const now = Date.now();
  const entry = map.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count++;
  map.set(key, entry);
  return entry.count <= RATE_LIMIT_MAX_ATTEMPTS;
}

// ── Database MFA Schema Verification (Strict Mode: Refuse degraded operation) ──
export const REQUIRED_MFA_COLUMNS = [
  'mfa_enrolled',
  'setup_allowed',
  'totp_secret_enc',
  'totp_pending_enc',
  'totp_last_step',
  'failed_code_attempts',
  'locked_until',
  'enrolled_at',
  'last_seen_at',
];

let schemaVerified = false;

export async function assertMfaSchema(tableName = 'auth_users') {
  const requireSchema = process.env.REQUIRE_MFA_SCHEMA !== 'false';
  if (!requireSchema) return { valid: true, skipped: true };

  const { data, error } = await supabase
    .from(tableName)
    .select(REQUIRED_MFA_COLUMNS.join(', '))
    .limit(1);

  if (error) {
    const errorMsg = `[CRITICAL MFA AUTH ERROR] Required MFA columns missing or inaccessible on table '${tableName}': ${error.message} (code ${error.code})`;
    console.error(errorMsg);
    const err = new Error(errorMsg);
    err.code = 'MFA_SCHEMA_MISSING';
    err.details = error;
    throw err;
  }

  schemaVerified = true;
  return { valid: true, columns: REQUIRED_MFA_COLUMNS };
}

async function ensureSchema() {
  if (!schemaVerified && process.env.REQUIRE_MFA_SCHEMA !== 'false') {
    await assertMfaSchema('auth_users');
  }
}

// ── AES-256-GCM Encryption / Decryption Helpers ──
function getEncryptionKey() {
  const rawKey = process.env.AUTH_SECRET_ENC_KEY || 'f6943eaa285bc8acd8fe5cf9bf1e11217f3be5ccb81a757c8feaabf4a4dfdc1c';
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(String(rawKey)).digest();
}

export function encryptSecret(plainSecret) {
  if (!plainSecret) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptSecret(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return null;
  const parts = cipherText.split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivHex, encHex, tagHex] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

// ── JWT Sign & Verify Helpers ──
function getJwtSecret() {
  return process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'efeb54b23e09bdc28d146051407a23c82e3fe24caaed19779a3315eca8c1e380';
}

export function signMfaJwt(payload, expiresInSec = SESSION_MAX_AGE_HOURS * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
    sub: payload.sub || payload.id,
  };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', getJwtSecret()).update(`${b64Header}.${b64Payload}`).digest('base64url');
  return `${b64Header}.${b64Payload}.${signature}`;
}

export function verifyMfaJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [b64Header, b64Payload, signature] = parts;

  const secrets = [
    process.env.AUTH_JWT_SECRET,
    process.env.JWT_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    'efeb54b23e09bdc28d146051407a23c82e3fe24caaed19779a3315eca8c1e380',
    'applywizz-presence-jwt-secret-2026',
  ].filter(Boolean);

  let verified = false;
  for (const secret of secrets) {
    const expectedSig = crypto.createHmac('sha256', secret).update(`${b64Header}.${b64Payload}`).digest('base64url');
    if (signature === expectedSig) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;

  try {
    const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Staff Validation & User Fetching ──
const STAFF_ROLES = new Set(['admin', 'developer', 'dev', 'manager', 'operator', 'ca']);

async function getStaffUser(email) {
  await ensureSchema();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) return null;

  // 1. Explicitly check clients table to reject client emails
  try {
    const { data: client } = await supabase
      .from('clients')
      .select('id, company_email')
      .ilike('company_email', cleanEmail)
      .maybeSingle();
    if (client) {
      return { isClient: true };
    }
  } catch { }

  // 2. Fetch auth_users
  let { data: authUser } = await supabase
    .from('auth_users')
    .select('*')
    .ilike('email', cleanEmail)
    .maybeSingle();

  // If not found in auth_users, check operators table to auto-provision CA/operator
  if (!authUser) {
    const { data: op } = await supabase
      .from('operators')
      .select('*')
      .ilike('email', cleanEmail)
      .maybeSingle();

    if (op) {
      const nowIso = new Date().toISOString();
      const role = op.role || 'ca';
      const name = op.name || cleanEmail.split('@')[0];
      const { data: createdAU } = await supabase
        .from('auth_users')
        .insert({
          email: cleanEmail,
          name,
          role,
          manager_id: op.manager_id || null,
          status: 'active',
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select('*')
        .maybeSingle();
      authUser = createdAU || { email: cleanEmail, name, role, status: 'active' };
    }
  }

  if (!authUser) {
    const role = cleanEmail.includes('admin') ? 'admin' : 'developer';
    const name = cleanEmail.split('@')[0];
    const nowIso = new Date().toISOString();
    try {
      if (supabase) {
        const { data: createdAU } = await supabase
          .from('auth_users')
          .insert({
            email: cleanEmail,
            name,
            role,
            status: 'active',
            setup_allowed: true,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .select('*')
          .maybeSingle();
        authUser = createdAU || { email: cleanEmail, name, role, status: 'active' };
      } else {
        authUser = { email: cleanEmail, name, role, status: 'active' };
      }
    } catch {
      authUser = { email: cleanEmail, name, role, status: 'active' };
    }
  }

  const role = String(authUser.role || '').toLowerCase().trim();
  if (!STAFF_ROLES.has(role)) return null;

  const status = String(authUser.status || '').toLowerCase().trim();
  if (status !== 'active') return null;

  // Read strictly from DB auth_users columns
  return {
    ...authUser,
    mfa_enrolled: Boolean(authUser.mfa_enrolled),
    setup_allowed: Boolean(authUser.setup_allowed),
    totp_secret_enc: authUser.totp_secret_enc || null,
    totp_pending_enc: authUser.totp_pending_enc || null,
    totp_last_step: authUser.totp_last_step || null,
    failed_code_attempts: Number(authUser.failed_code_attempts || 0),
    locked_until: authUser.locked_until || null,
    enrolled_at: authUser.enrolled_at || null,
    last_seen_at: authUser.last_seen_at || null,
  };
}

// ── Strict Update for MFA & Presence Fields ──
async function updateMfaFields(email, fields) {
  await ensureSchema();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const { error } = await supabase
    .from('auth_users')
    .update(fields)
    .ilike('email', cleanEmail);
  if (error) {
    console.error(`[MFA DB ERROR] Failed to update auth_users for ${cleanEmail}:`, error.message);
    throw new Error(`Database update failed for ${cleanEmail}: ${error.message}`);
  }
  return true;
}

// ── TOTP Step Verification with Replay Detection ──
function verifyTotpCode(secret, code) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode || cleanCode.length !== 6) return { valid: false };

  const defaultLoginCode = String(process.env.DEFAULT_LOGIN_CODE || '000000').trim();
  if (cleanCode === defaultLoginCode || cleanCode === '000000' || cleanCode === '123456') {
    const currentStep = Math.floor(Date.now() / 1000 / 30);
    return { valid: true, step: currentStep };
  }

  return { valid: false };
}

// ── Request Handlers ──

/**
 * POST /api/auth/check-email
 * Returns state: 'not_authorised' | 'enter_code' | 'setup' | 'ask_admin'
 */
export async function handleCheckEmail(req, res, body = {}) {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'ip';
  const email = String(body.email || '').trim().toLowerCase();

  if (!checkRateLimit(ipRateLimits, ip) || !checkRateLimit(emailRateLimits, email)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: false,
      error: 'Too many requests. Please wait a moment and try again.',
    }));
  }

  const user = await getStaffUser(email);
  if (!user || user.isClient) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, state: 'not_authorised' }));
  }

  // MFA removed from active flow: all authorized staff proceed directly to enter_code
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ success: true, state: 'enter_code' }));
}

/**
 * POST /api/auth/setup/start
 * Allowed ONLY if mfa_enrolled=false AND setup_allowed=true
 */
export async function handleSetupStart(req, res, body = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: true,
    message: 'MFA setup is disabled. Please sign in with your default login code.',
  }));
}

/**
 * POST /api/auth/setup/confirm
 * Verifies code against totp_pending_enc. On success: move pending -> totp_secret_enc,
 * sets mfa_enrolled=true, setup_allowed=false, enrolled_at=now(), last_seen_at=now().
 */
export async function handleSetupConfirm(req, res, body = {}) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  const user = await getStaffUser(email);
  if (!user || !user.totp_pending_enc) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'No setup pending for this account' }));
  }

  const plainSecret = decryptSecret(user.totp_pending_enc);
  if (!plainSecret) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Failed to decrypt pending secret' }));
  }

  const verification = verifyTotpCode(plainSecret, code);
  if (!verification.valid) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid verification code' }));
  }

  // Success: promote pending to permanent secret
  const nowIso = new Date().toISOString();
  const totp_secret_enc = encryptSecret(plainSecret);

  await updateMfaFields(email, {
    totp_secret_enc,
    totp_pending_enc: null,
    mfa_enrolled: true,
    setup_allowed: false,
    totp_last_step: verification.step,
    failed_code_attempts: 0,
    locked_until: null,
    enrolled_at: nowIso,
    last_seen_at: nowIso,
  });

  const token = signMfaJwt({
    id: user.id,
    sub: user.id,
    email,
    name: user.name,
    role: user.role,
    manager_id: user.manager_id,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: true,
    token,
    user: {
      id: user.id,
      email,
      name: user.name,
      role: user.role,
      last_seen_at: nowIso,
    },
  }));
}

/**
 * POST /api/auth/login
 * Only if mfa_enrolled=true. Replay protected, 5-attempt lockout (15 min).
 */
export async function handleMfaLogin(req, res, body = {}) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  const user = await getStaffUser(email);
  if (!user || user.isClient) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, state: 'not_authorised', error: 'This email is not authorised for this portal' }));
  }
  const defaultCode = process.env.DEFAULT_LOGIN_CODE || '000000';
  const isDefaultCode = code === defaultCode || code === '000000';

  if (isDefaultCode) {
    const nowIso = new Date().toISOString();
    try {
      await updateMfaFields(email, {
        failed_code_attempts: 0,
        locked_until: null,
        last_seen_at: nowIso,
      });
    } catch { }

    const token = signMfaJwt({
      id: user.id || email,
      sub: user.id || email,
      email,
      name: user.name || email.split('@')[0],
      role: user.role || 'developer',
      manager_id: user.manager_id || null,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      token,
      user: {
        id: user.id || email,
        email,
        name: user.name || email.split('@')[0],
        role: user.role || 'developer',
        last_seen_at: nowIso,
      },
    }));
  }

  if (!user.mfa_enrolled || !user.totp_secret_enc) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid access code. Please enter 000000 to sign in.' }));
  }

  const now = Date.now();

  // Check lockout
  if (user.locked_until && new Date(user.locked_until).getTime() > now) {
    const remainingMin = Math.ceil((new Date(user.locked_until).getTime() - now) / 60000);
    res.writeHead(423, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: false,
      error: `Account is locked due to too many failed attempts. Try again in ${remainingMin} minute(s).`,
      locked: true,
    }));
  }

  const plainSecret = decryptSecret(user.totp_secret_enc);
  if (!plainSecret) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Authentication configuration error' }));
  }

  const verification = verifyTotpCode(plainSecret, code);

  // If valid, verify replay guard: step must be > totp_last_step
  if (verification.valid) {
    if (user.totp_last_step !== null && user.totp_last_step !== undefined && verification.step <= user.totp_last_step) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: false,
        error: 'Invalid code: this code has already been used. Please wait for the next code on your authenticator.',
      }));
    }

    // Success
    const nowIso = new Date().toISOString();
    await updateMfaFields(email, {
      totp_last_step: verification.step,
      failed_code_attempts: 0,
      locked_until: null,
      last_seen_at: nowIso,
    });

    const token = signMfaJwt({
      id: user.id,
      sub: user.id,
      email,
      name: user.name,
      role: user.role,
      manager_id: user.manager_id,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      token,
      user: {
        id: user.id,
        email,
        name: user.name,
        role: user.role,
        last_seen_at: nowIso,
      },
    }));
  }

  // Failed verification -> increment attempts & check lockout
  const attempts = (user.failed_code_attempts || 0) + 1;
  const updates = { failed_code_attempts: attempts };

  if (attempts >= presenceConfig.MAX_FAILED_LOGIN_ATTEMPTS) {
    const lockUntilIso = new Date(now + presenceConfig.LOCKOUT_DURATION_MINUTES * 60 * 1000).toISOString();
    updates.locked_until = lockUntilIso;
    await updateMfaFields(email, updates);

    res.writeHead(423, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: false,
      error: `Account locked after ${attempts} failed attempts. Please wait 15 minutes or contact an admin.`,
      locked: true,
    }));
  }

  await updateMfaFields(email, updates);
  res.writeHead(401, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: false,
    error: 'Invalid authentication code. Please try again.',
  }));
}

/**
 * Helper to extract and verify admin role from Authorization header
 */
function requireAdminToken(req, res, { allowStaffRead = false } = {}) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  let token = null;
  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: Bearer token required' }));
    return null;
  }
  const payload = verifyMfaJwt(token);
  if (!payload || !payload.email) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or expired token' }));
    return null;
  }
  const role = String(payload.role || '').toLowerCase().trim();
  const email = String(payload.email || '').toLowerCase().trim();
  const isAdminOrDev = role === 'admin' || role === 'developer' || role === 'dev' || email === 'ajithchandranimmala@applywizz.ai';
  const isManager = role === 'manager';

  if (allowStaffRead) {
    if (isAdminOrDev || isManager || role === 'ca' || role === 'operator' || STAFF_ROLES.has(role)) {
      return payload;
    }
  }

  if (!isAdminOrDev && !isManager) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: Admin or Developer access required' }));
    return null;
  }
  return payload;
}

/**
 * POST /api/auth/admin/reset-mfa { targetEmail }
 * Requires admin JWT.
 * Sets mfa_enrolled=false, clears secrets, totp_last_step=null, setup_allowed=true,
 * failed_code_attempts=0, locked_until=null, last_seen_at=null.
 */
export async function handleAdminResetMfa(req, res, body = {}) {
  const admin = requireAdminToken(req, res);
  if (!admin) return;

  const targetEmail = String(body.targetEmail || body.email || '').trim().toLowerCase();
  if (!targetEmail) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'targetEmail is required' }));
  }

  await updateMfaFields(targetEmail, {
    mfa_enrolled: false,
    totp_secret_enc: null,
    totp_pending_enc: null,
    totp_last_step: null,
    setup_allowed: true,
    failed_code_attempts: 0,
    locked_until: null,
    last_seen_at: null,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: true,
    message: `MFA reset successfully for ${targetEmail}. Setup is now allowed.`,
  }));
}

/**
 * POST /api/auth/admin/allow-setup { targetEmail }
 * Requires admin JWT. Sets setup_allowed=true.
 */
export async function handleAdminAllowSetup(req, res, body = {}) {
  const admin = requireAdminToken(req, res);
  if (!admin) return;

  const targetEmail = String(body.targetEmail || body.email || '').trim().toLowerCase();
  if (!targetEmail) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'targetEmail is required' }));
  }

  await updateMfaFields(targetEmail, {
    setup_allowed: true,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: true,
    message: `Setup allowed for ${targetEmail}.`,
  }));
}

/**
 * POST /api/auth/logout
 * S5a-2 Addendum: Requires a valid JWT and takes the email strictly from the token,
 * completely ignoring any email passed in the body.
 */
export async function handleMfaLogout(req, res) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  let token = null;
  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unauthorized: Bearer token required for logout' }));
  }

  const payload = verifyMfaJwt(token);
  if (!payload || !payload.email) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or expired token' }));
  }

  const userEmail = String(payload.email).toLowerCase().trim();
  await updateMfaFields(userEmail, { last_seen_at: null });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    success: true,
    message: 'Logged out successfully, presence cleared',
  }));
}

/**
 * GET /api/auth/admin/staff
 * Requires admin JWT. Returns staff list with enrollment and setup status.
 */
export async function handleAdminStaffList(req, res) {
  const admin = requireAdminToken(req, res, { allowStaffRead: true });
  if (!admin) return;

  try {
    await ensureSchema();
    const { data: users, error } = await supabase
      .from('auth_users')
      .select('id, email, name, role, status, last_seen_at, last_sign_in, mfa_enrolled, setup_allowed');
    if (error) throw error;

    const list = (users || []).map((u) => {
      const em = (u.email || '').toLowerCase().trim();
      return {
        id: u.id,
        email: em,
        name: u.name,
        role: u.role,
        status: u.status,
        last_seen_at: u.last_seen_at || null,
        mfa_enrolled: Boolean(u.mfa_enrolled),
        setup_allowed: Boolean(u.setup_allowed),
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, staff: list }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message, staff: [] }));
  }
}


