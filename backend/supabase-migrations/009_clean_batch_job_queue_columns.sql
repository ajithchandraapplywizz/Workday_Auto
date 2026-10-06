-- ==============================================================================
-- Migration: 009_clean_batch_job_queue_columns.sql
-- Description: Removes unnecessary / redundant columns from batch_job_queue table:
--              - candidate_email (redundant, already in clients table)
--              - attempts (unnecessary, worker pool handles runs)
--              - max_attempts (unnecessary)
--              - started_at (redundant with created_at)
--              - completed_at (redundant with updated_at)
-- ==============================================================================

ALTER TABLE public.batch_job_queue
DROP COLUMN IF EXISTS candidate_email,
DROP COLUMN IF EXISTS attempts,
DROP COLUMN IF EXISTS max_attempts,
DROP COLUMN IF EXISTS started_at,
DROP COLUMN IF EXISTS completed_at;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
