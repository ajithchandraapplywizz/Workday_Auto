-- Migration 048: Ensure all bot_control columns exist and RLS is fully permissive
ALTER TABLE public.bot_control
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS submit_status TEXT NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS scan_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submit_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS scan_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submit_stop_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS daemon_instance_id TEXT,
    ADD COLUMN IF NOT EXISTS daemon_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scan_run_id TEXT,
    ADD COLUMN IF NOT EXISTS scan_run_started_at TIMESTAMPTZ;

-- Ensure primary row exists
INSERT INTO public.bot_control (
    id, stage, mode, is_running, is_paused, stop_requested, trigger_requested, active_worker_count, updated_at
)
VALUES (
    'primary', 'idle', 'idle', false, false, false, false, 0, timezone('utc'::text, now())
)
ON CONFLICT (id) DO NOTHING;

-- Ensure permissive RLS
ALTER TABLE public.bot_control ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_bot_control" ON public.bot_control;
CREATE POLICY "allow_all_bot_control" ON public.bot_control FOR ALL USING (true) WITH CHECK (true);
