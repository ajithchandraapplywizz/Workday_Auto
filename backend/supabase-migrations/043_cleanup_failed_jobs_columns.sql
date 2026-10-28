-- Migration 043: Consolidate failure screenshots into screenshot_path and drop redundant failure_screenshot_url
-- Purpose:
--   1. Ensures all existing failure screenshot URLs in failed_jobs are preserved in screenshot_path.
--   2. Drops the duplicate column failure_screenshot_url from failed_jobs so only screenshot_path exists.
--   3. Drops any legacy index on failure_screenshot_url.

-- 1. Drop index on failure_screenshot_url if exists
DROP INDEX IF EXISTS public.idx_failed_jobs_failure_screenshot_url;

-- 2. Preserve any existing failure_screenshot_url into screenshot_path
UPDATE public.failed_jobs
SET screenshot_path = failure_screenshot_url
WHERE (screenshot_path IS NULL OR length(trim(screenshot_path)) = 0)
  AND failure_screenshot_url IS NOT NULL;

-- 3. Drop the redundant failure_screenshot_url column from failed_jobs
ALTER TABLE public.failed_jobs
DROP COLUMN IF EXISTS failure_screenshot_url;

-- 4. Create index on screenshot_path for fast proof retrieval
CREATE INDEX IF NOT EXISTS idx_failed_jobs_screenshot_path
ON public.failed_jobs(screenshot_path)
WHERE screenshot_path IS NOT NULL;
