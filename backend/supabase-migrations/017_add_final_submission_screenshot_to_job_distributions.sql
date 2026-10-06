-- ==============================================================================
-- Migration: 017_add_final_submission_screenshot_to_job_distributions.sql
-- Description: Adds original_application_screenshot_successful and
--              final_submission_screenshot_url columns to job_distributions table.
--              Stores the authentic post-submission confirmation screenshot
--              captured when the real bot submits the application on Workday
--              after CA reviews and clicks "Review & Submit".
-- ==============================================================================

ALTER TABLE public.job_distributions 
    ADD COLUMN IF NOT EXISTS original_application_screenshot_successful TEXT,
    ADD COLUMN IF NOT EXISTS final_submission_screenshot_url TEXT;

COMMENT ON COLUMN public.job_distributions.original_application_screenshot_successful IS 
    'Authentic proof screenshot of final Workday submission confirmation screen ("Application Submitted") taken after CA approves and bot executes real submission.';

COMMENT ON COLUMN public.job_distributions.final_submission_screenshot_url IS 
    'Alias for original_application_screenshot_successful.';

-- Performance index for submitted applications with confirmation screenshots
CREATE INDEX IF NOT EXISTS idx_job_dist_orig_screenshot 
    ON public.job_distributions(original_application_screenshot_successful) 
    WHERE original_application_screenshot_successful IS NOT NULL;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
