-- Step 1: Add degree_classification jsonb column to public.clients
-- Additive only: No existing columns or data are modified.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS degree_classification jsonb;
