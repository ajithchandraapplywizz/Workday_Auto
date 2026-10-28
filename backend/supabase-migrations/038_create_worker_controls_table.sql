-- ==============================================================================
-- Migration 038: Phase 6 — Additive worker_controls table for Scan & Submit toggles
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.worker_controls (
    key TEXT PRIMARY KEY,             -- 'scan' | 'submit'
    enabled BOOLEAN NOT NULL DEFAULT false,
    stop_requested BOOLEAN NOT NULL DEFAULT false,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.worker_controls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_worker_controls" ON public.worker_controls;
CREATE POLICY "service_role_all_worker_controls" ON public.worker_controls 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_read_worker_controls" ON public.worker_controls;
CREATE POLICY "allow_read_worker_controls" ON public.worker_controls 
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow_update_worker_controls" ON public.worker_controls;
CREATE POLICY "allow_update_worker_controls" ON public.worker_controls 
    FOR ALL USING (true) WITH CHECK (true);

-- Seed initial control flags
INSERT INTO public.worker_controls (key, enabled, stop_requested, updated_by, updated_at)
VALUES 
    ('scan', false, false, 'system', timezone('utc'::text, now())),
    ('submit', false, false, 'system', timezone('utc'::text, now()))
ON CONFLICT (key) DO NOTHING;
