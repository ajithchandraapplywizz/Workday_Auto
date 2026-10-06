-- ==============================================================================
-- Migration: 009_clean_batch_job_queue_columns.sql
-- Description: Removes unnecessary / redundant columns from batch_job_queue:
--              - pre_resolved_answers (REDUNDANT: now cleanly stored in resolved_answers table)
--              - candidate_email (REDUNDANT: stored in clients table)
--              - attempts & max_attempts (UNNECESSARY: worker pool handles leasing)
--              - started_at & completed_at (DUPLICATES: of created_at and updated_at)
-- ==============================================================================

ALTER TABLE public.batch_job_queue
DROP COLUMN IF EXISTS pre_resolved_answers,
DROP COLUMN IF EXISTS candidate_email,
DROP COLUMN IF EXISTS attempts,
DROP COLUMN IF EXISTS max_attempts,
DROP COLUMN IF EXISTS started_at,
DROP COLUMN IF EXISTS completed_at;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
