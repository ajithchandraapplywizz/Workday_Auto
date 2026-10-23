-- ==============================================================================
-- DATABASE OPTIMIZATION: Drop Temporary Backup Tables & Cleanup Obsolete Tables
-- Target: Supabase (https://yuppxmwrztbirsnzgfjh.supabase.co)
-- ==============================================================================

-- 1. Drop temporary snapshot backup table (confirmed safe, 0 rows)
DROP TABLE IF EXISTS public.job_distributions_screenshot_backup_20261012 CASCADE;

-- 2. Optional: If you wish to drop legacy job_form_schemas after all scans are in scanned_jobs:
-- DROP TABLE IF EXISTS public.job_form_schemas CASCADE;

-- 3. Ensure scanned_jobs has client_count and screenshot_path indexed
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_client_count ON public.scanned_jobs (client_count);
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_job_url ON public.scanned_jobs (job_url);
