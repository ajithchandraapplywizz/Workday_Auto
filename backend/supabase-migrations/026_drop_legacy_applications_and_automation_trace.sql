-- Migration 026: Drop legacy unused tables (applications, automation_trace)
-- All operations and proof screenshots are 100% consolidated into job_distributions.

-- 1. Drop automation_trace (legacy debug log stream)
DROP TABLE IF EXISTS public.automation_trace CASCADE;

-- 2. Drop applications (legacy Phase 1 duplicate table)
DROP TABLE IF EXISTS public.applications CASCADE;
