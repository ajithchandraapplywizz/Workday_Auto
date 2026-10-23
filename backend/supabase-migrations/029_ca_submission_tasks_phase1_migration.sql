-- ==============================================================================
-- Migration 029: CA Submission Flow — Phase 1 Schema Migration (Additive)
-- Execute in Supabase SQL Editor: https://supabase.com/dashboard/project/rltnrnqqmufeeqaodsif/sql
-- ==============================================================================

-- 1. Widen the submission_tasks status check to include ready_for_review
ALTER TABLE public.submission_tasks 
DROP CONSTRAINT IF EXISTS submission_tasks_status_check;

ALTER TABLE public.submission_tasks 
ADD CONSTRAINT submission_tasks_status_check 
CHECK (status IN ('ready_for_review', 'queued', 'applying', 'submitted', 'failed'));

-- 2. Add columns worker_leased_at timestamptz and screenshot_path text to submission_tasks
ALTER TABLE public.submission_tasks 
ADD COLUMN IF NOT EXISTS worker_leased_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS screenshot_path TEXT;

-- 3. Add a unique index on submission_tasks(distribution_id)
-- Note: Verified 0 duplicate distribution_ids in submission_tasks prior to creation
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_tasks_distribution_id_unique 
ON public.submission_tasks(distribution_id);

-- 4. Add a partial unique index on submission_tasks(application_submitted_screenshot_url) where it is not null
-- Guarantees no two applications can ever share a screenshot URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_tasks_screenshot_url_unique 
ON public.submission_tasks(application_submitted_screenshot_url) 
WHERE application_submitted_screenshot_url IS NOT NULL;

-- 5. Add a partial index on submission_tasks(created_at) where status = queued for fast FIFO polling
CREATE INDEX IF NOT EXISTS idx_submission_tasks_queued_created_at 
ON public.submission_tasks(created_at) 
WHERE status = 'queued';

-- 6. Trigger on job_distributions: when is_fully_answered changes to TRUE,
-- insert one submission_tasks row (ready_for_review) with ON CONFLICT (distribution_id) DO NOTHING.
CREATE OR REPLACE FUNCTION public.trg_job_distributions_insert_submission_task()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_fully_answered = true AND (TG_OP = 'INSERT' OR OLD.is_fully_answered IS DISTINCT FROM true) THEN
    INSERT INTO public.submission_tasks (
      distribution_id,
      applywizz_id,
      job_url,
      company,
      role_title,
      status,
      created_at,
      updated_at
    )
    VALUES (
      NEW.id,
      NEW.applywizz_id,
      NEW.job_url,
      NEW.company,
      NEW.role_title,
      'ready_for_review',
      now(),
      now()
    )
    ON CONFLICT (distribution_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_job_distributions_on_fully_answered ON public.job_distributions;
CREATE TRIGGER trg_job_distributions_on_fully_answered
AFTER INSERT OR UPDATE OF is_fully_answered ON public.job_distributions
FOR EACH ROW
EXECUTE FUNCTION public.trg_job_distributions_insert_submission_task();

-- 7. Trigger on submission_tasks: when status or screenshot URL changes,
-- mirror them to the matching job_distributions row by distribution_id.
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
      application_submitted_screenshot_url = COALESCE(NEW.application_submitted_screenshot_url, application_submitted_screenshot_url),
      worker_id = COALESCE(NEW.worker_id, worker_id),
      worker_leased_at = COALESCE(NEW.worker_leased_at, worker_leased_at),
      error_message = COALESCE(NEW.error_message, error_message),
      updated_at = now()
    WHERE id = NEW.distribution_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_mirror_submission_task ON public.submission_tasks;
CREATE TRIGGER trg_mirror_submission_task
AFTER UPDATE ON public.submission_tasks
FOR EACH ROW
EXECUTE FUNCTION public.trg_mirror_submission_task_to_job_distributions();

-- 8. One-time idempotent backfill: create task rows for existing fully answered distributions.
-- Existing submitted rows keep their status; all others default to ready_for_review.
INSERT INTO public.submission_tasks (
  distribution_id,
  applywizz_id,
  job_url,
  company,
  role_title,
  status,
  worker_id,
  worker_leased_at,
  application_submitted_screenshot_url,
  error_message,
  created_at,
  updated_at
)
SELECT
  jd.id,
  jd.applywizz_id,
  jd.job_url,
  jd.company,
  jd.role_title,
  CASE 
    WHEN jd.status = 'submitted' THEN 'submitted'
    ELSE 'ready_for_review'
  END AS status,
  jd.worker_id,
  jd.worker_leased_at,
  jd.application_submitted_screenshot_url,
  jd.error_message,
  COALESCE(jd.created_at, now()),
  now()
FROM public.job_distributions jd
WHERE jd.is_fully_answered = true
ON CONFLICT (distribution_id) DO UPDATE SET
  status = CASE 
    WHEN submission_tasks.status = 'submitted' THEN 'submitted'
    WHEN EXCLUDED.status = 'submitted' THEN 'submitted'
    ELSE submission_tasks.status
  END,
  application_submitted_screenshot_url = COALESCE(submission_tasks.application_submitted_screenshot_url, EXCLUDED.application_submitted_screenshot_url),
  updated_at = now();
