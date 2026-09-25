-- ==============================================================================
-- Migration: 004_job_form_schemas_and_queue.sql
-- Description: Job Form Schemas Cache & Multi-Client Parallel Worker Queue
-- ==============================================================================

-- 1. Table: job_form_schemas (Stores the form structure & question definitions per job link)
CREATE TABLE IF NOT EXISTS public.job_form_schemas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_url TEXT NOT NULL UNIQUE,
    tenant TEXT,
    company TEXT,
    role_title TEXT,
    ats_type TEXT NOT NULL DEFAULT 'workday',
    
    -- Discovered form fields and questions across wizard steps
    fields_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Ordered list of wizard step names discovered
    step_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Total count of questions discovered
    total_fields INT DEFAULT 0,
    
    -- AWL ID of the client who first scanned/applied to this job
    scanned_by_applywizz_id TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by job URL
CREATE INDEX IF NOT EXISTS idx_job_form_schemas_canonical_url ON public.job_form_schemas (canonical_job_url);
CREATE INDEX IF NOT EXISTS idx_job_form_schemas_tenant ON public.job_form_schemas (tenant);

-- Enable RLS
ALTER TABLE public.job_form_schemas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable full access for authenticated service role on job_form_schemas"
    ON public.job_form_schemas FOR ALL USING (true);


-- 2. Table: batch_job_queue (Queue for parallel workers processing CSV links with AWL ID)
CREATE TABLE IF NOT EXISTS public.batch_job_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,
    candidate_email TEXT,
    job_url TEXT NOT NULL,
    company TEXT,
    role_title TEXT,
    
    -- Job status in pipeline
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',              -- Ready to be picked up by a worker
        'processing',           -- Claimed by a worker
        'pre_resolved',         -- Client answers prepared prior to browser launch
        'reached_review',       -- Form filled, review screen reached (dry-run)
        'submitted',            -- Application submitted successfully
        'failed',               -- Application failed (see error_message)
        'skipped'               -- Skipped (duplicate company, unsupported ATS, etc.)
    )),
    
    -- Worker assignment (Worker-1, Worker-2, Worker-3)
    worker_id TEXT,
    locked_at TIMESTAMPTZ,
    
    -- Retry & diagnostic info
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 2,
    error_message TEXT,
    screenshot_path TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Unique constraint: A client only gets applied to a specific job once
    UNIQUE(applywizz_id, job_url)
);

-- Indexes for efficient worker polling & queue dispatch
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_status_worker ON public.batch_job_queue (status, worker_id);
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_applywizz_id ON public.batch_job_queue (applywizz_id);
CREATE INDEX IF NOT EXISTS idx_batch_job_queue_job_url ON public.batch_job_queue (job_url);

-- Enable RLS
ALTER TABLE public.batch_job_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable full access for authenticated service role on batch_job_queue"
    ON public.batch_job_queue FOR ALL USING (true);
