ALTER TABLE public.batch_job_queue 
ADD COLUMN IF NOT EXISTS attempt_count INT DEFAULT 0;

ALTER TABLE public.failed_jobs 
ADD COLUMN IF NOT EXISTS client_ids JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.failed_jobs 
ADD COLUMN IF NOT EXISTS failed_client_count INT DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_failed_jobs_job_url_key 
ON public.failed_jobs (job_url);

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS tenant TEXT DEFAULT 'global';

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS normalized_question TEXT;

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS step_name TEXT;

UPDATE public.qa_bank 
SET normalized_question = COALESCE(question_normalized, question, 'unknown') 
WHERE normalized_question IS NULL;

UPDATE public.qa_bank 
SET tenant = 'global' 
WHERE tenant IS NULL;

DELETE FROM public.qa_bank a USING public.qa_bank b
WHERE a.id <> b.id
  AND a.tenant = b.tenant
  AND a.normalized_question = b.normalized_question
  AND a.updated_at < b.updated_at;

CREATE UNIQUE INDEX IF NOT EXISTS qa_bank_tenant_question_unique 
ON public.qa_bank (tenant, normalized_question);

NOTIFY pgrst, 'reload schema';
