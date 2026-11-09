-- ==============================================================================
-- Migration: 052_drop_legacy_submission_tasks_trigger.sql
-- Description:
--   Drops legacy trigger and function on job_distributions that attempted to
--   insert into submission_tasks.
--   When submission_tasks was dropped in migration 049, the trigger
--   trg_job_distributions_on_fully_answered remained on job_distributions.
--   Because that trigger attempted to INSERT INTO public.submission_tasks,
--   any insert or update with is_fully_answered = true failed with:
--     relation "public.submission_tasks" does not exist.
--   Dropping this dead trigger and function restores normal insertions.
-- ==============================================================================

DROP TRIGGER IF EXISTS trg_job_distributions_on_fully_answered ON public.job_distributions;
DROP FUNCTION IF EXISTS public.trg_job_distributions_insert_submission_task() CASCADE;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
