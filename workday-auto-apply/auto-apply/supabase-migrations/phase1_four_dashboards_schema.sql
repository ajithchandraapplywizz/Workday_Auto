-- ==============================================================================
-- PHASE 1: FOUR DASHBOARDS SCHEMA MIGRATION (ADDITIVE ONLY)
-- File: phase1_four_dashboards_schema.sql
-- ==============================================================================

-- 1. Table: managers (Stores operational managers Balaji & Ramakrishna)
CREATE TABLE IF NOT EXISTS public.managers (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pre-seed known Operational Managers (derived from repeating careerassociatemanagerid frequency)
INSERT INTO public.managers (id, name, email)
VALUES 
    ('bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744', 'Balaji', 'balaji@applywizz.com'),
    ('9dc9376e-fbc5-440b-932f-38da10b89a70', 'Ramakrishna', 'ramakrishna@applywizz.com')
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    updated_at = now();

-- 2. Table: operators (Roster of 59 CAs synced from /api/ca/emails + manager assignment & status)
CREATE TABLE IF NOT EXISTS public.operators (
    id TEXT PRIMARY KEY, -- CA UUID from /api/ca/emails
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'CA', -- 'CA' or 'Junior CA'
    manager_id TEXT REFERENCES public.managers(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    last_sign_in TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operators_manager_id ON public.operators (manager_id);
CREATE INDEX IF NOT EXISTS idx_operators_email ON public.operators (email);
CREATE INDEX IF NOT EXISTS idx_operators_status ON public.operators (status);

-- 3. Table: client_assignment_log (Append-only snapshot of CA & Manager assignment over time)
CREATE TABLE IF NOT EXISTS public.client_assignment_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT,
    applywizz_id TEXT NOT NULL,
    ca_id TEXT,
    ca_email TEXT,
    manager_id TEXT REFERENCES public.managers(id) ON DELETE SET NULL,
    manager_email TEXT,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to TIMESTAMPTZ, -- NULL means currently active assignment
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_assignment_log_current 
    ON public.client_assignment_log (applywizz_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_assignment_log_ca_email 
    ON public.client_assignment_log (ca_email);
CREATE INDEX IF NOT EXISTS idx_client_assignment_log_manager_id 
    ON public.client_assignment_log (manager_id);
CREATE INDEX IF NOT EXISTS idx_client_assignment_log_effective_window 
    ON public.client_assignment_log (effective_from, effective_to);

-- 4. Table: applications (ADDITIVE ONLY: Add missing columns if applications already exists)
DO $$ BEGIN
    CREATE TABLE IF NOT EXISTS public.applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        applywizz_id TEXT NOT NULL,
        client_id TEXT,
        ca_id TEXT,
        manager_id TEXT REFERENCES public.managers(id) ON DELETE SET NULL,
        job_title TEXT,
        company TEXT,
        ats TEXT NOT NULL DEFAULT 'workday',
        job_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'started', 'in_progress', 'ready_for_review', 'submitted', 'failed', 'skipped')),
        error_category TEXT CHECK (
            error_category IS NULL OR 
            error_category IN ('ca_not_confirmed', 'timeout_stalled', 'captcha', 'unsupported_ats') OR 
            error_category LIKE 'field_not_answered:%'
        ),
        failure_reason TEXT,
        started_at TIMESTAMPTZ,
        submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
EXCEPTION
    WHEN duplicate_table THEN null;
END $$;

ALTER TABLE public.applications
    ADD COLUMN IF NOT EXISTS client_id TEXT,
    ADD COLUMN IF NOT EXISTS ca_id TEXT,
    ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES public.managers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS job_title TEXT,
    ADD COLUMN IF NOT EXISTS ats TEXT DEFAULT 'workday',
    ADD COLUMN IF NOT EXISTS error_category TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Add check constraint on error_category to prevent string drift if not present
DO $$ BEGIN
    ALTER TABLE public.applications 
        ADD CONSTRAINT chk_applications_error_category 
        CHECK (
            error_category IS NULL OR 
            error_category IN ('ca_not_confirmed', 'timeout_stalled', 'captcha', 'unsupported_ats') OR 
            error_category LIKE 'field_not_answered:%'
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS idx_applications_applywizz_id ON public.applications (applywizz_id);
CREATE INDEX IF NOT EXISTS idx_applications_manager_id ON public.applications (manager_id);
CREATE INDEX IF NOT EXISTS idx_applications_ca_id ON public.applications (ca_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON public.applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_error_category ON public.applications (error_category);
CREATE INDEX IF NOT EXISTS idx_applications_created_at ON public.applications (created_at DESC);

-- 5. Table: application_answers (Powers answer source breakdown AI/Supabase/Resume/Manual & Operator review)
CREATE TABLE IF NOT EXISTS public.application_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES public.applications(id) ON DELETE CASCADE,
    field_label TEXT NOT NULL,
    answer_value TEXT,
    answer_source TEXT NOT NULL CHECK (answer_source IN ('ai', 'supabase', 'resume', 'manual')),
    edited_by_ca BOOLEAN NOT NULL DEFAULT false,
    confirmed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_answers_app_id ON public.application_answers (application_id);
CREATE INDEX IF NOT EXISTS idx_application_answers_source ON public.application_answers (answer_source);

-- 6. Table: worker_status (Powers the "1 in-flight, 10 idle" Workers tile)
CREATE TABLE IF NOT EXISTS public.worker_status (
    worker_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'in_flight')),
    current_application_id UUID REFERENCES public.applications(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pre-seed 1 worker for pool tracking (Strictly 1 worker allocated)
INSERT INTO public.worker_status (worker_id, state)
VALUES ('Worker-1', 'idle')
ON CONFLICT (worker_id) DO NOTHING;

-- 7. Table: automation_trace (Debug execution trace stream per application)
CREATE TABLE IF NOT EXISTS public.automation_trace (
    id BIGSERIAL PRIMARY KEY,
    application_id UUID REFERENCES public.applications(id) ON DELETE CASCADE,
    step_index INT NOT NULL DEFAULT 0,
    message TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_trace_app_ts ON public.automation_trace (application_id, ts DESC);
ALTER TABLE public.automation_trace ADD COLUMN IF NOT EXISTS applywizz_id TEXT;
CREATE INDEX IF NOT EXISTS idx_automation_trace_applywizz_id ON public.automation_trace (applywizz_id, ts DESC);

-- 8. Table: job_templates (Keyed primarily on tenant + posting_id to prevent URL tracking param undercounting)
CREATE TABLE IF NOT EXISTS public.job_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant TEXT NOT NULL,
    posting_id TEXT NOT NULL,
    canonical_job_url TEXT NOT NULL,
    required_fields JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of { selector, label, control_type }
    hit_count INT NOT NULL DEFAULT 1,
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant, posting_id)
);

CREATE INDEX IF NOT EXISTS idx_job_templates_tenant_posting ON public.job_templates (tenant, posting_id);
CREATE INDEX IF NOT EXISTS idx_job_templates_canonical_url ON public.job_templates (canonical_job_url);
CREATE INDEX IF NOT EXISTS idx_job_templates_hit_count ON public.job_templates (hit_count DESC);

-- 9. Row Level Security (RLS) Explicit Policies

-- Enable RLS on all new tables
ALTER TABLE public.managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_assignment_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_templates ENABLE ROW LEVEL SECURITY;

-- Service Role (Full bypass for backend worker engines and CLI scripts)
DROP POLICY IF EXISTS "service_role_all_managers" ON public.managers;
CREATE POLICY "service_role_all_managers" ON public.managers FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_operators" ON public.operators;
CREATE POLICY "service_role_all_operators" ON public.operators FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_assignment_log" ON public.client_assignment_log;
CREATE POLICY "service_role_all_assignment_log" ON public.client_assignment_log FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_applications" ON public.applications;
CREATE POLICY "service_role_all_applications" ON public.applications FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_answers" ON public.application_answers;
CREATE POLICY "service_role_all_answers" ON public.application_answers FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_workers" ON public.worker_status;
CREATE POLICY "service_role_all_workers" ON public.worker_status FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_trace" ON public.automation_trace;
CREATE POLICY "service_role_all_trace" ON public.automation_trace FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_templates" ON public.job_templates;
CREATE POLICY "service_role_all_templates" ON public.job_templates FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Explicit Read/Write Policies for Authenticated & Public Dashboard Sessions
-- (Allows dashboard reading and updates while backend/app layer supplies scoping)
DROP POLICY IF EXISTS "allow_read_managers" ON public.managers;
CREATE POLICY "allow_read_managers" ON public.managers FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_read_operators" ON public.operators;
CREATE POLICY "allow_read_operators" ON public.operators FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_read_assignment_log" ON public.client_assignment_log;
CREATE POLICY "allow_read_assignment_log" ON public.client_assignment_log FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_read_applications" ON public.applications;
CREATE POLICY "allow_read_applications" ON public.applications FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_write_applications" ON public.applications;
CREATE POLICY "allow_write_applications" ON public.applications FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_read_answers" ON public.application_answers;
CREATE POLICY "allow_read_answers" ON public.application_answers FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_write_answers" ON public.application_answers;
CREATE POLICY "allow_write_answers" ON public.application_answers FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_read_workers" ON public.worker_status;
CREATE POLICY "allow_read_workers" ON public.worker_status FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_read_trace" ON public.automation_trace;
CREATE POLICY "allow_read_trace" ON public.automation_trace FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_read_templates" ON public.job_templates;
CREATE POLICY "allow_read_templates" ON public.job_templates FOR SELECT USING (true);
