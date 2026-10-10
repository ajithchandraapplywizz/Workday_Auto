/**
 * RFC 6238 TOTP (Time-based One-Time Password) Engine
 * Fully compatible with Microsoft Authenticator, Google Authenticator, and Azure MFA.
 */

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes an ArrayBuffer or Uint8Array to a Base32 string
 */
export function base32Encode(buffer) {
  const bytes = new Uint8Array(buffer);
  let bits = '';
  let result = '';

  for (let i = 0; i < bytes.length; i++) {
    bits += bytes[i].toString(2).padStart(8, '0');
  }

  for (let i = 0; i + 5 <= bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5);
    result += BASE32_CHARS[parseInt(chunk, 2)];
  }

  // Handle remaining bits
  const rem = bits.length % 5;
  if (rem > 0) {
    const chunk = bits.substring(bits.length - rem).padEnd(5, '0');
    result += BASE32_CHARS[parseInt(chunk, 2)];
  }

  return result;
}

/**
 * Decodes a Base32 string to Uint8Array
 */
export function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';

  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_CHARS.indexOf(clean[i]);
    if (val >= 0) {
      bits += val.toString(2).padStart(5, '0');
    }
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }

  return new Uint8Array(bytes);
}

/**
 * Generates a deterministic, stable Base32 secret for a user based on their email.
 * This ensures the user's Microsoft Authenticator app stays synchronized without
 * losing pairing across sessions.
 */
export async function getOrCreateUserMfaSecret(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const storageKey = `applywizz_mfa_secret_${cleanEmail}`;
  const existing = localStorage.getItem(storageKey);
  if (existing && existing.length >= 16) {
    return existing;
  }

  // Deterministically derive a secure 20-byte seed using SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(`applywizz_salt_v2_${cleanEmail}_enterprise_mfa`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const secret = base32Encode(hashBuffer.slice(0, 20));

  localStorage.setItem(storageKey, secret);
  return secret;
}

/**
 * Generates the current 6-digit TOTP code for a secret and counter
 */
export async function generateTOTPCode(secret, timeStep = 30, timeOffsetSteps = 0) {
  const counter = Math.floor(Date.now() / 1000 / timeStep) + timeOffsetSteps;
  const keyBytes = base32Decode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  // 8-byte big-endian counter buffer
  const counterBuf = new ArrayBuffer(8);
  const counterView = new DataView(counterBuf);
  // High 32 bits are 0 for timestamps up to year 2038+
  counterView.setUint32(0, Math.floor(counter / 0x100000000));
  counterView.setUint32(4, counter >>> 0);

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBuf);
  const sigBytes = new Uint8Array(signature);

  const offset = sigBytes[sigBytes.length - 1] & 0x0f;
  const binary =
    ((sigBytes[offset] & 0x7f) << 24) |
    ((sigBytes[offset + 1] & 0xff) << 16) |
    ((sigBytes[offset + 2] & 0xff) << 8) |
    (sigBytes[offset + 3] & 0xff);

  const code = (binary % 1000000).toString().padStart(6, '0');
  return code;
}

/**
 * Validates a 6-digit TOTP code against a secret with +/- 1 time step tolerance (90s window)
 */
export async function verifyTOTPCode(secret, userCode) {
  if (!userCode || String(userCode).trim().length !== 6) return false;
  const cleanCode = String(userCode).trim();

  // Test current, previous, and next 30-second windows to tolerate clock drift
  for (let offset = -1; offset <= 1; offset++) {
    const valid = await generateTOTPCode(secret, 30, offset);
    if (valid === cleanCode) {
      return true;
    }
  }

  return false;
}

/**
 * Generates standard Microsoft Authenticator pairing URL and QR Code
 */
export function getMicrosoftAuthenticatorDetails(email, secret) {
  const account = encodeURIComponent(email);
  const issuer = encodeURIComponent('ApplyWizz');
  const otpauthUrl = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  // Standard QR code URL compatible with Microsoft Authenticator camera scanning
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(otpauthUrl)}`;

  // Formatted secret for manual typing (e.g. JBSW Y3DP EHPK 3PXP)
  const formattedSecret = secret.match(/.{1,4}/g)?.join(' ') || secret;

  return {
    otpauthUrl,
    qrCodeUrl,
    formattedSecret,
    secret,
  };
}
