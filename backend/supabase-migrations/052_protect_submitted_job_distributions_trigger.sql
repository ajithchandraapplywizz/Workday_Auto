-- ==============================================================================
-- Migration: 052_protect_submitted_job_distributions_trigger.sql
-- Description: Unconditional Database-Level Protection for Completed Workday Submissions
--
-- Problem: When Stage 1 scanning or Stage 2 resolving workers re-distribute jobs,
--          an UPSERT with resolution=merge-duplicates would overwrite existing
--          'submitted', 'completed', or 'already_applied' rows back to 'ready_for_review'
--          and wipe their proof screenshot URL.
--
-- Solution: This BEFORE UPDATE trigger guarantees that once an application has been
--           verified as submitted, completed, or already_applied (or is actively in flight),
--           NO process, worker, or script can downgrade its status back to ready_for_review,
--           nor wipe its authentic confirmation screenshot.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.protect_submitted_job_distributions()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. If the existing row is already in a completed/terminal state:
    IF OLD.status IN ('submitted', 'completed', 'already_applied') THEN
        -- Strictly reject any attempt to downgrade to an un-submitted state
        IF NEW.status IN ('ready_for_review', 'ready_to_review', 'pending', 'needs_answers', 'distributed', 'queued', 'queued_for_submission') THEN
            NEW.status := OLD.status;
        END IF;

        -- Strictly reject any attempt to wipe or nullify the authentic confirmation screenshot
        IF (NEW.application_submitted_screenshot_url IS NULL OR length(trim(NEW.application_submitted_screenshot_url)) = 0)
           AND (OLD.application_submitted_screenshot_url IS NOT NULL AND length(trim(OLD.application_submitted_screenshot_url)) > 0) THEN
            NEW.application_submitted_screenshot_url := OLD.application_submitted_screenshot_url;
        END IF;
    END IF;

    -- 2. If the existing row is actively being processed by a worker ('applying', 'in_flight'):
    --    Prevent re-distribution from resetting it back to ready_for_review while the worker is working
    IF OLD.status IN ('applying', 'in_flight') AND NEW.status IN ('ready_for_review', 'ready_to_review', 'distributed') THEN
        NEW.status := OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_submitted_job_distributions ON public.job_distributions;
CREATE TRIGGER trg_protect_submitted_job_distributions
BEFORE UPDATE ON public.job_distributions
FOR EACH ROW
EXECUTE FUNCTION public.protect_submitted_job_distributions();

NOTIFY pgrst, 'reload schema';
