-- Migration 047: Add submitting_worker_4 to worker_status and relax worker_id constraint
-- Enables 4 concurrent submitting workers across multi-service deployments

-- 1. Drop existing restrictive worker_id constraints
ALTER TABLE public.worker_status 
    DROP CONSTRAINT IF EXISTS worker_id_strict_3,
    DROP CONSTRAINT IF EXISTS worker_id_strict_9,
    DROP CONSTRAINT IF EXISTS worker_id_strict_10;

-- 2. Ensure row for submitting_worker_4 exists
INSERT INTO public.worker_status (worker_id, bot_name, stage, state, current_application_id)
VALUES 
    ('submitting_worker_4', 'Submitting Worker 4', 'submitting', 'idle', null)
ON CONFLICT (worker_id) DO UPDATE SET 
    bot_name = EXCLUDED.bot_name, 
    stage = EXCLUDED.stage, 
    state = 'idle', 
    current_application_id = null,
    updated_at = timezone('utc'::text, now());

-- 3. Add permissive check constraint supporting canonical worker names
ALTER TABLE public.worker_status 
    ADD CONSTRAINT worker_id_canonical CHECK (
        worker_id ~ '^(scanning|resolving|submitting)_worker_\d+$'
    );
