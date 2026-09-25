# Database & Supabase Migrations

This directory contains the sequential SQL migrations and schema definitions for the ApplyWizz Workday automation platform.

## Migration Sequence

| File | Purpose | Key Tables / Additions |
| :--- | :--- | :--- |
| `001_initial_schema.sql` | Core system schema | `clients`, `client_questions`, `applications`, Trigram indexes |
| `002_performance_views_and_indexes.sql` | Performance tuning & constraints | GIN indexes, Unique constraints |
| `003_client_facts_table.sql` | Fast profile cache | `client_facts` (additive facts store) |
| `004_job_form_schemas_and_queue.sql` | Form caching & worker queue | `job_form_schemas`, `batch_job_queue` |
| `005_add_degree_classification.sql` | Degree normalization | `clients.degree_classification` JSONB |
| `006_add_pre_resolved_answers_to_queue.sql` | Bulk pre-resolution | `batch_job_queue.pre_resolved_answers` JSONB |

## How to Apply

1. Log into your [Supabase Dashboard](https://supabase.com/dashboard).
2. Navigate to your project -> **SQL Editor**.
3. Run each script in numeric sequence (`001` through `006`).
4. All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and safe to re-run.
