-- ==============================================================================
-- Migration: 016_add_unanswered_questions_to_job_distributions.sql
-- Description: Adds unanswered_questions column to public.job_distributions to display
--              the exact question labels, field types, and step names for questions
--              that were unable to be automatically filled (e.g. 2-3 unanswered questions).
-- ==============================================================================

ALTER TABLE public.job_distributions 
    ADD COLUMN IF NOT EXISTS unanswered_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS unanswered_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_fully_answered BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

-- Performance index for filtering jobs that need manual answers
CREATE INDEX IF NOT EXISTS idx_job_dist_unanswered ON public.job_distributions(unanswered_count) WHERE unanswered_count > 0;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
