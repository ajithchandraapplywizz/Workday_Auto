-- ==============================================================================
-- Migration: 008_cleanup_and_optimize_schema.sql (FIXED & ROBUST)
-- Description: Professional Database Cleanup & Optimization
--              1. Updates qa_bank_source_check constraint to accept all standard sources
--              2. Migrates valuable data from job_form_schemas -> scanned_jobs
--              3. Cleanly normalizes & migrates verified client questions -> qa_bank
--              4. Drops dead/obsolete tables (job_templates, application_answers)
--              5. Replaces legacy batch_job_queue & job_form_schemas with clean views
--              6. Cleans redundant/dead columns from applications table
--              7. Creates high-performance production indexes
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
-- STEP 3: Replace legacy physical tables with clean views (eliminating duplication)
-- ------------------------------------------------------------------------------

-- Drop legacy empty batch_job_queue table and replace with view pointing to resolved_answers
DROP TABLE IF EXISTS public.batch_job_queue CASCADE;

CREATE OR REPLACE VIEW public.batch_job_queue AS
SELECT 
    id,
    applywizz_id,
    NULL::text AS candidate_email,
    job_url,
    company,
    role_title,
    CASE 
        WHEN status = 'ready_for_review' THEN 'pre_resolved'
        WHEN status = 'queued_for_submission' THEN 'approved_for_submission'
        ELSE status
    END AS status,
    worker_id,
    worker_leased_at AS locked_at,
    0 AS attempts,
    2 AS max_attempts,
    error_message,
    screenshot_url AS screenshot_path,
    created_at,
    worker_leased_at AS started_at,
    CASE WHEN status = 'submitted' THEN updated_at ELSE NULL END AS completed_at,
    updated_at,
    resolved_answers_json AS pre_resolved_answers
FROM public.resolved_answers;

-- Drop legacy job_form_schemas table and replace with view pointing to scanned_jobs
DROP TABLE IF EXISTS public.job_form_schemas CASCADE;

CREATE OR REPLACE VIEW public.job_form_schemas AS
SELECT 
    id,
    job_url AS canonical_job_url,
    split_part(split_part(job_url, '//', 2), '.', 1) AS tenant,
    company,
    role_title,
    'workday'::text AS ats_type,
    scraped_questions AS fields_schema,
    step_names,
    question_count AS total_fields,
    applywizz_id AS scanned_by_applywizz_id,
    created_at,
    updated_at
FROM public.scanned_jobs;


-- ------------------------------------------------------------------------------
-- STEP 4: Clean up unused & redundant columns in applications table
-- ------------------------------------------------------------------------------

-- Ensure screenshot_url column exists
ALTER TABLE public.applications 
ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

-- Drop redundant / always-null columns from applications
ALTER TABLE public.applications 
DROP COLUMN IF EXISTS client_id,
DROP COLUMN IF EXISTS job_title,
DROP COLUMN IF EXISTS ats,
DROP COLUMN IF EXISTS started_at,
DROP COLUMN IF EXISTS submitted_at;


-- ------------------------------------------------------------------------------
-- STEP 5: Add high-performance production indexes
-- ------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_scanned_jobs_url_clean 
ON public.scanned_jobs (job_url);

CREATE INDEX IF NOT EXISTS idx_resolved_answers_perf 
ON public.resolved_answers (applywizz_id, is_fully_answered, status);

CREATE INDEX IF NOT EXISTS idx_qa_bank_perf 
ON public.qa_bank (applywizz_id, question_normalized);

CREATE INDEX IF NOT EXISTS idx_applications_perf 
ON public.applications (applywizz_id, status);

CREATE INDEX IF NOT EXISTS idx_clients_awl_perf 
ON public.clients (applywizz_id);

-- ------------------------------------------------------------------------------
-- STEP 6: Refresh PostgREST schema cache
-- ------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
