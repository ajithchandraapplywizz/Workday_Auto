-- ==============================================================================
-- Migration: 011_add_screenshot_path_to_scanned_jobs.sql
-- Description: Adds screenshot_path and client_count columns to scanned_jobs
--              so every scanned job blueprint includes the full review screenshot
--              and the total number of clients distributed for this link.
-- ==============================================================================

ALTER TABLE public.scanned_jobs
ADD COLUMN IF NOT EXISTS screenshot_path TEXT,
ADD COLUMN IF NOT EXISTS client_count INT DEFAULT 1;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
