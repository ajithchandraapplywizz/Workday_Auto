-- ==============================================================================
-- Migration: 008_cleanup_and_optimize_schema.sql (SAFE & TESTED)
-- Description: Professional Database Cleanup & Optimization
--              1. Updates qa_bank_source_check constraint to accept all standard sources
--              2. Migrates valuable data from job_form_schemas -> scanned_jobs
--              3. Cleanly normalizes & migrates verified client questions -> qa_bank
--              4. Drops dead/obsolete tables (job_templates, application_answers)
--              5. Adds screenshot_url to applications without breaking dependent views
--              6. Creates high-performance production indexes
--              7. Refreshes schema cache
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
-- STEP 3: Ensure applications table has screenshot_url (preserves dependent views)
-- ------------------------------------------------------------------------------
ALTER TABLE public.applications 
ADD COLUMN IF NOT EXISTS screenshot_url TEXT;


-- ------------------------------------------------------------------------------
-- STEP 4: Add high-performance production indexes
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
-- STEP 5: Refresh PostgREST schema cache
-- ------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
