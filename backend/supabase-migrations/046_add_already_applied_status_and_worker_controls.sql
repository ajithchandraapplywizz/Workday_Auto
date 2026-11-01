-- Migration 046: Add 'already_applied' status to submission_tasks and job_distributions
--               Register canonical 6-worker topology in worker_control table
-- ─────────────────────────────────────────────────────────────────────────────
-- Purpose:
--   1. Extend submission_tasks CHECK constraint to include 'already_applied'.
--   2. Extend job_distributions status CHECK constraint to include 'already_applied'.
--   3. Ensure worker_control rows exist for all 6 scan + 6 submit canonical worker IDs.
--   4. Add partial index for fast already_applied queries on both tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. submission_tasks: add 'already_applied' to CHECK constraint ────────────
-- Drop existing constraint and recreate with extended values
ALTER TABLE public.submission_tasks
  DROP CONSTRAINT IF EXISTS submission_tasks_status_check;

ALTER TABLE public.submission_tasks
  ADD CONSTRAINT submission_tasks_status_check
  CHECK (status IN (
    'queued',
    'ready_for_review',
    'applying',
    'submitted',
    'failed',
    'skipped',
    'already_applied'
  ));

-- ── 2. job_distributions: add 'already_applied' to CHECK constraint ──────────
ALTER TABLE public.job_distributions
  DROP CONSTRAINT IF EXISTS job_distributions_status_check;

ALTER TABLE public.job_distributions
  ADD CONSTRAINT job_distributions_status_check
  CHECK (status IN (
    'pending',
    'scanning',
    'scanned',
    'resolving',
    'ready_for_review',
    'queued',
    'applying',
    'submitted',
    'failed',
    'skipped',
    'already_applied',
    'expired'
  ));

-- ── 3. Partial indexes for already_applied fast-path queries ─────────────────
CREATE INDEX IF NOT EXISTS idx_submission_tasks_already_applied
  ON public.submission_tasks (applywizz_id, job_url)
  WHERE status = 'already_applied';

CREATE INDEX IF NOT EXISTS idx_job_distributions_already_applied
  ON public.job_distributions (applywizz_id, job_url)
  WHERE status = 'already_applied';

-- ── 4. Ensure all 6 scanning + 6 submitting canonical workers exist in worker_control
-- Uses INSERT ... ON CONFLICT DO NOTHING so existing rows are untouched
INSERT INTO public.worker_control (worker_id, state, stage, updated_at)
VALUES
  ('scanning_worker_1',   'idle', 'scanning',   now()),
  ('scanning_worker_2',   'idle', 'scanning',   now()),
  ('scanning_worker_3',   'idle', 'scanning',   now()),
  ('scanning_worker_4',   'idle', 'scanning',   now()),
  ('scanning_worker_5',   'idle', 'scanning',   now()),
  ('scanning_worker_6',   'idle', 'scanning',   now()),
  ('submitting_worker_1', 'idle', 'submitting',  now()),
  ('submitting_worker_2', 'idle', 'submitting',  now()),
  ('submitting_worker_3', 'idle', 'submitting',  now()),
  ('submitting_worker_4', 'idle', 'submitting',  now()),
  ('submitting_worker_5', 'idle', 'submitting',  now()),
  ('submitting_worker_6', 'idle', 'submitting',  now())
ON CONFLICT (worker_id) DO NOTHING;

-- ── 5. Notify PostgREST to reload schema ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
