-- ==============================================================================
-- Migration: 005_add_degree_classification.sql
-- Description: Add degree_classification jsonb column to public.clients
-- ==============================================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS degree_classification jsonb;
