-- Migration 051: Align qa_bank constraints and indexes
-- Ensures qa_bank has clean unique index on (tenant, normalized_question)
-- and drops legacy constraint on (applywizz_id, question_normalized) if present.

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS tenant TEXT DEFAULT 'global';

ALTER TABLE public.qa_bank 
ADD COLUMN IF NOT EXISTS normalized_question TEXT;

UPDATE public.qa_bank 
SET normalized_question = COALESCE(question_normalized, question, 'unknown') 
WHERE normalized_question IS NULL;

UPDATE public.qa_bank 
SET tenant = 'global' 
WHERE tenant IS NULL;

-- Remove duplicates on (tenant, normalized_question) keeping newest
DELETE FROM public.qa_bank a USING public.qa_bank b
WHERE a.id <> b.id
  AND a.tenant = b.tenant
  AND a.normalized_question = b.normalized_question
  AND a.updated_at < b.updated_at;

-- Drop legacy table-level unique constraint if it still exists
ALTER TABLE public.qa_bank DROP CONSTRAINT IF EXISTS qa_bank_applywizz_id_question_normalized_key;

-- Ensure unique index exists on (tenant, normalized_question)
CREATE UNIQUE INDEX IF NOT EXISTS qa_bank_tenant_question_unique 
ON public.qa_bank (tenant, normalized_question);

NOTIFY pgrst, 'reload schema';
