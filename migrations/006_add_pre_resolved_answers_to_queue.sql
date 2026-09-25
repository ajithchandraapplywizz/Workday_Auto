-- ==============================================================================
-- Migration: 006_add_pre_resolved_answers_to_queue.sql
-- Description: Add pre_resolved_answers (single JSON cell) to batch_job_queue
-- ==============================================================================

-- 1. Add pre_resolved_answers column to store all candidate answers in one cell (JSONB)
ALTER TABLE public.batch_job_queue 
ADD COLUMN IF NOT EXISTS pre_resolved_answers jsonb DEFAULT '{}'::jsonb;

-- 2. Verify check constraint includes 'pre_resolved' status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'batch_job_queue_status_check'
  ) THEN
    ALTER TABLE public.batch_job_queue 
    ADD CONSTRAINT batch_job_queue_status_check 
    CHECK (status IN ('pending', 'processing', 'pre_resolved', 'reached_review', 'submitted', 'failed', 'skipped'));
  END IF;
END $$;

-- 3. Index for instant worker lookup by status and URL
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_status_url 
ON public.batch_job_queue (status, job_url);

COMMENT ON COLUMN public.batch_job_queue.pre_resolved_answers IS 
'Single JSON cell storing pre-computed candidate answers (MM/DD/YYYY DOB, contact, work auth, EEO, custom fields) prior to Playwright execution.';
