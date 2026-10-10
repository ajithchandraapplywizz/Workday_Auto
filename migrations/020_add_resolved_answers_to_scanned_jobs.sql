-- ==============================================================================
-- Migration: 020_add_resolved_answers_to_scanned_jobs.sql
-- Description: Adds resolved_answers JSONB column to scanned_jobs table to store
--              the answers used by the blueprint candidate during scanning,
--              with explicit 4-tier source highlighting.
-- ==============================================================================

-- 1. Add resolved_answers to scanned_jobs if not already present
ALTER TABLE public.scanned_jobs
    ADD COLUMN IF NOT EXISTS resolved_answers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Ensure job_distributions.resolved_answers has appropriate defaults
ALTER TABLE public.job_distributions
    ADD COLUMN IF NOT EXISTS resolved_answers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3. Add an index on scanned_jobs to support JSON queries if needed
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_resolved_answers ON public.scanned_jobs USING gin (resolved_answers);
CREATE INDEX IF NOT EXISTS idx_job_distributions_resolved_answers ON public.job_distributions USING gin (resolved_answers);

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
