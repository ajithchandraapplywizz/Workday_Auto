-- ==============================================================================
-- Migration: 012_create_application_failures_table.sql
-- Description: Creates application_failures table to record every failed run,
--              including candidate AWL ID, job ID, job URL, failed reason,
--              and exact proof failure screenshot.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.application_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,
    job_id TEXT,
    job_url TEXT NOT NULL,
    company TEXT,
    role_title TEXT,
    failure_reason TEXT NOT NULL,
    screenshot_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_app_failures_awl ON public.application_failures(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_app_failures_url ON public.application_failures(job_url);
CREATE INDEX IF NOT EXISTS idx_app_failures_created ON public.application_failures(created_at DESC);

-- Enable RLS & Service Role Policy
ALTER TABLE public.application_failures ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on application_failures" ON public.application_failures;
    CREATE POLICY "Enable full access for authenticated service role on application_failures"
        ON public.application_failures FOR ALL USING (true);
END $$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
