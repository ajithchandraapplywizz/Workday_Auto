-- ==============================================================================
-- Migration: 008_cleanup_and_optimize_schema.sql (RESOLVED & TESTED)
-- Description: Professional Database Cleanup & Optimization
--              1. Updates qa_bank_source_check constraint to accept all standard sources
--              2. Migrates valuable data from job_form_schemas -> scanned_jobs
--              3. Cleanly normalizes & migrates verified client questions -> qa_bank
--              4. Drops dead/obsolete tables (job_templates, application_answers)
--              5. Drops dependent dashboard views with CASCADE
--              6. Cleans redundant columns from applications table (client_id, job_title, etc.)
--              7. Recreates dashboard views cleanly using applywizz_id & role_title
--              8. Creates high-performance production indexes
--              9. Refreshes PostgREST schema cache
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- STEP 0: Make qa_bank source constraint flexible & robust
-- ------------------------------------------------------------------------------
ALTER TABLE public.qa_bank DROP CONSTRAINT IF EXISTS qa_bank_source_check;
ALTER TABLE public.qa_bank ADD CONSTRAINT qa_bank_source_check 
    CHECK (source IN ('supabase', 'api', 'resume', 'llm', 'ai', 'database', 'manual'));

-- ------------------------------------------------------------------------------
-- STEP 1: Migrate valuable data from legacy tables before cleanup
-- ------------------------------------------------------------------------------

-- Migrate 30 existing schemas from job_form_schemas to scanned_jobs
INSERT INTO public.scanned_jobs (
    id,
    applywizz_id,
    job_url,
    company,
    role_title,
    scraped_questions,
    question_count,
    step_names,
    scan_status,
    created_at,
    updated_at
)
SELECT 
    id,
    scanned_by_applywizz_id,
    canonical_job_url,
    company,
    role_title,
    fields_schema,
    COALESCE(total_fields, jsonb_array_length(fields_schema)),
    step_names,
    'completed',
    created_at,
    updated_at
FROM public.job_form_schemas
ON CONFLICT (job_url) DO UPDATE SET
    scraped_questions = EXCLUDED.scraped_questions,
    question_count = EXCLUDED.question_count,
    updated_at = NOW();

-- Migrate distinct Q&A from client_questions into qa_bank with clean source mapping
INSERT INTO public.qa_bank (
    applywizz_id,
    question,
    question_normalized,
    answer,
    field_type,
    source,
    created_at,
    updated_at
)
SELECT DISTINCT ON (applywizz_id, question_normalized)
    applywizz_id,
    COALESCE(question_raw, question_normalized),
    question_normalized,
    answer,
    COALESCE(field_type, 'text'),
    CASE 
        WHEN lower(COALESCE(answer_source, '')) IN ('ai', 'llm', 'openrouter', 'gpt') THEN 'llm'
        WHEN lower(COALESCE(answer_source, '')) IN ('database', 'db', 'supabase') THEN 'supabase'
        WHEN lower(COALESCE(answer_source, '')) IN ('resume', 'experience') THEN 'resume'
        WHEN lower(COALESCE(answer_source, '')) IN ('manual', 'ca') THEN 'manual'
        ELSE 'api'
    END AS source,
    created_at,
    updated_at
FROM public.client_questions
WHERE question_normalized IS NOT NULL 
  AND answer IS NOT NULL 
  AND length(trim(answer)) > 0
ON CONFLICT (applywizz_id, question_normalized) DO UPDATE SET
    answer = EXCLUDED.answer,
    source = EXCLUDED.source,
    updated_at = NOW();

-- ------------------------------------------------------------------------------
-- STEP 2: Drop completely dead / empty legacy prototype tables
-- ------------------------------------------------------------------------------
DROP TABLE IF EXISTS public.job_templates CASCADE;
DROP TABLE IF EXISTS public.application_answers CASCADE;

-- ------------------------------------------------------------------------------
-- STEP 3: Drop dependent dashboard views before cleaning applications table
-- ------------------------------------------------------------------------------
DROP VIEW IF EXISTS public.dashboard_admin_overview CASCADE;
DROP VIEW IF EXISTS public.dashboard_ops_manager_view CASCADE;
DROP VIEW IF EXISTS public.dashboard_ca_team_view CASCADE;

-- ------------------------------------------------------------------------------
-- STEP 4: Clean up unused & redundant columns in applications table
-- ------------------------------------------------------------------------------
ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

ALTER TABLE public.applications 
DROP COLUMN IF EXISTS client_id,
DROP COLUMN IF EXISTS job_title,
DROP COLUMN IF EXISTS ats,
DROP COLUMN IF EXISTS started_at,
DROP COLUMN IF EXISTS submitted_at;

-- ------------------------------------------------------------------------------
-- STEP 5: Recreate dashboard views cleanly using applywizz_id & role_title
-- ------------------------------------------------------------------------------

-- View A: Admin Overview
CREATE OR REPLACE VIEW public.dashboard_admin_overview AS
SELECT 
    c.career_associate_manager_id,
    c.operational_manager_name,
    COUNT(DISTINCT c.applywizz_id) AS total_clients,
    COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'submitted') AS bot_submitted,
    COUNT(DISTINCT a.id) FILTER (WHERE a.status IN ('pending', 'started', 'in_progress', 'ready_for_review', 'queued')) AS bot_pending,
    COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'failed') AS bot_failed
FROM public.clients c
LEFT JOIN public.applications a ON a.applywizz_id = c.applywizz_id
GROUP BY c.career_associate_manager_id, c.operational_manager_name;

-- View B: Operations Manager Overview
CREATE OR REPLACE VIEW public.dashboard_ops_manager_view AS
SELECT 
    c.career_associate_manager_id,
    c.operational_manager_name,
    c.ca_email,
    c.applywizz_id,
    c.client_name,
    c.company_email,
    COUNT(a.id) FILTER (WHERE a.status = 'submitted') AS auto_applied_count,
    COUNT(a.id) FILTER (WHERE a.status IN ('pending', 'started', 'in_progress', 'ready_for_review', 'queued')) AS in_queue_count,
    COUNT(a.id) FILTER (WHERE a.status = 'failed') AS failed_count
FROM public.clients c
LEFT JOIN public.applications a ON a.applywizz_id = c.applywizz_id
GROUP BY c.career_associate_manager_id, c.operational_manager_name, c.ca_email, c.applywizz_id, c.client_name, c.company_email;

-- View C: CA Team View
CREATE OR REPLACE VIEW public.dashboard_ca_team_view AS
SELECT 
    c.ca_email,
    c.applywizz_id,
    c.client_name,
    a.job_url,
    a.company,
    a.role_title AS job_title,
    a.status AS app_status,
    a.error_category,
    a.updated_at AS last_activity
FROM public.clients c
JOIN public.applications a ON a.applywizz_id = c.applywizz_id;

-- ------------------------------------------------------------------------------
-- STEP 6: Add high-performance production indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_url_clean ON public.scanned_jobs (job_url);
CREATE INDEX IF NOT EXISTS idx_resolved_answers_perf ON public.resolved_answers (applywizz_id, is_fully_answered, status);
CREATE INDEX IF NOT EXISTS idx_qa_bank_perf ON public.qa_bank (applywizz_id, question_normalized);
CREATE INDEX IF NOT EXISTS idx_applications_perf ON public.applications (applywizz_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_awl_perf ON public.clients (applywizz_id);

-- ------------------------------------------------------------------------------
-- STEP 7: Refresh PostgREST schema cache
-- ------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
