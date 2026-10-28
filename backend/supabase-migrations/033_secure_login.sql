-- ==============================================================================
-- Migration 033: Secure Microsoft Authenticator (TOTP) Login Schema
-- ==============================================================================
-- Additive columns on auth_users for TOTP-only authentication.
-- Rules:
--   - auth_users.status stays untouched ("account allowed to sign in").
--   - Old columns are NOT dropped or altered; preserved for backward compatibility.
--   - All existing users have mfa_enrolled = false (they re-enrol once).
-- ==============================================================================

ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS mfa_enrolled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS setup_allowed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;        -- AES-256-GCM ciphertext
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS totp_pending_enc TEXT;       -- pending secret during setup
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;       -- replay guard
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS failed_code_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE public.auth_users ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;

-- Existing users: mfa_enrolled = false for everyone (they re-enrol once)
UPDATE public.auth_users SET mfa_enrolled = false WHERE mfa_enrolled IS DISTINCT FROM false;

-- Indexes for efficient lookup
CREATE INDEX IF NOT EXISTS idx_auth_users_mfa_enrolled ON public.auth_users (mfa_enrolled);
CREATE INDEX IF NOT EXISTS idx_auth_users_setup_allowed ON public.auth_users (setup_allowed);
