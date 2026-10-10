-- ==============================================================================
-- Migration: 022_create_job_link_intake.sql
-- Description: Creates lean, compact CSV intake table `job_link_intake`.
--              Stores exactly one row per unique Workday job URL, with all
--              associated candidate AWL IDs stored in a native TEXT[] array.
--              Eliminates the N x M row explosion during CSV ingestion.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.job_link_intake (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_url TEXT NOT NULL UNIQUE,                       -- Canonical Workday job URL
    awl_ids TEXT[] NOT NULL DEFAULT '{}',               -- Array of candidate IDs: ARRAY['AWL-25015', 'AWL-25884']
    client_count INT NOT NULL DEFAULT 0,                -- Number of candidates: array_length(awl_ids, 1)
    company TEXT,                                       -- Extracted / parsed company name
    role_title TEXT,                                    -- Role / title extracted from URL or CSV
    job_req_id TEXT,                                    -- Job requisition ID (e.g. REQ-4633, R-561862)
    tenant TEXT,                                        -- Workday tenant (e.g. cambiumlearning, wellsfargo)

    -- Pipeline status tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',         -- Not yet scanned
            'scanning',        -- Worker currently scanning link in browser
            'scanned',         -- Blueprint scan completed & stored in scanned_jobs
            'distributed',     -- Form answers pre-resolved & stored in job_distributions
            'failed',          -- Link expired / closed / no Apply button
            'skipped'          -- Duplicate or unsupported URL
        )),

    scanned_job_id UUID REFERENCES public.scanned_jobs(id) ON DELETE SET NULL,
    worker_id TEXT,                                     -- Active worker handling this link (e.g. 'worker-1')
    locked_at TIMESTAMPTZ,                              -- Lease timestamp for worker concurrency
    error_message TEXT,                                 -- Reason if failed or skipped
    screenshot_path TEXT,                               -- URL/path to review or proof screenshot

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_job_link_intake_status ON public.job_link_intake(status);
CREATE INDEX IF NOT EXISTS idx_job_link_intake_client_count ON public.job_link_intake(client_count DESC);
CREATE INDEX IF NOT EXISTS idx_job_link_intake_worker ON public.job_link_intake(worker_id);
CREATE INDEX IF NOT EXISTS idx_job_link_intake_scanned_job ON public.job_link_intake(scanned_job_id);
CREATE INDEX IF NOT EXISTS idx_job_link_intake_created_at ON public.job_link_intake(created_at DESC);

-- Enable RLS & Service Role Policy
ALTER TABLE public.job_link_intake ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on job_link_intake" ON public.job_link_intake;
    CREATE POLICY "Enable full access for authenticated service role on job_link_intake"
        ON public.job_link_intake FOR ALL USING (true);
END $$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
