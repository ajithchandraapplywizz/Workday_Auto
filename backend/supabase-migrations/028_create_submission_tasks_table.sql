-- Migration 028: Create dedicated submission_tasks table for 3 submitting workers
-- Tracks on-demand review & submit actions with queued -> applying -> submitted lifecycle.

CREATE TABLE IF NOT EXISTS public.submission_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_id UUID REFERENCES public.job_distributions(id) ON DELETE CASCADE,
    applywizz_id TEXT NOT NULL,
    job_url TEXT NOT NULL,
    company TEXT,
    role_title TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applying', 'submitted', 'failed')),
    worker_id TEXT,
    application_submitted_screenshot_url TEXT,
    reviewed_by TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submission_tasks_status ON public.submission_tasks(status);
CREATE INDEX IF NOT EXISTS idx_submission_tasks_worker ON public.submission_tasks(worker_id);
CREATE INDEX IF NOT EXISTS idx_submission_tasks_awl ON public.submission_tasks(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_submission_tasks_dist ON public.submission_tasks(distribution_id);

-- Permissive RLS for realtime UI visibility
ALTER TABLE public.submission_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "submission_tasks_service_role" ON public.submission_tasks;
CREATE POLICY "submission_tasks_service_role" ON public.submission_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "submission_tasks_anon_all" ON public.submission_tasks;
CREATE POLICY "submission_tasks_anon_all" ON public.submission_tasks FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "submission_tasks_auth_all" ON public.submission_tasks;
CREATE POLICY "submission_tasks_auth_all" ON public.submission_tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Enable Supabase Realtime publication for submission_tasks
ALTER PUBLICATION supabase_realtime ADD TABLE public.submission_tasks;
