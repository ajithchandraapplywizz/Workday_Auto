-- ==============================================================================
-- Migration: 002_performance_views_and_indexes.sql
-- Description: Indexes, deduplication guards, and analytics views for ApplyWizz
-- ==============================================================================

create extension if not exists pg_trgm;

-- Ensure columns exist on public.clients
alter table public.clients add column if not exists first_name text;
alter table public.clients add column if not exists last_name text;
alter table public.clients add column if not exists mobile_number text;
alter table public.clients add column if not exists company_email text;
alter table public.clients add column if not exists resume_url text;
alter table public.clients add column if not exists education text;
alter table public.clients add column if not exists university_or_school text;
alter table public.clients add column if not exists degree text;
alter table public.clients add column if not exists field_of_study text;
alter table public.clients add column if not exists graduation_year text;
alter table public.clients add column if not exists gpa text;
alter table public.clients add column if not exists skills jsonb not null default '[]'::jsonb;
alter table public.clients add column if not exists latest_company text;
alter table public.clients add column if not exists latest_job_title text;
alter table public.clients add column if not exists latest_job_location text;
alter table public.clients add column if not exists currently_working boolean;
alter table public.clients add column if not exists work_from text;
alter table public.clients add column if not exists work_to text;

-- Trigram and client lookup indexes
create index if not exists client_questions_question_trgm_idx
  on public.client_questions using gin (question_normalized gin_trgm_ops);
create index if not exists client_questions_awl_idx
  on public.client_questions (applywizz_id, updated_at desc);

-- Application uniqueness guarantee
create unique index if not exists applications_client_job_uidx
  on public.applications (applywizz_id, job_url);
