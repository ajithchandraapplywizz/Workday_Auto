-- ==============================================================================
-- Migration: 024_targeted_submission_and_proof_cleanup.sql
-- Description: 
--   1. Explicitly drops legacy screenshot_url column from job_distributions.
--   2. Ensures application_submitted_screenshot_url is present for verified submission proofs.
--   3. Ensures unanswered_questions JSONB and audit columns on job_distributions.
--   4. Ensures failed_jobs tracks failure_screenshot_url, error_step, detailed_dom_reason, and resolved_answers.
-- ==============================================================================

-- 1. Explicitly drop legacy screenshot_url column from job_distributions
ALTER TABLE public.job_distributions
    DROP COLUMN IF EXISTS screenshot_url;

-- 2. Ensure application_submitted_screenshot_url and metadata columns on job_distributions
ALTER TABLE public.job_distributions
    ADD COLUMN IF NOT EXISTS application_submitted_screenshot_url TEXT,
    ADD COLUMN IF NOT EXISTS unanswered_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS unanswered_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_fully_answered BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- 3. Ensure failed_jobs has comprehensive audit and failure screenshot columns
ALTER TABLE public.failed_jobs
    ADD COLUMN IF NOT EXISTS failure_screenshot_url TEXT,
    ADD COLUMN IF NOT EXISTS error_step TEXT,
    ADD COLUMN IF NOT EXISTS detailed_dom_reason TEXT,
    ADD COLUMN IF NOT EXISTS resolved_answers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 4. Create indexing for performant status and candidate queries
CREATE INDEX IF NOT EXISTS idx_job_dist_app_sub_shot
    ON public.job_distributions (application_submitted_screenshot_url)
    WHERE application_submitted_screenshot_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_failed_jobs_failure_screenshot
    ON public.failed_jobs (failure_screenshot_url)
    WHERE failure_screenshot_url IS NOT NULL;

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
