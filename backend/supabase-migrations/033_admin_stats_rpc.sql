-- ==============================================================================
-- Migration 033: RPC get_admin_stats for Backend-Driven Admin Statistics
-- ==============================================================================
-- Computes IST windowed application counts (day, week, month), live pipeline counts,
-- and 4-tier resolved answer percentages (per-application average and pooled).
--
-- Denominator for percentages strictly includes answered items (tiers 1-4).
-- Unanswered items (tier 0) are tracked separately as unanswered_count.
-- Empty windows gracefully return 0 counts and null percentages (never NaN or error).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_admin_stats(
  p_range text DEFAULT 'day',
  p_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_submitted int := 0;
  v_failed int := 0;
  v_running int := 0;
  v_queued int := 0;
  v_ready_for_review int := 0;
  v_sources jsonb;
BEGIN
  -- 1. Compute IST Boundaries (UTC+05:30)
  IF lower(p_range) = 'week' THEN
    -- Monday 00:00:00 IST to Sunday 23:59:59.999 IST
    v_start := date_trunc('week', p_date::timestamp) AT TIME ZONE 'Asia/Kolkata';
    v_end := (date_trunc('week', p_date::timestamp) + interval '7 days') AT TIME ZONE 'Asia/Kolkata';
  ELSIF lower(p_range) = 'month' THEN
    -- 1st of month 00:00:00 IST to last day of month
    v_start := date_trunc('month', p_date::timestamp) AT TIME ZONE 'Asia/Kolkata';
    v_end := (date_trunc('month', p_date::timestamp) + interval '1 month') AT TIME ZONE 'Asia/Kolkata';
  ELSE -- 'day'
    v_start := p_date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_end := (p_date::timestamp + interval '1 day') AT TIME ZONE 'Asia/Kolkata';
  END IF;

  -- 2. Completed counts inside IST window
  SELECT
    COALESCE(count(*) FILTER (WHERE status = 'submitted'), 0),
    COALESCE(count(*) FILTER (WHERE status = 'failed'), 0)
  INTO v_submitted, v_failed
  FROM public.submission_tasks
  WHERE completed_at >= v_start AND completed_at < v_end;

  -- 3. Live counts (NOT filtered by date)
  SELECT
    COALESCE(count(*) FILTER (WHERE status = 'applying'), 0),
    COALESCE(count(*) FILTER (WHERE status = 'queued'), 0),
    COALESCE(count(*) FILTER (WHERE status = 'ready_for_review'), 0)
  INTO v_running, v_queued, v_ready_for_review
  FROM public.submission_tasks;

  -- 4. 4-Tier Source Resolution:
  -- Join submission_tasks with job_distributions on distribution_id
  WITH window_tasks AS (
    SELECT st.id, st.distribution_id, jd.resolved_answers
    FROM public.submission_tasks st
    JOIN public.job_distributions jd ON jd.id = st.distribution_id
    WHERE st.status IN ('submitted', 'failed')
      AND st.completed_at >= v_start AND st.completed_at < v_end
      AND jd.resolved_answers IS NOT NULL
  ),
  answers_unrolled AS (
    SELECT
      wt.id AS task_id,
      CASE
        WHEN (ans->>'tier') IS NOT NULL THEN (ans->>'tier')::int
        WHEN (ans->>'is_answered')::boolean = false THEN 0
        ELSE 1
      END AS tier
    FROM window_tasks wt,
    LATERAL jsonb_array_elements(wt.resolved_answers) ans
  ),
  task_tier_stats AS (
    SELECT
      task_id,
      count(*) FILTER (WHERE tier = 0) AS t0,
      count(*) FILTER (WHERE tier = 1) AS t1,
      count(*) FILTER (WHERE tier = 2) AS t2,
      count(*) FILTER (WHERE tier = 3) AS t3,
      count(*) FILTER (WHERE tier = 4) AS t4,
      count(*) FILTER (WHERE tier IN (1, 2, 3, 4)) AS answered_count
    FROM answers_unrolled
    GROUP BY task_id
  ),
  task_percentages AS (
    SELECT
      task_id,
      t0, t1, t2, t3, t4, answered_count,
      CASE WHEN answered_count > 0 THEN (t1::numeric / answered_count) * 100 ELSE NULL END AS p1,
      CASE WHEN answered_count > 0 THEN (t2::numeric / answered_count) * 100 ELSE NULL END AS p2,
      CASE WHEN answered_count > 0 THEN (t3::numeric / answered_count) * 100 ELSE NULL END AS p3,
      CASE WHEN answered_count > 0 THEN (t4::numeric / answered_count) * 100 ELSE NULL END AS p4
    FROM task_tier_stats
  ),
  aggregated_sources AS (
    SELECT
      COALESCE(sum(t0), 0) AS total_t0,
      COALESCE(sum(t1), 0) AS total_t1,
      COALESCE(sum(t2), 0) AS total_t2,
      COALESCE(sum(t3), 0) AS total_t3,
      COALESCE(sum(t4), 0) AS total_t4,
      COALESCE(sum(answered_count), 0) AS total_answered,
      count(*) FILTER (WHERE answered_count > 0) AS applications_included,
      round(avg(p1)::numeric, 2) AS avg_supabase_pct,
      round(avg(p2)::numeric, 2) AS avg_resume_pct,
      round(avg(p3)::numeric, 2) AS avg_crm_pct,
      round(avg(p4)::numeric, 2) AS avg_ai_pct
    FROM task_percentages
  )
  SELECT jsonb_build_object(
    'supabase_pct', avg_supabase_pct,
    'resume_pct', avg_resume_pct,
    'crm_pct', avg_crm_pct,
    'ai_pct', avg_ai_pct,
    'pooled', jsonb_build_object(
      'supabase_pct', CASE WHEN total_answered > 0 THEN round((total_t1::numeric / total_answered * 100), 2) ELSE NULL END,
      'resume_pct', CASE WHEN total_answered > 0 THEN round((total_t2::numeric / total_answered * 100), 2) ELSE NULL END,
      'crm_pct', CASE WHEN total_answered > 0 THEN round((total_t3::numeric / total_answered * 100), 2) ELSE NULL END,
      'ai_pct', CASE WHEN total_answered > 0 THEN round((total_t4::numeric / total_answered * 100), 2) ELSE NULL END
    ),
    'pooled_supabase_pct', CASE WHEN total_answered > 0 THEN round((total_t1::numeric / total_answered * 100), 2) ELSE NULL END,
    'pooled_resume_pct', CASE WHEN total_answered > 0 THEN round((total_t2::numeric / total_answered * 100), 2) ELSE NULL END,
    'pooled_crm_pct', CASE WHEN total_answered > 0 THEN round((total_t3::numeric / total_answered * 100), 2) ELSE NULL END,
    'pooled_ai_pct', CASE WHEN total_answered > 0 THEN round((total_t4::numeric / total_answered * 100), 2) ELSE NULL END,
    'unanswered_count', total_t0,
    'applications_included', applications_included
  )
  INTO v_sources
  FROM aggregated_sources;

  -- 5. Empty window fallback
  IF v_sources IS NULL OR (v_sources->>'applications_included')::int = 0 THEN
    v_sources := jsonb_build_object(
      'supabase_pct', NULL,
      'resume_pct', NULL,
      'crm_pct', NULL,
      'ai_pct', NULL,
      'pooled', jsonb_build_object(
        'supabase_pct', NULL,
        'resume_pct', NULL,
        'crm_pct', NULL,
        'ai_pct', NULL
      ),
      'pooled_supabase_pct', NULL,
      'pooled_resume_pct', NULL,
      'pooled_crm_pct', NULL,
      'pooled_ai_pct', NULL,
      'unanswered_count', 0,
      'applications_included', 0
    );
  END IF;

  RETURN jsonb_build_object(
    'submitted', v_submitted,
    'failed', v_failed,
    'running', v_running,
    'queued', v_queued,
    'ready_for_review', v_ready_for_review,
    'sources', v_sources,
    'window', jsonb_build_object(
      'range', lower(p_range),
      'date', p_date,
      'start_ist', v_start,
      'end_ist', v_end
    )
  );
END;
$$;
