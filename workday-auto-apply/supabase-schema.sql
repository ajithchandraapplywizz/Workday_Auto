-- ApplyWizz multi-user answer memory for Supabase.
-- Run once in Supabase SQL Editor.
create extension if not exists pg_trgm;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  applywizz_id text unique not null,
  client_name text,
  first_name text,
  last_name text,
  mobile_number text,
  company_email text,
  resume_url text,
  education text,
  university_or_school text,
  degree text,
  field_of_study text,
  graduation_year text,
  gpa text,
  skills jsonb not null default '[]'::jsonb,
  latest_company text,
  latest_job_title text,
  latest_job_location text,
  currently_working boolean,
  work_from text,
  work_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_questions (
  id uuid primary key default gen_random_uuid(),
  applywizz_id text not null references public.clients(applywizz_id) on delete cascade,
  question_raw text not null,
  question_normalized text not null,
  answer text not null,
  answer_source text not null default 'ai' check (answer_source in ('profile', 'resume', 'api', 'ai', 'database', 'default')),
  confidence_score numeric(3,2) not null default 0.70 check (confidence_score >= 0 and confidence_score <= 1),
  field_type text,
  options jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (applywizz_id, question_normalized)
);

create index if not exists client_questions_question_trgm_idx
  on public.client_questions using gin (question_normalized gin_trgm_ops);
create index if not exists client_questions_awl_idx
  on public.client_questions (applywizz_id, updated_at desc);

alter table public.clients enable row level security;
alter table public.client_questions enable row level security;

-- The Node worker uses the service-role key, which bypasses RLS.
-- No anon policies are created because the service-role key must never reach a browser.

comment on table public.client_questions is
  'One deduplicated row per Apply Wizz client question. question_normalized is the semantic lookup key; question_raw preserves the complete prompt.';

-- Required per new AWL client: one clients row, client_questions rows, and one applications row per job.

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  applywizz_id text not null references public.clients(applywizz_id) on delete cascade,
  job_url text not null,
  company text,
  role_title text,
  status text not null default 'started' check (status in ('started', 'in_progress', 'submitted', 'failed', 'skipped')),
  failure_reason text,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (applywizz_id, job_url)
);

-- Idempotent upgrades for databases where applications already existed.
alter table public.applications add column if not exists company text;
alter table public.applications add column if not exists role_title text;
alter table public.applications add column if not exists status text not null default 'started';
alter table public.applications add column if not exists failure_reason text;
alter table public.applications add column if not exists started_at timestamptz not null default now();
alter table public.applications add column if not exists submitted_at timestamptz;
alter table public.applications add column if not exists updated_at timestamptz not null default now();

-- Remove duplicate legacy rows before adding the REST upsert conflict target.
delete from public.applications older
using public.applications newer
where older.applywizz_id = newer.applywizz_id
  and older.job_url = newer.job_url
  and older.id < newer.id;

alter table public.applications
  drop constraint if exists applications_applywizz_id_job_url_key;
alter table public.applications
  add constraint applications_applywizz_id_job_url_key unique (applywizz_id, job_url);

create unique index if not exists applications_client_job_uidx
  on public.applications (applywizz_id, job_url);

create index if not exists applications_awl_idx
  on public.applications (applywizz_id, started_at desc);

alter table public.applications enable row level security;

create or replace function public.set_applications_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists applications_updated_at on public.applications;
create trigger applications_updated_at
before update on public.applications
for each row execute function public.set_applications_updated_at();
