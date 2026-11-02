-- ==============================================================================
-- Migration: 049_drop_submission_tasks.sql
-- Description:
--   Consolidates the entire Workday automation lifecycle into job_distributions.
--   Drops submission_tasks and all associated mirror triggers to establish
--   job_distributions as the single, authoritative source of truth.
-- ==============================================================================

-- Drop mirror triggers if present
DROP TRIGGER IF EXISTS trg_mirror_submission_task_to_job_distributions ON public.submission_tasks;
DROP FUNCTION IF EXISTS public.trg_mirror_submission_task_to_job_distributions() CASCADE;

-- Remove table
DROP TABLE IF EXISTS public.submission_tasks CASCADE; -- precheck:allow-destructive
