-- ==============================================================================
-- Migration: 015_merge_resolved_answers_into_job_distributions.sql
-- Description: Merges resolved_answers into job_distributions table.
--              Adds 4-tier resolved_answers JSONB, completion status,
--              proof screenshot URL, worker lease tracking directly into
--              job_distributions.
--              Drops obsolete view answer_resolving and table resolved_answers.
-- ==============================================================================

-- 1. Add resolved_answers, completion, screenshot, and worker columns to job_distributions
ALTER TABLE public.job_distributions 
    ADD COLUMN IF NOT EXISTS resolved_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS is_fully_answered BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS unanswered_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS screenshot_url TEXT,
    ADD COLUMN IF NOT EXISTS error_message TEXT,
    ADD COLUMN IF NOT EXISTS worker_id TEXT,
    ADD COLUMN IF NOT EXISTS worker_leased_at TIMESTAMPTZ;

-- 2. Migrate any existing records from resolved_answers into job_distributions (if present)
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'resolved_answers'
    ) THEN
        INSERT INTO public.job_distributions (
            applywizz_id,
            job_id,
            job_url,
            company,
            role_title,
            resolved_answers,
            is_fully_answered,
            unanswered_count,
            status,
            screenshot_url,
            error_message,
            worker_id,
            worker_leased_at,
            created_at,
            updated_at
        )
        SELECT 
            ra.applywizz_id,
            ra.job_id,
            ra.job_url,
            ra.company,
            ra.role_title,
            COALESCE(ra.resolved_answers_json, '[]'::jsonb),
            ra.is_fully_answered,
            ra.unanswered_count,
            ra.status,
            ra.screenshot_url,
            ra.error_message,
            ra.worker_id,
            ra.worker_leased_at,
            ra.created_at,
            ra.updated_at
        FROM public.resolved_answers ra
        ON CONFLICT (applywizz_id, job_url) DO UPDATE SET
            resolved_answers = EXCLUDED.resolved_answers,
            is_fully_answered = EXCLUDED.is_fully_answered,
            unanswered_count = EXCLUDED.unanswered_count,
            status = EXCLUDED.status,
            screenshot_url = EXCLUDED.screenshot_url,
            error_message = EXCLUDED.error_message,
            worker_id = EXCLUDED.worker_id,
            worker_leased_at = EXCLUDED.worker_leased_at,
            updated_at = EXCLUDED.updated_at;
    END IF;
END $$;

-- 3. Drop obsolete view answer_resolving and table resolved_answers
DROP VIEW IF EXISTS public.answer_resolving CASCADE;
DROP TABLE IF EXISTS public.resolved_answers CASCADE;

-- 4. Performance Indexes on job_distributions
CREATE INDEX IF NOT EXISTS idx_job_dist_status ON public.job_distributions(status);
CREATE INDEX IF NOT EXISTS idx_job_dist_resolved ON public.job_distributions(applywizz_id, is_fully_answered, status);
CREATE INDEX IF NOT EXISTS idx_job_dist_worker ON public.job_distributions(status, worker_leased_at);

-- 5. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
