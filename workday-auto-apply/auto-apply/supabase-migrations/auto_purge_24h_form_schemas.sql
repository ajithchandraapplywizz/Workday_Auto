-- ==============================================================================
-- AUTOMATIC 24-HOUR & DAILY MIDNIGHT PURGE FOR ALL CLIENT APPLICATION QUESTIONS
-- Purpose:
--   Because client allocations and job question requirements update day-to-day,
--   this script ensures that all stored JSON format questions (job_form_schemas)
--   and all pre-resolved candidate answer cells (batch_job_queue) are automatically
--   purged every 24 hours so every new day begins with fresh, up-to-date data.
-- ==============================================================================

-- 1. Function: Purge expired questions & answers older than 24 hours
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

    -- Reset pre_resolved_answers JSON cell for all client queue rows older than 24 hours
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

-- 2. Function: Force-reset ALL stored questions and answer cells for all clients (Midnight Daily Reset)
CREATE OR REPLACE FUNCTION public.reset_all_daily_client_questions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cleared_schemas INT := 0;
    cleared_answers INT := 0;
BEGIN
    -- Clear all cached question schemas across all jobs
    DELETE FROM public.job_form_schemas;
    GET DIAGNOSTICS cleared_schemas = ROW_COUNT;

    -- Wipe all pre_resolved_answers JSON cells for all clients
    UPDATE public.batch_job_queue
    SET pre_resolved_answers = '{}'::jsonb
    WHERE pre_resolved_answers <> '{}'::jsonb;
    GET DIAGNOSTICS cleared_answers = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'All stored application questions and candidate answer cells reset for the new day',
        'cleared_schemas', cleared_schemas,
        'cleared_answers', cleared_answers,
        'reset_at', NOW()
    );
END;
$$;

-- 3. Grant execution permissions
GRANT EXECUTE ON FUNCTION public.purge_expired_job_form_schemas_24h() TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_all_daily_client_questions() TO postgres, anon, authenticated, service_role;

-- 4. Automatic Cron Scheduling via Supabase pg_cron extension:
--    - Hourly cleanup: deletes any entries exceeding 24 hours
--    - Midnight IST cleanup: resets schemas at 00:00 IST (18:30 UTC) for fresh daily starts
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- A. Schedule hourly rolling 24h purge
    PERFORM cron.unschedule('purge-24h-job-form-schemas');
    PERFORM cron.schedule(
      'purge-24h-job-form-schemas',
      '0 * * * *',
      'SELECT public.purge_expired_job_form_schemas_24h();'
    );

    -- B. Schedule daily midnight reset (18:30 UTC = 00:00 IST)
    PERFORM cron.unschedule('midnight-daily-questions-reset');
    PERFORM cron.schedule(
      'midnight-daily-questions-reset',
      '30 18 * * *',
      'SELECT public.reset_all_daily_client_questions();'
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not enabled. Purge functions will be invoked via backend schedule or API sync.';
END $$;
