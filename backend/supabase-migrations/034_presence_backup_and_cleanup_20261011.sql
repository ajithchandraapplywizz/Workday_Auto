-- ==============================================================================
-- Migration 034: Auth Users Presence Backup and Cleanup
-- ==============================================================================
-- 1. One-time additive, reversible backup of current auth_users presence state:
CREATE TABLE IF NOT EXISTS public.auth_users_presence_backup_20261011 AS
  SELECT id, email, status, last_seen_at FROM public.auth_users;

-- 2. Clear stale last_seen_at older than 2 minutes (does NOT change auth_users.status):
UPDATE public.auth_users
SET last_seen_at = NULL
WHERE last_seen_at < NOW() - INTERVAL '2 minutes';
