-- ============================================================
-- Migration: Queue Daemon State Table
-- Purpose: Tracks per-CA daemon lifecycle so the background
--          queue watcher does not double-dispatch workers.
-- Run ONCE in Supabase SQL Editor.
-- ============================================================

-- 1. Table
CREATE TABLE IF NOT EXISTS public.queue_daemon_state (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ca_email         TEXT NOT NULL UNIQUE,
  ca_name          TEXT,
  state            TEXT NOT NULL DEFAULT ''detected''
                   CHECK (state IN (''detected'',''waiting_sync'',''synced'',''dispatched'',''draining'',''idle'')),
  synced_date      DATE,
  candidate_ids    TEXT[],
  workers_assigned INTEGER DEFAULT 0,
  tasks_dispatched INTEGER DEFAULT 0,
  tasks_completed  INTEGER DEFAULT 0,
  triggered_at     TIMESTAMPTZ,
  last_heartbeat   TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_queue_daemon_state_ca_email ON public.queue_daemon_state (ca_email);
CREATE INDEX IF NOT EXISTS idx_queue_daemon_state_state    ON public.queue_daemon_state (state);

-- 3. RLS
ALTER TABLE public.queue_daemon_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=''queue_daemon_state'' AND policyname=''daemon_service_role'') THEN
    CREATE POLICY "daemon_service_role" ON public.queue_daemon_state FOR ALL USING (true);
  END IF;
END $$;

-- 4. Live view
CREATE OR REPLACE VIEW public.v_daemon_live_status AS
SELECT d.ca_email, d.ca_name, d.state, d.synced_date,
       d.workers_assigned, d.tasks_dispatched, d.tasks_completed,
       d.triggered_at, d.last_heartbeat,
       ARRAY_LENGTH(d.candidate_ids,1) AS candidate_count,
       o.status AS operator_status, o.last_sign_in
FROM public.queue_daemon_state d
LEFT JOIN public.operators o ON o.email ILIKE d.ca_email
ORDER BY d.last_heartbeat DESC;

-- 5. Daily reset (call via pg_cron at midnight)
CREATE OR REPLACE FUNCTION public.reset_daemon_state_midnight()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.queue_daemon_state
  SET state=''idle'', tasks_dispatched=0, tasks_completed=0,
      workers_assigned=0, synced_date=NULL, triggered_at=NULL, updated_at=NOW()
  WHERE state IN (''dispatched'',''draining'',''idle'') AND synced_date < CURRENT_DATE;
END; $$;
