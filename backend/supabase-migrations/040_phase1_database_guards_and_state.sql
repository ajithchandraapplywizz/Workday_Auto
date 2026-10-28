-- ==============================================================================
-- Migration 040: Phase 1 Database Guards, State Isolation & Audit Architecture
-- ==============================================================================
-- Strictly Idempotent: Can be run multiple times safely.
-- Enforces R1, R2, R3, R3b, R5, R6, R12, R13, R14, R16.
-- ==============================================================================

-- 1. Add possibly_submitted, review_flag, and status_actor to submission_tasks
ALTER TABLE public.submission_tasks
    ADD COLUMN IF NOT EXISTS possibly_submitted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS review_flag TEXT,
    ADD COLUMN IF NOT EXISTS status_actor TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_submission_tasks_possibly_submitted
    ON public.submission_tasks (possibly_submitted)
    WHERE possibly_submitted = true;

CREATE INDEX IF NOT EXISTS idx_submission_tasks_review_flag
    ON public.submission_tasks (review_flag)
    WHERE review_flag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submission_tasks_status_actor
    ON public.submission_tasks (status_actor);

-- Ensure idempotent unique constraint so duplicates can never be created across reruns/resumes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_submission_tasks_applywizz_job_url'
    ) THEN
        ALTER TABLE public.submission_tasks
            ADD CONSTRAINT uq_submission_tasks_applywizz_job_url UNIQUE (applywizz_id, job_url);
    END IF;
END $$;

-- 2. Extend bot_control with independent toggle state, mode lock & single-daemon lock
ALTER TABLE public.bot_control
    ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS submit_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS scan_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submit_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS daemon_instance_id TEXT,
    ADD COLUMN IF NOT EXISTS daemon_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scan_run_id TEXT,
    ADD COLUMN IF NOT EXISTS scan_run_started_at TIMESTAMPTZ;

-- Ensure mode constraint exists idempotently
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_bot_control_mode'
    ) THEN
        ALTER TABLE public.bot_control
            ADD CONSTRAINT chk_bot_control_mode
            CHECK (mode IN ('idle', 'scanning', 'submitting'));
    END IF;
END $$;

-- Initialize primary row if needed (DO NOTHING to preserve live state on re-run)
INSERT INTO public.bot_control (
    id, mode, scan_status, submit_status,
    scan_stop_requested, submit_stop_requested,
    is_running, updated_at
)
VALUES (
    'primary', 'idle', 'off', 'off',
    false, false,
    false, now()
)
ON CONFLICT (id) DO NOTHING;

