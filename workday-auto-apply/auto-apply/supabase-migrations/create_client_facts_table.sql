-- Migration: Create client_facts table for ApplyWizz Resolution Architecture
-- Adheres to Phase 1: STRICTLY ADDITIVE.

CREATE TABLE IF NOT EXISTS public.client_facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id TEXT NOT NULL,
    intent_key TEXT NOT NULL,
    value JSONB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('supabase', 'crm', 'resume')),
    evidence_text TEXT,
    confidence NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(candidate_id, intent_key)
);

-- Enable RLS
ALTER TABLE public.client_facts ENABLE ROW LEVEL SECURITY;

-- Optional: Create basic RLS policies if needed
-- For this batch script, service_role key will bypass RLS.
CREATE POLICY "Enable read access for all users" ON public.client_facts FOR SELECT USING (true);
