-- ==============================================================================
-- SUPABASE MIGRATION: CA MANAGEMENT, OPERATIONAL MANAGERS & DASHBOARD DOMAINS
-- Run this script in your Supabase SQL Editor.
-- ==============================================================================

-- 1. Create Role Enum for the 4 Domains
DO $$ BEGIN
    CREATE TYPE public.user_domain_role AS ENUM (
        'developer',            -- Developer (you)
        'admin',                -- Founder & Co-founder
        'operational_manager',  -- Balaji & Op Manager 2
        'career_associate'      -- CA Team members
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;


-- 2. Team Members Table (Tracks Admins, Developers, Managers & CAs)
CREATE TABLE IF NOT EXISTS public.team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role public.user_domain_role NOT NULL DEFAULT 'career_associate',
    manager_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
    external_manager_id TEXT, -- e.g. 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744'
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pre-seed the 2 Operational Managers
INSERT INTO public.team_members (name, email, role, external_manager_id)
VALUES 
    ('Balaji', 'balaji@applywizz.com', 'operational_manager', 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744'),
    ('Operational Manager 2', 'ops2@applywizz.com', 'operational_manager', '9dc9376e-fbc5-440b-932f-38da10b89a70')
ON CONFLICT (email) DO UPDATE 
SET external_manager_id = EXCLUDED.external_manager_id,
    role = EXCLUDED.role;


-- 3. Enhance `clients` Table (Assigning Manager & CA to each client)
ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS ca_email TEXT,
ADD COLUMN IF NOT EXISTS career_associate_manager_id TEXT,
ADD COLUMN IF NOT EXISTS operational_manager_name TEXT,
ADD COLUMN IF NOT EXISTS raw_profile_json JSONB DEFAULT '{}'::jsonb;

-- Index clients table for instant dashboard filtering
CREATE INDEX IF NOT EXISTS idx_clients_ca_email ON public.clients (ca_email);
CREATE INDEX IF NOT EXISTS idx_clients_manager_id ON public.clients (career_associate_manager_id);


-- 4. Work History Table (Stores historical application logs from API 1)
-- API: https://applywizz-ca-management.vercel.app/api/ca/work-history
CREATE TABLE IF NOT EXISTS public.ca_work_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL,
    ca_email TEXT NOT NULL,
    career_associate_manager_id TEXT,
    job_url TEXT,
    company TEXT,
    role_title TEXT,
    status TEXT DEFAULT 'submitted',
    applied_date DATE NOT NULL DEFAULT CURRENT_DATE,
    raw_payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for lightning-fast queries across dates, CAs, and Managers
CREATE INDEX IF NOT EXISTS idx_work_history_ca_email ON public.ca_work_history (ca_email, applied_date DESC);
CREATE INDEX IF NOT EXISTS idx_work_history_manager_id ON public.ca_work_history (career_associate_manager_id, applied_date DESC);
CREATE INDEX IF NOT EXISTS idx_work_history_applywizz_id ON public.ca_work_history (applywizz_id);


-- 5. DASHBOARD VIEWS (Pre-built queries for all 4 Domains)

-- View A: Admin Domain (Founder & Co-founder Overview)
CREATE OR REPLACE VIEW public.dashboard_admin_overview AS
SELECT 
    COUNT(DISTINCT c.applywizz_id) AS total_clients,
    COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'submitted') AS bot_submitted,
    COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'pending') AS bot_pending,
    COUNT(DISTINCT w.id) AS manual_ca_applications,
    c.career_associate_manager_id,
    c.operational_manager_name
FROM public.clients c
LEFT JOIN public.batch_job_queue q ON q.applywizz_id = c.applywizz_id
LEFT JOIN public.ca_work_history w ON w.applywizz_id = c.applywizz_id
GROUP BY c.career_associate_manager_id, c.operational_manager_name;

-- View B: Operational Manager Domain (Filterable by Manager ID)
CREATE OR REPLACE VIEW public.dashboard_ops_manager_view AS
SELECT 
    c.career_associate_manager_id,
    c.operational_manager_name,
    c.ca_email,
    c.applywizz_id,
    c.client_name,
    c.company_email,
    COUNT(q.id) FILTER (WHERE q.status = 'submitted') AS auto_applied_count,
    COUNT(q.id) FILTER (WHERE q.status = 'pending') AS in_queue_count,
    COUNT(w.id) AS ca_work_history_count
FROM public.clients c
LEFT JOIN public.batch_job_queue q ON q.applywizz_id = c.applywizz_id
LEFT JOIN public.ca_work_history w ON w.applywizz_id = c.applywizz_id
GROUP BY c.career_associate_manager_id, c.operational_manager_name, c.ca_email, c.applywizz_id, c.client_name, c.company_email;

-- View C: CA Team Domain (Each CA sees only their clients & queue)
CREATE OR REPLACE VIEW public.dashboard_ca_team_view AS
SELECT 
    c.ca_email,
    c.applywizz_id,
    c.client_name,
    q.job_url,
    q.company,
    q.status AS queue_status,
    q.updated_at AS last_bot_activity
FROM public.clients c
JOIN public.batch_job_queue q ON q.applywizz_id = c.applywizz_id;
