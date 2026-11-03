-- Migration 050: Ensure 8 Submitting Workers in worker_status and worker_control
-- Supports 2 services x 2 replicas x 2 workers = 8 submitting workers across cluster

-- 1. Ensure worker_status has entries for submitting_worker_1 through submitting_worker_8
INSERT INTO public.worker_status (worker_id, bot_name, stage, state, current_application_id)
VALUES 
    ('submitting_worker_1', 'Submitting Worker 1', 'submitting', 'idle', null),
    ('submitting_worker_2', 'Submitting Worker 2', 'submitting', 'idle', null),
    ('submitting_worker_3', 'Submitting Worker 3', 'submitting', 'idle', null),
    ('submitting_worker_4', 'Submitting Worker 4', 'submitting', 'idle', null),
    ('submitting_worker_5', 'Submitting Worker 5', 'submitting', 'idle', null),
    ('submitting_worker_6', 'Submitting Worker 6', 'submitting', 'idle', null),
    ('submitting_worker_7', 'Submitting Worker 7', 'submitting', 'idle', null),
    ('submitting_worker_8', 'Submitting Worker 8', 'submitting', 'idle', null)
ON CONFLICT (worker_id) DO UPDATE SET 
    bot_name = EXCLUDED.bot_name, 
    stage = EXCLUDED.stage, 
    state = 'idle', 
    current_application_id = null,
    updated_at = timezone('utc'::text, now());

-- 2. Ensure worker_control has entries for submitting_worker_1 through submitting_worker_8
INSERT INTO public.worker_control (worker_id, state, stage, updated_at)
VALUES
    ('submitting_worker_1', 'idle', 'submitting', now()),
    ('submitting_worker_2', 'idle', 'submitting', now()),
    ('submitting_worker_3', 'idle', 'submitting', now()),
    ('submitting_worker_4', 'idle', 'submitting', now()),
    ('submitting_worker_5', 'idle', 'submitting', now()),
    ('submitting_worker_6', 'idle', 'submitting', now()),
    ('submitting_worker_7', 'idle', 'submitting', now()),
    ('submitting_worker_8', 'idle', 'submitting', now())
ON CONFLICT (worker_id) DO NOTHING;

-- 3. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
