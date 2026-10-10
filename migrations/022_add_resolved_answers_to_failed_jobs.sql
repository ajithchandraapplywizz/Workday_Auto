-- ==============================================================================
-- Migration: 022_add_resolved_answers_to_failed_jobs.sql
-- Description: Adds resolved_answers JSONB column to failed_jobs table to store
--              all questions and answers resolved up to the failure step,
--              enabling auditing and partial answer recovery.
-- ==============================================================================

-- 1. Add resolved_answers column to failed_jobs if not already present
ALTER TABLE public.failed_jobs
    ADD COLUMN IF NOT EXISTS resolved_answers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Create GIN index for fast JSONB querying on failed_jobs.resolved_answers
CREATE INDEX IF NOT EXISTS idx_failed_jobs_resolved_answers
    ON public.failed_jobs USING gin (resolved_answers);

-- 3. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
