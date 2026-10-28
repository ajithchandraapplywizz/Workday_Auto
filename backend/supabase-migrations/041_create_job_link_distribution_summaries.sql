-- ==============================================================================
-- Migration: 041_create_job_link_distribution_summaries.sql
-- Description: Creates table to track link-level success and failure counts,
--              including allotted client counts and JSON formatted AWL IDs.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.job_link_distribution_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_url TEXT NOT NULL UNIQUE,
    company TEXT,
    role_title TEXT,
    total_clients INT NOT NULL DEFAULT 0,
    success_count INT NOT NULL DEFAULT 0,
    success_awl_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    failed_count INT NOT NULL DEFAULT 0,
    failed_awl_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'failed'
    failure_reason TEXT,
    screenshot_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_jlds_job_url ON public.job_link_distribution_summaries(job_url);
CREATE INDEX IF NOT EXISTS idx_jlds_status ON public.job_link_distribution_summaries(status);
CREATE INDEX IF NOT EXISTS idx_jlds_updated_at ON public.job_link_distribution_summaries(updated_at DESC);

-- Enable RLS & Policy
ALTER TABLE public.job_link_distribution_summaries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on job_link_distribution_summaries" ON public.job_link_distribution_summaries;
    CREATE POLICY "Enable full access for authenticated service role on job_link_distribution_summaries"
        ON public.job_link_distribution_summaries FOR ALL USING (true);
END $$;

NOTIFY pgrst, 'reload schema';
