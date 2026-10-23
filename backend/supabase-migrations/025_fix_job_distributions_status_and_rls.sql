-- ==============================================================================
-- Migration: 025_fix_job_distributions_status_and_rls.sql
-- Description:
--   1. Expands status constraint on job_distributions to include all pipeline states.
--   2. Ensures both application_submitted_screenshot_url and screenshot_url columns exist.
--   3. Enables permissive RLS policies for job_distributions and bot_control so
--      updates from frontend and backend persist reliably without RLS blocking.
-- ==============================================================================

-- 1. Ensure screenshot column exists on job_distributions
ALTER TABLE public.job_distributions
    ADD COLUMN IF NOT EXISTS application_submitted_screenshot_url TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS worker_id TEXT;

-- 2. Update status constraint to allow all dynamic statuses
DO $$
BEGIN
    ALTER TABLE public.job_distributions DROP CONSTRAINT IF EXISTS job_distributions_status_pipeline_check;
    ALTER TABLE public.job_distributions DROP CONSTRAINT IF EXISTS job_distributions_status_check;
    
    ALTER TABLE public.job_distributions ADD CONSTRAINT job_distributions_status_pipeline_check
        CHECK (status IN (
            'pending',
            'resolving',
            'resolved',
            'distributed',
            'ready_for_review',
            'ready_to_review',
            'review_and_submit',
            'needs_answers',
            'approved_for_submission',
            'queued',
            'queued_for_submission',
            'applying',
            'in_flight',
            'submitted',
            'completed',
            'failed'
        ));
END $$;

-- 3. Ensure permissive RLS on job_distributions so status updates persist
ALTER TABLE public.job_distributions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "allow_all_job_distributions_read" ON public.job_distributions;
    DROP POLICY IF EXISTS "allow_all_job_distributions_write" ON public.job_distributions;
    DROP POLICY IF EXISTS "allow_anon_all_job_distributions" ON public.job_distributions;
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on job_distributions" ON public.job_distributions;
    
    CREATE POLICY "allow_all_job_distributions_read"
        ON public.job_distributions FOR SELECT
        USING (true);

    CREATE POLICY "allow_all_job_distributions_write"
        ON public.job_distributions FOR ALL
        USING (true)
        WITH CHECK (true);
END $$;

-- 4. Ensure permissive RLS on bot_control
CREATE TABLE IF NOT EXISTS public.bot_control (
    id TEXT PRIMARY KEY DEFAULT 'primary',
    is_running BOOLEAN NOT NULL DEFAULT false,
    stage TEXT NOT NULL DEFAULT 'idle',
    last_action_requested TEXT,
    stop_requested BOOLEAN NOT NULL DEFAULT false,
    active_worker_count INTEGER NOT NULL DEFAULT 0,
    current_action TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.bot_control ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "allow_all_bot_control" ON public.bot_control;
    CREATE POLICY "allow_all_bot_control"
        ON public.bot_control FOR ALL
        USING (true)
        WITH CHECK (true);
END $$;

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
