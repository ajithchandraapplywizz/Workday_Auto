-- ==============================================================================
-- Migration: 010_link_batch_queue_to_scanned_jobs.sql
-- Description: Adds scanned_job_id foreign key and job_id to batch_job_queue
--              so every task is explicitly linked to its unique job in scanned_jobs.
-- ==============================================================================

ALTER TABLE public.batch_job_queue
ADD COLUMN IF NOT EXISTS scanned_job_id UUID REFERENCES public.scanned_jobs(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS job_id TEXT;

-- Create performance indexes for instant ID-based lookups
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_scanned_job_id ON public.batch_job_queue(scanned_job_id);
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_job_id ON public.batch_job_queue(job_id);

-- Backfill scanned_job_id and job_id on batch_job_queue from scanned_jobs
UPDATE public.batch_job_queue b
SET scanned_job_id = s.id,
    job_id = s.job_id
FROM public.scanned_jobs s
WHERE b.scanned_job_id IS NULL
  AND (
    b.job_url = s.job_url 
    OR split_part(b.job_url, '?', 1) = split_part(s.job_url, '?', 1)
  );

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
