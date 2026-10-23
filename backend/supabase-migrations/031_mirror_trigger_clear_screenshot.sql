-- ==============================================================================
-- Migration: 031_mirror_trigger_clear_screenshot.sql
-- Description:
--   Updates trg_mirror_submission_task_to_job_distributions trigger function so
--   that when application_submitted_screenshot_url is cleared (set to NULL) on
--   submission_tasks, it is also cleared on the matching job_distributions row.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_mirror_submission_task_to_job_distributions()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status) OR 
     (NEW.application_submitted_screenshot_url IS DISTINCT FROM OLD.application_submitted_screenshot_url) OR
     (NEW.worker_id IS DISTINCT FROM OLD.worker_id) OR
     (NEW.worker_leased_at IS DISTINCT FROM OLD.worker_leased_at) OR
     (NEW.error_message IS DISTINCT FROM OLD.error_message) THEN
    
    UPDATE public.job_distributions
    SET
      status = NEW.status,
      application_submitted_screenshot_url = NEW.application_submitted_screenshot_url,
      worker_id = COALESCE(NEW.worker_id, worker_id),
      worker_leased_at = COALESCE(NEW.worker_leased_at, worker_leased_at),
      error_message = COALESCE(NEW.error_message, error_message),
      updated_at = now()
    WHERE id = NEW.distribution_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
