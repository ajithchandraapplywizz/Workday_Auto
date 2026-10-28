-- Migration: 044_add_scan_run_id_to_scanned_jobs.sql
-- Description: Add scan_run_id column to scanned_jobs table for execution tracking.

ALTER TABLE public.scanned_jobs ADD COLUMN IF NOT EXISTS scan_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_scanned_jobs_scan_run_id ON public.scanned_jobs(scan_run_id);
