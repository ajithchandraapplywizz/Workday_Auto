-- ==============================================================================
-- Migration 039: Phase 2 Sequence Mode Lock (R3), Max 10 Concurrent (R4), and Independent Toggles (R11)
-- ==============================================================================

-- 1. Extend bot_control with independent toggle states and mode lock
ALTER TABLE public.bot_control
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS scan_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS scan_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submit_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submit_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS submit_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS refusal_reason TEXT,
    ADD COLUMN IF NOT EXISTS scan_message TEXT;

-- 2. Ensure initial state
UPDATE public.bot_control
SET
    mode = 'idle',
    scan_enabled = false,
    scan_status = 'off',
    scan_stop_requested = false,
    submit_enabled = false,
    submit_status = 'off',
    submit_stop_requested = false,
    updated_at = timezone('utc'::text, now())
WHERE id = 'primary';

-- 3. Atomic Worker Claim (R4): Max concurrent applying rows = 10.
-- Claim is ONE atomic call (FOR UPDATE SKIP LOCKED) that takes exactly one queued row and refuses when 10 are applying.
CREATE OR REPLACE FUNCTION public.claim_next_submission_task(p_worker_id text, p_max_concurrent integer DEFAULT 10)
RETURNS SETOF public.submission_tasks AS $$
DECLARE
  v_applying_count integer;
BEGIN
  -- Refuse if max concurrent applying tasks reached
  SELECT count(*) INTO v_applying_count
  FROM public.submission_tasks
  WHERE status = 'applying';

  IF v_applying_count >= p_max_concurrent THEN
    RETURN;
  END IF;

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

GRANT EXECUTE ON FUNCTION public.claim_next_submission_task(text, integer) TO service_role, anon, authenticated;

-- Reload schema
NOTIFY pgrst, 'reload schema';
