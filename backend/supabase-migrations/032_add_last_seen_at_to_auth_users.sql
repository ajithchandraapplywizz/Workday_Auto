-- ==============================================================================
-- Migration 032: Add nullable last_seen_at timestamptz column to auth_users
-- ==============================================================================
-- Description:
--   Enables backend-driven presence tracking (online/offline).
--   - Added as a nullable timestamptz column (additive).
--   - Online status is computed dynamically on read (last_seen_at <= 2 minutes).
--   - Preserves auth_users.status as the "account allowed to sign in" flag.
-- ==============================================================================

ALTER TABLE public.auth_users
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NULL;

-- Index for efficient presence reads and active-user window lookups
CREATE INDEX IF NOT EXISTS idx_auth_users_last_seen_at ON public.auth_users (last_seen_at);
