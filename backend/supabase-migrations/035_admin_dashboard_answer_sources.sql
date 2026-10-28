-- Migration 035: Service-role only aggregate function for answer sources
-- Computes answer-level percentages (supabase, resume, api, ai) from job_distributions.resolved_answers

CREATE OR REPLACE FUNCTION public.get_answer_sources_breakdown(p_range text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_supabase bigint := 0;
  v_resume bigint := 0;
  v_api bigint := 0;
  v_ai bigint := 0;
  v_total bigint := 0;
BEGIN
  WITH elements AS (
    SELECT
      elem->>'raw_source' AS raw_source,
      elem->>'source' AS source_label,
      (elem->>'tier')::int AS tier,
      COALESCE((elem->>'is_answered')::boolean, false) AS is_answered
    FROM public.job_distributions jd,
         LATERAL jsonb_array_elements(jd.resolved_answers) AS elem
    WHERE jd.resolved_answers IS NOT NULL
      AND jsonb_typeof(jd.resolved_answers) = 'array'
      AND (
        p_range = 'all' OR
        (p_range = 'today' AND jd.updated_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date) OR
        (p_range = '7d' AND jd.updated_at >= now() - interval '7 days') OR
        (p_range = '30d' AND jd.updated_at >= now() - interval '30 days')
      )
  ),
  filtered AS (
    SELECT
      COALESCE(
        LOWER(raw_source),
        CASE
          WHEN tier = 1 THEN 'supabase'
          WHEN tier = 2 THEN 'resume'
          WHEN tier = 3 THEN 'api'
          WHEN tier = 4 THEN 'ai'
          WHEN source_label ILIKE '%supabase%' OR source_label ILIKE '%db%' THEN 'supabase'
          WHEN source_label ILIKE '%resume%' THEN 'resume'
          WHEN source_label ILIKE '%crm%' OR source_label ILIKE '%api%' THEN 'api'
          WHEN source_label ILIKE '%ai%' OR source_label ILIKE '%claude%' THEN 'ai'
          ELSE 'ai'
        END
      ) AS normalized_source
    FROM elements
    WHERE is_answered = true
  )
  SELECT
    COUNT(*) FILTER (WHERE normalized_source = 'supabase'),
    COUNT(*) FILTER (WHERE normalized_source = 'resume'),
    COUNT(*) FILTER (WHERE normalized_source = 'api'),
    COUNT(*) FILTER (WHERE normalized_source = 'ai'),
    COUNT(*)
  INTO v_supabase, v_resume, v_api, v_ai, v_total
  FROM filtered;

  IF v_total = 0 OR v_total IS NULL THEN
    RETURN jsonb_build_object(
      'total', 0,
      'supabase_count', 0,
      'resume_count', 0,
      'api_count', 0,
      'ai_count', 0,
      'supabase_pct', null,
      'resume_pct', null,
      'api_pct', null,
      'ai_pct', null
    );
  END IF;

  RETURN jsonb_build_object(
    'total', v_total,
    'supabase_count', v_supabase,
    'resume_count', v_resume,
    'api_count', v_api,
    'ai_count', v_ai,
    'supabase_pct', ROUND((v_supabase::numeric / v_total::numeric) * 100),
    'resume_pct', ROUND((v_resume::numeric / v_total::numeric) * 100),
    'api_pct', ROUND((v_api::numeric / v_total::numeric) * 100),
    'ai_pct', ROUND((v_ai::numeric / v_total::numeric) * 100)
  );
END;
$$;

-- Revoke public execution, grant EXECUTE to service_role only
REVOKE EXECUTE ON FUNCTION public.get_answer_sources_breakdown(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_answer_sources_breakdown(text) TO service_role;
