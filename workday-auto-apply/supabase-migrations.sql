-- ApplyWizz -> three-table migration.
-- Run in Supabase SQL Editor. Existing tables are copied and verified before removal.

create extension if not exists pg_trgm;

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

-- Move legacy one-question rows without deleting them yet.
do $$
begin
  if to_regclass('public.client_answers') is not null then
    insert into public.client_questions
      (applywizz_id, question_raw, question_normalized, answer, answer_source, field_type, options, created_at, updated_at)
    select applywizz_id,
           coalesce(question_raw, question_normalized),
           question_normalized,
           answer,
           case when source in ('profile', 'resume', 'api', 'ai', 'database', 'default') then source else 'ai' end,
           field_type,
           coalesce(options, '[]'::jsonb),
           created_at,
           updated_at
    from public.client_answers
    on conflict (applywizz_id, question_normalized) do update
      set question_raw = excluded.question_raw,
          answer = excluded.answer,
          answer_source = excluded.answer_source,
          field_type = excluded.field_type,
          options = excluded.options,
          updated_at = excluded.updated_at;
  end if;
end;
$$;

-- Move the prior JSON/profile store when present, including its named columns.
do $$
begin
  if to_regclass('public.client_answer_profiles') is not null then
    insert into public.client_questions (applywizz_id, question_raw, question_normalized, answer, answer_source, created_at, updated_at)
    select p.applywizz_id, item.key, item.key, item.value, 'database', now(), now()
    from public.client_answer_profiles p
    cross join lateral jsonb_each_text(
      coalesce(p.answers, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'how did you hear about us', p.how_did_you_hear_about_us,
        'school or university', p.school_or_university,
        'degree', p.degree,
        'field of study', p.field_of_study,
        'gpa', p.gpa,
        'graduation year', p.graduation_year,
        'years of experience', p.years_of_experience,
        'desired salary', p.desired_salary,
        'available to start', p.available_to_start,
        'visa sponsorship', to_jsonb(p)->>'visa_sponsorship',
        'work authorization', to_jsonb(p)->>'work_authorization'
      ))
    ) item(key, value)
    where item.value is not null and item.value <> ''
    on conflict (applywizz_id, question_normalized) do nothing;
  end if;
end;
$$;

-- Project cached resume facts into clients before removing client_resumes.
do $$
begin
  update public.clients c
  set first_name = coalesce(c.first_name, nullif(regexp_replace(c.client_name, '\s+[^\s]+\s*$', ''), '')),
      last_name = coalesce(c.last_name, nullif(substring(c.client_name from '(\S+)\s*$'), '')),
      mobile_number = coalesce(c.mobile_number, to_jsonb(c)->'client_payload'->'additional_information'->>'primary_phone'),
      company_email = coalesce(c.company_email, to_jsonb(c)->'client_payload'->'client'->>'company_email'),
      resume_url = coalesce(c.resume_url, to_jsonb(c)->'client_payload'->'additional_information'->>'resume_url'),
      degree = coalesce(c.degree, to_jsonb(c)->'client_payload'->'additional_information'->>'highest_education'),
      university_or_school = coalesce(c.university_or_school, to_jsonb(c)->'client_payload'->'additional_information'->>'university_name'),
      field_of_study = coalesce(c.field_of_study, to_jsonb(c)->'client_payload'->'additional_information'->>'main_subject'),
      graduation_year = coalesce(c.graduation_year, to_jsonb(c)->'client_payload'->'additional_information'->>'graduation_year'),
      gpa = coalesce(c.gpa, to_jsonb(c)->'client_payload'->'additional_information'->>'cumulative_gpa'),
      skills = case when c.skills = '[]'::jsonb then coalesce(to_jsonb(c)->'client_payload'->'additional_information'->'skills', '[]'::jsonb) else c.skills end,
      latest_job_title = coalesce(c.latest_job_title, to_jsonb(c)->'client_payload'->'additional_information'->>'role'),
      currently_working = coalesce(c.currently_working, case when lower(to_jsonb(c)->'client_payload'->'additional_information'->>'currently_working') in ('true', 'false') then (to_jsonb(c)->'client_payload'->'additional_information'->>'currently_working')::boolean end),
      work_from = coalesce(c.work_from, to_jsonb(c)->'client_payload'->'additional_information'->>'from_date'),
      work_to = case when coalesce(c.currently_working, case when lower(to_jsonb(c)->'client_payload'->'additional_information'->>'currently_working') in ('true', 'false') then (to_jsonb(c)->'client_payload'->'additional_information'->>'currently_working')::boolean end) then null else c.work_to end
  where c.client_name is not null;

  if to_regclass('public.client_resumes') is not null then
    update public.clients c
    set resume_url = coalesce(c.resume_url, r.resume_url),
        degree = coalesce(c.degree, r.parsed_profile -> 'education' ->> 'degree'),
        university_or_school = coalesce(c.university_or_school, r.parsed_profile -> 'education' ->> 'university'),
        field_of_study = coalesce(c.field_of_study, r.parsed_profile -> 'education' ->> 'major'),
        graduation_year = coalesce(c.graduation_year, r.parsed_profile -> 'education' ->> 'to_year'),
        gpa = coalesce(c.gpa, r.parsed_profile -> 'education' ->> 'gpa'),
        skills = case when c.skills = '[]'::jsonb then coalesce(r.parsed_profile -> 'skills', '[]'::jsonb) else c.skills end,
        latest_company = coalesce(c.latest_company, r.parsed_profile -> 'experience' ->> 'current_company'),
        latest_job_title = coalesce(c.latest_job_title, r.parsed_profile -> 'experience' ->> 'current_title'),
        latest_job_location = coalesce(c.latest_job_location, r.parsed_profile -> 'experience' ->> 'location'),
        currently_working = coalesce(c.currently_working, case when lower(r.parsed_profile -> 'experience' ->> 'currently_working') in ('true', 'false') then (r.parsed_profile -> 'experience' ->> 'currently_working')::boolean end),
        work_from = coalesce(c.work_from, r.parsed_profile -> 'experience' ->> 'from_date'),
        work_to = case when coalesce(c.currently_working, case when lower(r.parsed_profile -> 'experience' ->> 'currently_working') in ('true', 'false') then (r.parsed_profile -> 'experience' ->> 'currently_working')::boolean end) then null else coalesce(c.work_to, r.parsed_profile -> 'experience' ->> 'to_date') end,
        updated_at = now()
    from public.client_resumes r
    where c.applywizz_id = r.applywizz_id;
  end if;
end;
$$;

-- Verification gate: aborts before drops if any legacy answer row was not copied.
do $$
declare missing_count bigint;
begin
  if to_regclass('public.client_answers') is not null then
    select count(*) into missing_count
    from public.client_answers old
    where not exists (
      select 1 from public.client_questions new
      where new.applywizz_id = old.applywizz_id
        and new.question_normalized = old.question_normalized
    );
    if missing_count > 0 then
      raise exception 'Migration verification failed: % client_answers rows were not copied', missing_count;
    end if;
  end if;
end;
$$;

alter table public.clients enable row level security;
alter table public.client_questions enable row level security;
alter table public.clients drop column if exists client_payload;

-- Only reached after verification above.
drop table if exists public.client_answers;
drop table if exists public.client_answer_profiles;
drop table if exists public.client_resumes;

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

create index if not exists applications_awl_idx on public.applications (applywizz_id, started_at desc);
alter table public.applications enable row level security;
