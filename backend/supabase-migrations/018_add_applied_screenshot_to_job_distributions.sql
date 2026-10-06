-- ==============================================================================
-- Migration: 018_add_applied_screenshot_to_job_distributions.sql
-- Description: Adds applied_screenshot column to job_distributions table.
--              Stores the real proof screenshot of successfully submitted
--              Workday application page captured when the bot executes
--              submission after CA review.
-- ==============================================================================

ALTER TABLE public.job_distributions 
    ADD COLUMN IF NOT EXISTS applied_screenshot TEXT;

COMMENT ON COLUMN public.job_distributions.applied_screenshot IS 
    'Authentic proof screenshot of final Workday submission confirmation page ("Application Submitted") taken after CA approves and bot executes real submission.';

-- Performance index for submitted applications with applied screenshots
CREATE INDEX IF NOT EXISTS idx_job_dist_applied_screenshot 
    ON public.job_distributions(applied_screenshot) 
    WHERE applied_screenshot IS NOT NULL;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
