-- Migration 027: Dynamic Candidate Fully-Answered Counts View and RPC
-- Directly executes the requested query:
--   SELECT applywizz_id, COUNT(*) FILTER (WHERE is_fully_answered = TRUE) AS fully_answered_count
--   FROM job_distributions GROUP BY applywizz_id ORDER BY applywizz_id;

-- 1. Create View
CREATE OR REPLACE VIEW public.v_candidate_fully_answered_counts AS
SELECT
  applywizz_id,
  COUNT(*) FILTER (WHERE is_fully_answered = TRUE)::INT AS fully_answered_count,
  COUNT(*)::INT AS total_job_count
FROM public.job_distributions
GROUP BY applywizz_id
ORDER BY applywizz_id;

-- 2. Create RPC function for direct client RPC invocations
CREATE OR REPLACE FUNCTION public.get_candidate_fully_answered_counts()
RETURNS TABLE (
  applywizz_id TEXT,
  fully_answered_count INT,
  total_job_count INT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    applywizz_id,
    COUNT(*) FILTER (WHERE is_fully_answered = TRUE)::INT AS fully_answered_count,
    COUNT(*)::INT AS total_job_count
  FROM public.job_distributions
  GROUP BY applywizz_id
  ORDER BY applywizz_id;
$$;

-- 3. Grant access to public / anon / authenticated / service_role
GRANT SELECT ON public.v_candidate_fully_answered_counts TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_candidate_fully_answered_counts() TO anon, authenticated, service_role;
