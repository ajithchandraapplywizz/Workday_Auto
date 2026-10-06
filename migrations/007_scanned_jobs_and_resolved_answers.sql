-- ==============================================================================
-- Migration: 007_scanned_jobs_and_resolved_answers.sql
-- Description: Creates scanned_jobs, resolved_answers (and answer_resolving view),
--              and qa_bank with 4-tier resolution metadata, zero-incomplete filter,
--              atomic worker leasing, and proof screenshots.
-- ==============================================================================

-- 1. Table: scanned_jobs (Stores parsed form questions extracted from unique job links)
CREATE TABLE IF NOT EXISTS public.scanned_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT,                         -- Initiating client AWL ID
    job_id TEXT,                               -- External Job ID if present
    job_url TEXT NOT NULL UNIQUE,              -- Unique job link
    company TEXT NOT NULL,                     -- Company / Tenant Name
    role_title TEXT,                           -- Role / Position Title
    scraped_questions JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of discovered questions & options
    question_count INT NOT NULL DEFAULT 0,     -- Total question count
    step_names JSONB NOT NULL DEFAULT '[]'::jsonb,        -- Wizard step names
    scan_status TEXT NOT NULL DEFAULT 'completed' CHECK (scan_status IN ('scanning', 'completed', 'failed')),
    error_message TEXT,
    scanned_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for scanned_jobs
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_url ON public.scanned_jobs (job_url);
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_company ON public.scanned_jobs (company);
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_status ON public.scanned_jobs (scan_status);

-- Enable RLS & idempotent policy for scanned_jobs
ALTER TABLE public.scanned_jobs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on scanned_jobs" ON public.scanned_jobs;
    CREATE POLICY "Enable full access for authenticated service role on scanned_jobs"
        ON public.scanned_jobs FOR ALL USING (true);
END $$;


-- 2. Table: resolved_answers (Per-candidate pre-resolved answers across 4-tier engine)
CREATE TABLE IF NOT EXISTS public.resolved_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,                -- Client AWL ID
    scanned_job_id UUID REFERENCES public.scanned_jobs(id) ON DELETE SET NULL,
    job_id TEXT,                               -- External Job ID
    job_url TEXT NOT NULL,                     -- Target job link
    company TEXT NOT NULL,                     -- Company Name
    role_title TEXT,                           -- Role Title
    
    -- JSON array of resolved answer objects with 4-tier source badges:
    -- [{ question, question_normalized, answer, field_type, options, source: '[Supabase]' | '[API]' | '[Resume]' | '[LLM]', is_answered: true }]
    resolved_answers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Strict completion flags:
    is_fully_answered BOOLEAN NOT NULL DEFAULT false,
    unanswered_count INT NOT NULL DEFAULT 0,
    
    -- Lifecycle state flow:
    status TEXT NOT NULL DEFAULT 'ready_for_review' CHECK (status IN (
        'incomplete',               -- Missing required answers; HIDDEN from CA dashboard
        'ready_for_review',         -- 100% complete; Ready for CA review in dashboard
        'queued_for_submission',    -- CA clicked Submit; ready for worker pick-up
        'applying',                 -- Leased by worker; browser filling & submitting
        'submitted',                -- Successfully submitted with screenshot proof
        'failed'                    -- Submission failure (error_message captured)
    )),
    
    -- Parallel worker leasing lock
    worker_id TEXT,
    worker_leased_at TIMESTAMPTZ,
    
    -- Proof & diagnostics
    screenshot_url TEXT,                        -- Supabase storage URL to confirmation screenshot
    error_message TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraint: Each candidate has at most one resolution record per job URL
    UNIQUE(applywizz_id, job_url)
);

-- Indexes for resolved_answers
CREATE INDEX IF NOT EXISTS idx_resolved_answers_ca ON public.resolved_answers (applywizz_id, is_fully_answered, status);
CREATE INDEX IF NOT EXISTS idx_resolved_answers_url ON public.resolved_answers (job_url);
CREATE INDEX IF NOT EXISTS idx_resolved_answers_worker ON public.resolved_answers (status, worker_leased_at);

-- Enable RLS & idempotent policy for resolved_answers
ALTER TABLE public.resolved_answers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on resolved_answers" ON public.resolved_answers;
    CREATE POLICY "Enable full access for authenticated service role on resolved_answers"
        ON public.resolved_answers FOR ALL USING (true);
END $$;


-- 3. View / Alias: answer_resolving (matches exact naming requested)
CREATE OR REPLACE VIEW public.answer_resolving AS
    SELECT * FROM public.resolved_answers;


-- 4. Table: qa_bank (Stores novel/unique questions resolved per candidate for perpetual self-learning)
CREATE TABLE IF NOT EXISTS public.qa_bank (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,
    question TEXT NOT NULL,
    question_normalized TEXT NOT NULL,
    answer TEXT NOT NULL,
    field_type TEXT DEFAULT 'text',
    source TEXT NOT NULL CHECK (source IN ('supabase', 'api', 'resume', 'llm', 'manual')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(applywizz_id, question_normalized)
);

-- Indexes for qa_bank
CREATE INDEX IF NOT EXISTS idx_qa_bank_lookup ON public.qa_bank (applywizz_id, question_normalized);

-- Enable RLS & idempotent policy for qa_bank
ALTER TABLE public.qa_bank ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    DROP POLICY IF EXISTS "Enable full access for authenticated service role on qa_bank" ON public.qa_bank;
    CREATE POLICY "Enable full access for authenticated service role on qa_bank"
        ON public.qa_bank FOR ALL USING (true);
END $$;
