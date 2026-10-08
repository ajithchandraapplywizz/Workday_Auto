-- ==============================================================================
-- Migration: 019_enforce_scanned_jobs_distribution_constraint.sql
-- Description: Enforces that only jobs that exist in scanned_jobs with scraped
--              questions (question_count > 0) are stored in job_distributions.
--              Adds scanned_job_id column and foreign key link, and purges
--              orphaned or zero-question rows from job_distributions.
-- ==============================================================================

-- 1. Add scanned_job_id to job_distributions if not present
ALTER TABLE public.job_distributions
    ADD COLUMN IF NOT EXISTS scanned_job_id UUID REFERENCES public.scanned_jobs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_job_dist_scanned_job_id 
    ON public.job_distributions(scanned_job_id);

-- 2. Backfill scanned_job_id for existing valid records
UPDATE public.job_distributions d
SET scanned_job_id = s.id
FROM public.scanned_jobs s
WHERE d.scanned_job_id IS NULL
  AND (
    d.job_url = s.job_url
    OR split_part(d.job_url, '?', 1) = split_part(s.job_url, '?', 1)
  )
  AND (s.question_count > 0 OR jsonb_array_length(s.scraped_questions) > 0);

-- 3. Purge orphaned or empty records in job_distributions:
-- Delete any rows where job_url does not exist in scanned_jobs with question_count > 0
DELETE FROM public.job_distributions
WHERE job_url NOT IN (
    SELECT job_url 
    FROM public.scanned_jobs 
    WHERE question_count > 0 
       OR (scraped_questions IS NOT NULL AND jsonb_array_length(scraped_questions) > 0)
)
OR question_count = 0
OR scraped_questions = '[]'::jsonb
OR scraped_questions IS NULL;

-- 4. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
