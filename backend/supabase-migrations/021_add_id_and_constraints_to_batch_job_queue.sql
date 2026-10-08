-- ==============================================================================
-- Migration: 021_add_id_and_constraints_to_batch_job_queue.sql
-- Description: Adds 'id' UUID PRIMARY KEY and UNIQUE(applywizz_id, job_url)
--              to public.batch_job_queue table, resolving 42703 PostgREST errors.
-- ==============================================================================

-- 1. Add id column with default UUID generator if missing
ALTER TABLE public.batch_job_queue
ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- 2. Backfill UUID for any existing rows where id is null
UPDATE public.batch_job_queue
SET id = gen_random_uuid()
WHERE id IS NULL;

-- 3. Make id column NOT NULL and ensure it is the PRIMARY KEY
ALTER TABLE public.batch_job_queue
ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = 'batch_job_queue'
          AND tc.constraint_type = 'PRIMARY KEY'
    ) THEN
        ALTER TABLE public.batch_job_queue ADD PRIMARY KEY (id);
    END IF;
END $$;

-- 4. Ensure unique constraint on (applywizz_id, job_url) for idempotent batch ingestion
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_job_queue_client_job
ON public.batch_job_queue (applywizz_id, job_url);

-- 5. Refresh PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
