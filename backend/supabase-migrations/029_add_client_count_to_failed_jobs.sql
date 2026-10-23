-- ==============================================================================
-- Migration: 029_add_client_count_to_failed_jobs.sql
-- Description:
--   1. Ensures client_count column exists in failed_jobs table to track
--      how many candidates got that exact failed job link.
--   2. Ensures failed-applications storage bucket is registered and public.
-- ==============================================================================

-- 1. Add client_count column to failed_jobs if not already present
ALTER TABLE public.failed_jobs
    ADD COLUMN IF NOT EXISTS client_count INTEGER NOT NULL DEFAULT 1;

-- 2. Create index on client_count for analytics queries
CREATE INDEX IF NOT EXISTS idx_failed_jobs_client_count
    ON public.failed_jobs (client_count DESC);

-- 3. Ensure failed-applications bucket exists in storage.buckets
INSERT INTO storage.buckets (id, name, public)
VALUES ('failed-applications', 'failed-applications', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 4. Enable public read access for failed-applications bucket
DO $$
BEGIN
    DROP POLICY IF EXISTS "Public access for failed-applications" ON storage.objects;
    CREATE POLICY "Public access for failed-applications"
        ON storage.objects FOR SELECT
        USING (bucket_id = 'failed-applications');

    DROP POLICY IF EXISTS "Service role upload for failed-applications" ON storage.objects;
    CREATE POLICY "Service role upload for failed-applications"
        ON storage.objects FOR ALL
        USING (bucket_id = 'failed-applications');
END $$;

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
