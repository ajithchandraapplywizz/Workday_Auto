-- ==============================================================================
-- ADD DYNAMIC ZOHO MAIL STATUS TO CLIENTS TABLE
-- Purpose:
--   Tracks real-time Zoho mailbox connection and verification status in Supabase
--   for every candidate so it is never static.
-- ==============================================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS zoho_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS zoho_connected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS zoho_last_synced TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_clients_zoho_status ON public.clients (zoho_status);
CREATE INDEX IF NOT EXISTS idx_clients_company_email ON public.clients (company_email);
