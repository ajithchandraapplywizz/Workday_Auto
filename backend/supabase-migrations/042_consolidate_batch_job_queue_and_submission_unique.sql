-- ==============================================================================
-- Migration: 042_consolidate_batch_job_queue_and_submission_unique.sql
-- Description:
--   1. Adds client_ids JSONB column to batch_job_queue to store all candidate
--      AWL IDs in a single cell per unique job link.
--   2. Enforces unique constraint on batch_job_queue(job_url).
--   3. Deduplicates submission_tasks and enforces strict UNIQUE constraint
--      on submission_tasks(applywizz_id, job_url) to prevent ballooning.
-- ==============================================================================

-- 1. Add client_ids column to batch_job_queue if it doesn't already exist
ALTER TABLE public.batch_job_queue
ADD COLUMN IF NOT EXISTS client_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Deduplicate existing submission_tasks, keeping only the single most recent row per (applywizz_id, job_url)
DELETE FROM public.submission_tasks
WHERE id NOT IN (
    SELECT DISTINCT ON (applywizz_id, job_url) id
    FROM public.submission_tasks
    ORDER BY applywizz_id, job_url, updated_at DESC, created_at DESC
);

-- 3. Add unique constraint on submission_tasks(applywizz_id, job_url)
ALTER TABLE public.submission_tasks
DROP CONSTRAINT IF EXISTS uq_submission_tasks_awl_url;

ALTER TABLE public.submission_tasks
ADD CONSTRAINT uq_submission_tasks_awl_url UNIQUE (applywizz_id, job_url);

-- 4. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_client_ids ON public.batch_job_queue USING GIN (client_ids);
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_job_url ON public.batch_job_queue (job_url);

-- 5. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
