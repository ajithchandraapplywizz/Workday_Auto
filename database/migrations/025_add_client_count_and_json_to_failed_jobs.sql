-- ==============================================================================
-- Migration: 025_add_client_count_and_json_to_failed_jobs.sql
-- Description: 
--   1. Adds 'failed_client_count' (integer) and 'client_ids' (jsonb) to failed_jobs.
--   2. Enforces unique constraint on job_url so a failed job link is only stored once.
--   3. Automatically populates existing failed_jobs with unique counts and JSON AWL-IDs
--      matched from batch_job_queue.
-- ==============================================================================

-- 1. Add new columns
ALTER TABLE public.failed_jobs
    ADD COLUMN IF NOT EXISTS failed_client_count INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS client_ids JSONB DEFAULT '[]'::jsonb;

-- 2. Deduplicate existing failed_jobs: Keep the most recent failure row per job_url
DELETE FROM public.failed_jobs a
USING public.failed_jobs b
WHERE a.job_url = b.job_url
  AND a.updated_at < b.updated_at;

-- 3. Add unique constraint on job_url to guarantee no duplicate failed job links
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'failed_jobs_job_url_key'
    ) THEN
        ALTER TABLE public.failed_jobs ADD CONSTRAINT failed_jobs_job_url_key UNIQUE (job_url);
    END IF;
END $$;

-- 4. Backfill failed_client_count and client_ids from batch_job_queue for all existing failed jobs
UPDATE public.failed_jobs f
SET 
    failed_client_count = sub.cnt,
    client_ids = sub.cids,
    updated_at = NOW()
FROM (
    SELECT 
        job_url,
        COUNT(DISTINCT applywizz_id) AS cnt,
        jsonb_agg(DISTINCT applywizz_id) AS cids
    FROM public.batch_job_queue
    GROUP BY job_url
) sub
WHERE f.job_url = sub.job_url;

-- 5. Fallback for any rows not in batch_job_queue: use their own applywizz_id
UPDATE public.failed_jobs
SET 
    failed_client_count = 1,
    client_ids = jsonb_build_array(applywizz_id)
WHERE client_ids IS NULL OR client_ids = '[]'::jsonb;

-- 6. Performance indexes
CREATE INDEX IF NOT EXISTS idx_failed_jobs_client_count ON public.failed_jobs (failed_client_count);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_client_ids ON public.failed_jobs USING gin (client_ids);

-- 7. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
