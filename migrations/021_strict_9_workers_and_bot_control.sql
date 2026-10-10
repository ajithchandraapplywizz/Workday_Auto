-- ==============================================================================
-- Migration: 021_strict_9_workers_and_bot_control.sql
-- Description:
--   1. Creates bot_control table for global pipeline state and stop signals.
--   2. Adds bot_name and stage columns to worker_status.
--   3. Purges all legacy and rogue rows (bot_controller, bot_stop_flag, Worker-1-Lead, etc.).
--   4. Seeds strictly 9 canonical worker rows:
--        - Scanning (3): scanning_worker_1, scanning_worker_2, scanning_worker_3
--        - Resolving (3): resolving_worker_1, resolving_worker_2, resolving_worker_3
--        - Submitting (3): submitting_worker_1, submitting_worker_2, submitting_worker_3
--   5. Adds strict CHECK constraint to permanently reject extra rows.
-- ==============================================================================

-- 1. Create bot_control table
CREATE TABLE IF NOT EXISTS public.bot_control (
    id TEXT PRIMARY KEY DEFAULT 'primary',
    stage TEXT NOT NULL DEFAULT 'idle',
    is_running BOOLEAN NOT NULL DEFAULT false,
    is_paused BOOLEAN NOT NULL DEFAULT false,
    stop_requested BOOLEAN NOT NULL DEFAULT false,
    trigger_requested BOOLEAN NOT NULL DEFAULT false,
    active_worker_count INTEGER NOT NULL DEFAULT 0,
    current_action TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.bot_control ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all_bot_control" ON public.bot_control;
CREATE POLICY "service_role_all_bot_control" ON public.bot_control FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_read_bot_control" ON public.bot_control;
CREATE POLICY "allow_read_bot_control" ON public.bot_control FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_anon_update_bot_control" ON public.bot_control;
CREATE POLICY "allow_anon_update_bot_control" ON public.bot_control FOR ALL USING (true) WITH CHECK (true);

INSERT INTO public.bot_control (id, stage, is_running, is_paused, stop_requested, trigger_requested, active_worker_count)
VALUES ('primary', 'idle', false, false, false, false, 0)
ON CONFLICT (id) DO UPDATE SET
    stage = 'idle',
    is_running = false,
    is_paused = false,
    stop_requested = false,
    trigger_requested = false,
    active_worker_count = 0,
    updated_at = timezone('utc'::text, now());

-- 2. Add columns to worker_status
ALTER TABLE public.worker_status 
    ADD COLUMN IF NOT EXISTS bot_name TEXT,
    ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'idle';

-- 3. Drop existing constraint if any before cleaning
ALTER TABLE public.worker_status 
    DROP CONSTRAINT IF EXISTS worker_id_strict_3,
    DROP CONSTRAINT IF EXISTS worker_id_strict_9;

-- 4. Purge all non-canonical rows
DELETE FROM public.worker_status 
WHERE worker_id NOT IN (
    'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
    'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3',
    'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'
);

-- 5. Seed strictly the 9 rows
INSERT INTO public.worker_status (worker_id, bot_name, stage, state, current_application_id)
VALUES 
    ('scanning_worker_1', 'Scanning Worker 1', 'scanning', 'idle', null),
    ('scanning_worker_2', 'Scanning Worker 2', 'scanning', 'idle', null),
    ('scanning_worker_3', 'Scanning Worker 3', 'scanning', 'idle', null),
    ('resolving_worker_1', 'Resolving Worker 1', 'resolving', 'idle', null),
    ('resolving_worker_2', 'Resolving Worker 2', 'resolving', 'idle', null),
    ('resolving_worker_3', 'Resolving Worker 3', 'resolving', 'idle', null),
    ('submitting_worker_1', 'Submitting Worker 1', 'submitting', 'idle', null),
    ('submitting_worker_2', 'Submitting Worker 2', 'submitting', 'idle', null),
    ('submitting_worker_3', 'Submitting Worker 3', 'submitting', 'idle', null)
ON CONFLICT (worker_id) DO UPDATE SET 
    bot_name = EXCLUDED.bot_name, 
    stage = EXCLUDED.stage, 
    state = 'idle', 
    current_application_id = null,
    updated_at = timezone('utc'::text, now());

-- 6. Add hard CHECK constraint
ALTER TABLE public.worker_status 
    ADD CONSTRAINT worker_id_strict_9 CHECK (
        worker_id IN (
            'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
            'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3',
            'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'
        )
    );

-- 7. Notify PostgREST schema cache
NOTIFY pgrst, 'reload schema';
