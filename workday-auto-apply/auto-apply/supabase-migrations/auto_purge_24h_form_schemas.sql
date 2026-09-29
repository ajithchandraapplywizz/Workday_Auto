-- ==============================================================================
-- AUTOMATIC 24-HOUR PURGE FOR STORED APPLICATION FORM QUESTIONS & SCHEMAS
-- Purpose:
--   Automatically purge stored JSON format questions and pre-resolved candidate
--   answers after 24 hours so question caches stay fresh and do not accumulate stale data.
-- ==============================================================================

-- 1. Create a cleanup function that deletes schemas older than 24 hours
CREATE OR REPLACE FUNCTION public.purge_expired_job_form_schemas_24h()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_schemas_count INT := 0;
    cleared_queue_count INT := 0;
BEGIN
    -- Delete question schemas older than 24 hours from job_form_schemas
    DELETE FROM public.job_form_schemas
    WHERE created_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS deleted_schemas_count = ROW_COUNT;

    -- Clear pre_resolved_answers JSON from queue rows older than 24 hours
    UPDATE public.batch_job_queue
    SET pre_resolved_answers = '{}'::jsonb
    WHERE created_at < NOW() - INTERVAL '24 hours'
      AND pre_resolved_answers <> '{}'::jsonb;
    GET DIAGNOSTICS cleared_queue_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'purged_schemas', deleted_schemas_count,
        'cleared_queue_answers', cleared_queue_count,
        'purged_at', NOW()
    );
END;
$$;

-- 2. Grant execution permission to service_role and authenticated users
GRANT EXECUTE ON FUNCTION public.purge_expired_job_form_schemas_24h() TO postgres, anon, authenticated, service_role;

-- 3. Automatic Hourly Cron Job (using Supabase pg_cron extension)
-- Note: Enable the pg_cron extension in Supabase Dashboard -> Database -> Extensions if not already enabled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Unschedule previous job if existing
    PERFORM cron.unschedule('purge-24h-job-form-schemas');
    
    -- Schedule to run automatically at minute 0 of every hour
    PERFORM cron.schedule(
      'purge-24h-job-form-schemas',
      '0 * * * *',
      'SELECT public.purge_expired_job_form_schemas_24h();'
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not enabled. Purge function will be called on-demand or by backend workers.';
END $$;
