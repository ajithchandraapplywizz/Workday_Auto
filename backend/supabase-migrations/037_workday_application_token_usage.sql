-- ==============================================================================
-- Migration: 037_workday_application_token_usage.sql
-- Description: Creates table for tracking Workday LLM token usage and cost
--              per application, per candidate, per date.
-- Execute in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/rltnrnqqmufeeqaodsif/sql
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.workday_application_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  role TEXT NOT NULL,
  application_id UUID,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_cost NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workday_application_token_usage UNIQUE (applywizz_id, job_url, date)
);

-- Indexes for lightning fast lookups
CREATE INDEX IF NOT EXISTS idx_workday_token_usage_applywizz
  ON public.workday_application_token_usage (applywizz_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_date
  ON public.workday_application_token_usage (date DESC);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_application_id
  ON public.workday_application_token_usage (application_id);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_job_url
  ON public.workday_application_token_usage (job_url);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_model
  ON public.workday_application_token_usage (model);

-- Enable RLS & Policies
ALTER TABLE public.workday_application_token_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow service_role access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated read access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow authenticated read access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow anon read access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow anon read access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR SELECT TO anon USING (true);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_workday_token_usage_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workday_token_usage_updated_at ON public.workday_application_token_usage;
CREATE TRIGGER trg_workday_token_usage_updated_at
BEFORE UPDATE ON public.workday_application_token_usage
FOR EACH ROW EXECUTE FUNCTION public.set_workday_token_usage_updated_at();

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
