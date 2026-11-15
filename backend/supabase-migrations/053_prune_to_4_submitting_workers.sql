-- precheck:allow-destructive
-- Migration 053: Prune Obsolete Submitting Workers to Strictly 4 Workers
-- Enforces 2 services x 2 workers = 4 submitting workers across cluster

DELETE FROM public.worker_status 
WHERE worker_id IN ('submitting_worker_5', 'submitting_worker_6', 'submitting_worker_7', 'submitting_worker_8');

DELETE FROM public.worker_control 
WHERE worker_id IN ('submitting_worker_5', 'submitting_worker_6', 'submitting_worker_7', 'submitting_worker_8');

NOTIFY pgrst, 'reload schema';
