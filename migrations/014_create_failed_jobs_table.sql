-- ==============================================================================
-- Migration: 014_create_failed_jobs_table.sql
-- Description: Creates failed_jobs table to store every job application that failed
--              or did not reach the Review & Submit page, including exact failure
--              reason, the step where it failed, and the proof failure screenshot.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.failed_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,                         -- Candidate AWL ID
    job_id TEXT,                                        -- Job ID / Requisition ID
    job_url TEXT NOT NULL,                              -- Job URL
    company TEXT,                                       -- Company name
    role_title TEXT,                                    -- Role Title
    failure_reason TEXT NOT NULL,                       -- Detailed reason why it failed
    failed_at_step TEXT NOT NULL DEFAULT 'Unknown',     -- Specific step where it failed (e.g. My Experience, Auth Gateway)
    screenshot_path TEXT,                               -- Storage screenshot of failure / error banner
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_failed_jobs_awl ON public.failed_jobs(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_url ON public.failed_jobs(job_url);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_step ON public.failed_jobs(failed_at_step);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_created ON public.failed_jobs(created_at DESC);

-- Enable RLS & Service Role Policy
ALTER TABLE public.failed_jobs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on failed_jobs" ON public.failed_jobs;
    CREATE POLICY "Enable full access for authenticated service role on failed_jobs"
        ON public.failed_jobs FOR ALL USING (true);
END $$;

-- Clean up any incomplete rows from scanned_jobs (scanned_jobs is strictly for Review & Submit reached jobs)
DELETE FROM public.scanned_jobs WHERE scan_status != 'completed' OR question_count = 0;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
