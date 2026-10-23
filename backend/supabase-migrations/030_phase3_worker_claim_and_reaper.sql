-- ==============================================================================
-- Migration 030: Phase 3 — Atomic Worker Claim (FOR UPDATE SKIP LOCKED) & Reaper
-- Execute in Supabase SQL Editor: https://supabase.com/dashboard/project/rltnrnqqmufeeqaodsif/sql
-- ==============================================================================

-- 1. Atomic task claim function: Claims oldest queued task using FOR UPDATE SKIP LOCKED
-- Sets applying, worker_id, started_at, worker_leased_at in the exact same statement
CREATE OR REPLACE FUNCTION public.claim_next_submission_task(p_worker_id text)
RETURNS SETOF public.submission_tasks AS $$
BEGIN
  RETURN QUERY
  WITH next_task AS (
    SELECT id
    FROM public.submission_tasks
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.submission_tasks st
  SET
    status = 'applying',
    worker_id = p_worker_id,
    started_at = now(),
    worker_leased_at = now(),
    updated_at = now()
  FROM next_task
  WHERE st.id = next_task.id
  RETURNING st.*;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Lease Reaper function: Marks tasks applying with expired lease (> 10 minutes) as failed.
-- Never auto re-queues, preserving integrity if Workday submission succeeded before crash.
CREATE OR REPLACE FUNCTION public.reap_expired_submission_leases(p_timeout_minutes integer DEFAULT 10)
RETURNS SETOF public.submission_tasks AS $$
BEGIN
  RETURN QUERY
  UPDATE public.submission_tasks
  SET
    status = 'failed',
    error_message = format('Worker lease expired (> %s minutes). Possible worker crash. Requires admin attention.', p_timeout_minutes),
    completed_at = now(),
    updated_at = now()
  WHERE status = 'applying'
    AND worker_leased_at < (now() - (p_timeout_minutes || ' minutes')::interval)
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execution to service_role, anon, authenticated
GRANT EXECUTE ON FUNCTION public.claim_next_submission_task(text) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_expired_submission_leases(integer) TO service_role, anon, authenticated;
