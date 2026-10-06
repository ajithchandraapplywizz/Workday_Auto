-- ==============================================================================
-- Migration: 013_create_job_distributions_table.sql
-- Description: Creates job_distributions table to track the distribution of
--              scraped questions from each unique job link to all clients
--              who have the same or similar job link in their queue.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.job_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,                         -- Client AWL ID receiving the questions
    job_id TEXT,                                        -- Job Req ID / External ID
    job_url TEXT NOT NULL,                              -- Workday Job URL
    company TEXT NOT NULL,                              -- Company Name
    role_title TEXT,                                    -- Role Title
    lead_applywizz_id TEXT,                             -- Candidate who scraped the job
    scraped_questions JSONB NOT NULL DEFAULT '[]'::jsonb, -- Discovered form questions & options
    question_count INT NOT NULL DEFAULT 0,              -- Number of questions
    status TEXT NOT NULL DEFAULT 'distributed',         -- 'distributed' | 'pre_resolved' | 'submitted'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_job_distributions_awl_url UNIQUE (applywizz_id, job_url)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_job_dist_awl ON public.job_distributions(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_job_dist_url ON public.job_distributions(job_url);
CREATE INDEX IF NOT EXISTS idx_job_dist_lead ON public.job_distributions(lead_applywizz_id);
CREATE INDEX IF NOT EXISTS idx_job_dist_created ON public.job_distributions(created_at DESC);

-- Enable RLS & Service Role Policy
ALTER TABLE public.job_distributions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on job_distributions" ON public.job_distributions;
    CREATE POLICY "Enable full access for authenticated service role on job_distributions"
        ON public.job_distributions FOR ALL USING (true);
END $$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
