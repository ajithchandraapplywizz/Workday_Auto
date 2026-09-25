-- ==============================================================================
-- Migration: 003_client_facts_table.sql
-- Description: Client facts table for fast, high-confidence field lookups
-- ==============================================================================

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

CREATE INDEX IF NOT EXISTS idx_client_facts_candidate_intent 
    ON public.client_facts (candidate_id, intent_key);

-- Enable RLS
ALTER TABLE public.client_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users" ON public.client_facts FOR SELECT USING (true);
