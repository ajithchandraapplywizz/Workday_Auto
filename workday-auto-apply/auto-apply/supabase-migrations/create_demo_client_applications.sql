-- ==============================================================================
-- DEMO: 40-Client Blueprint Pre-fill & Screenshot Table
-- Paste this into Supabase SQL Editor
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.demo_client_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Column 1: Job Link (same for all 40 rows in a job batch)
    job_url TEXT NOT NULL,
    company TEXT,
    role_title TEXT,
    
    -- Column 2: Individual Client ID (1 client per row)
    awl_id TEXT NOT NULL,
    
    -- Column 3: Scraped JSON Questions & Answers
    -- Row 1: Scraped live from Workday Review DOM
    -- Rows 2-40: Copied / referenced from Row 1
    scraped_qa_json JSONB DEFAULT '{}'::jsonb,
    
    -- Column 4: Screenshots (saved after reaching Review / Submit or Failure)
    screenshot_url TEXT,
    failure_screenshot_url TEXT,
    
    -- Lifecycle Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',              -- Ready in queue
        'blueprint_scanning',   -- Client 1 currently scanning/filling
        'pre_filled',           -- Q&A loaded, ready for instant fill
        'filling',              -- Browser actively filling
        'reached_review',       -- Reached review screen, screenshot captured
        'submitted',            -- Final Submit button clicked
        'failed'                -- Encountered error (see error_message)
    )),
    
    is_blueprint BOOLEAN DEFAULT false,
    error_message TEXT,
    worker_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(job_url, awl_id)
);

CREATE INDEX IF NOT EXISTS idx_demo_apps_url ON public.demo_client_applications (job_url);
CREATE INDEX IF NOT EXISTS idx_demo_apps_status ON public.demo_client_applications (status);
CREATE INDEX IF NOT EXISTS idx_demo_apps_awl_id ON public.demo_client_applications (awl_id);

ALTER TABLE public.demo_client_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable full access for service role on demo_client_applications"
    ON public.demo_client_applications FOR ALL USING (true);