-- 3. Create worker_logs table (R16, R17: NO anon grants, authenticated and service_role only)
CREATE TABLE IF NOT EXISTS public.worker_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_logs_worker_time
    ON public.worker_logs (worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_logs_created_at
    ON public.worker_logs (created_at DESC);

ALTER TABLE public.worker_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    REVOKE ALL ON public.worker_logs FROM anon, public;
    GRANT SELECT, INSERT, UPDATE ON public.worker_logs TO authenticated, service_role;
END $$;

-- 4. Add per-item scan progress columns to batch_job_queue (R10)
ALTER TABLE public.batch_job_queue
    ADD COLUMN IF NOT EXISTS scan_progress TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS scan_run_id TEXT,
    ADD COLUMN IF NOT EXISTS scanning_leased_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scanning_worker_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_batch_job_queue_scan_progress'
    ) THEN
        ALTER TABLE public.batch_job_queue
            ADD CONSTRAINT chk_batch_job_queue_scan_progress
            CHECK (scan_progress IN ('pending', 'scanning', 'scanned', 'resolved'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batch_job_queue_scan_progress
    ON public.batch_job_queue (scan_progress);

CREATE INDEX IF NOT EXISTS idx_batch_job_queue_scan_leased
    ON public.batch_job_queue (scanning_leased_at)
    WHERE scan_progress = 'scanning';

-- 4b. Add scan_run_id to scanned_jobs for current-run scoping (R10)
ALTER TABLE public.scanned_jobs
    ADD COLUMN IF NOT EXISTS scan_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scanned_jobs_scan_run_id
    ON public.scanned_jobs (scan_run_id);

-- 5. Create submission_task_events audit table (R13, R16: NO ON DELETE CASCADE, NO anon grants)
CREATE TABLE IF NOT EXISTS public.submission_task_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES public.submission_tasks(id),
    old_status TEXT,
    new_status TEXT NOT NULL,
    worker_id TEXT,
    actor TEXT NOT NULL DEFAULT 'system',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submission_task_events_task_id
    ON public.submission_task_events (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submission_task_events_actor
    ON public.submission_task_events (actor);

ALTER TABLE public.submission_task_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    REVOKE ALL ON public.submission_task_events FROM anon, public;
    GRANT SELECT, INSERT ON public.submission_task_events TO authenticated, service_role;
END $$;

-- 6. Trigger Function enforcing explicit allowed-transition table (R2, R13)
-- Security: SET search_path = public; one-shot actor design; strict screenshot and review_flag checks
CREATE OR REPLACE FUNCTION public.fn_guard_submission_task_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_actor TEXT;
    v_details JSONB;
BEGIN
    -- On INSERT: force status_actor to 'system' so privileged values can never be inserted
    IF TG_OP = 'INSERT' THEN
        NEW.status_actor := 'system';
        RETURN NEW;
    END IF;

    -- If status did not change: reset status_actor to 'system' and return immediately
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        NEW.status_actor := 'system';
        RETURN NEW;
    END IF;

    -- Resolve actor: NEW.status_actor if non-empty and not 'system', else current_setting fallback, else 'system'
    v_actor := CASE
        WHEN NEW.status_actor IS NOT NULL AND NEW.status_actor NOT IN ('', 'system') THEN NEW.status_actor
        ELSE COALESCE(NULLIF(current_setting('app.actor', true), ''), 'system')
    END;

    -- Build event audit details
    v_details := jsonb_build_object(
        'worker_id', NEW.worker_id,
        'old_worker_id', OLD.worker_id,
        'possibly_submitted', NEW.possibly_submitted,
        'has_screenshot', (NEW.application_submitted_screenshot_url IS NOT NULL OR NEW.screenshot_path IS NOT NULL),
        'updated_at', now()
    );

    -- Strict Rule R13: Submitted is terminal. Nothing can leave submitted status.
    IF OLD.status = 'submitted' THEN
        RAISE EXCEPTION 'Illegal status transition: task (%) is submitted and cannot change (target: % by actor %)',
            OLD.id, NEW.status, v_actor;
    END IF;

    -- Explicit Allowed-Transition State Machine
    IF OLD.status = 'ready_for_review' AND NEW.status = 'queued' THEN
        -- Allowed: Developer Submit toggle ON transitions task to queued
        NULL;

    ELSIF OLD.status = 'queued' AND NEW.status = 'applying' THEN
        -- Allowed: Worker atomic claim MUST provide non-null worker_id
        IF NEW.worker_id IS NULL OR length(trim(NEW.worker_id)) = 0 THEN
            RAISE EXCEPTION 'Illegal transition: queued -> applying requires non-null worker_id (task %)', OLD.id;
        END IF;

    ELSIF OLD.status = 'queued' AND NEW.status = 'ready_for_review' THEN
        -- Allowed: Rollback unstarted queued task upon Stop signal
        NULL;

    ELSIF OLD.status = 'applying' AND NEW.status = 'submitted' THEN
        -- Allowed: Verified Workday application submission with proof screenshot URL or path (R13)
        IF (NEW.application_submitted_screenshot_url IS NULL OR length(trim(NEW.application_submitted_screenshot_url)) = 0)
           AND (NEW.screenshot_path IS NULL OR length(trim(NEW.screenshot_path)) = 0) THEN
            RAISE EXCEPTION 'Illegal transition: applying -> submitted requires proof screenshot (task %)', OLD.id;
        END IF;

    ELSIF OLD.status = 'applying' AND NEW.status = 'failed' THEN
        -- Guarded: Requires error_message non-empty AND screenshot non-empty (or review_flag = 'screenshot_capture_failed')
        IF NEW.error_message IS NULL OR length(trim(NEW.error_message)) = 0 THEN
            RAISE EXCEPTION 'Illegal transition: applying -> failed requires error_message (task %)', OLD.id;
        END IF;
        IF (NEW.application_submitted_screenshot_url IS NULL OR length(trim(NEW.application_submitted_screenshot_url)) = 0)
           AND (NEW.screenshot_path IS NULL OR length(trim(NEW.screenshot_path)) = 0)
           AND COALESCE(NEW.review_flag, '') <> 'screenshot_capture_failed' THEN
            RAISE EXCEPTION 'Illegal transition: applying -> failed requires screenshot or review_flag=screenshot_capture_failed (task %)', OLD.id;
        END IF;

    ELSIF OLD.status = 'applying' AND NEW.status = 'ready_for_review' THEN
        -- Allowed ONLY for actors 'stop', 'reaper', 'manual_repair'
        IF v_actor NOT IN ('stop', 'reaper', 'manual_repair') THEN
            RAISE EXCEPTION 'Illegal transition: applying -> ready_for_review allowed only for stop, reaper, manual_repair (got: % for task %)',
                v_actor, OLD.id;
        END IF;

    ELSIF OLD.status = 'applying' AND NEW.status = 'queued' THEN
        -- Allowed: Graceful worker yield / retry
        NULL;

    ELSIF OLD.status = 'failed' AND NEW.status = 'ready_for_review' THEN
        -- Controlled manual repair path: Strictly requires actor = 'manual_repair'
        IF v_actor <> 'manual_repair' THEN
            RAISE EXCEPTION 'Illegal transition: failed -> ready_for_review allowed only for manual_repair (got: % for task %)',
                v_actor, OLD.id;
        END IF;

    ELSE
        -- All other transitions are strictly rejected
        RAISE EXCEPTION 'Illegal status transition (%): % -> % by actor % is not permitted',
            OLD.id, OLD.status, NEW.status, v_actor;
    END IF;

    -- Audit transition to submission_task_events
    INSERT INTO public.submission_task_events (
        task_id, old_status, new_status, worker_id, actor, details, created_at
    ) VALUES (
        NEW.id, OLD.status, NEW.status, NEW.worker_id, v_actor, v_details, now()
    );

    -- One-shot actor: Reset status_actor to 'system' before returning so privileged actor never persists
    NEW.status_actor := 'system';
    RETURN NEW;
END;
$$;

-- 7. Attach Trigger: Fires on EVERY INSERT OR UPDATE (guarantees status_actor is ALWAYS 'system' on row)
DROP TRIGGER IF EXISTS trg_submission_task_guard ON public.submission_tasks;

CREATE TRIGGER trg_submission_task_guard
    BEFORE INSERT OR UPDATE ON public.submission_tasks
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_guard_submission_task_status();

-- 8. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
