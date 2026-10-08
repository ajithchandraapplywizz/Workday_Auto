BEGIN;

ALTER TABLE public.scanned_jobs
  ADD COLUMN IF NOT EXISTS canonical_url TEXT,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS failure_screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS review_screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS dom_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE public.scanned_jobs
SET canonical_url = job_url
WHERE canonical_url IS NULL;
UPDATE public.scanned_jobs SET status = 'pending' WHERE status IS NULL;
ALTER TABLE public.scanned_jobs
  ALTER COLUMN canonical_url SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.scanned_jobs'::regclass AND conname = 'scanned_jobs_status_pipeline_check') THEN
    ALTER TABLE public.scanned_jobs ADD CONSTRAINT scanned_jobs_status_pipeline_check
      CHECK (status IN ('pending','scanning','scanned','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.scanned_jobs'::regclass AND conname = 'uq_scanned_jobs_canonical_url') THEN
    ALTER TABLE public.scanned_jobs ADD CONSTRAINT uq_scanned_jobs_canonical_url UNIQUE (canonical_url);
  END IF;
END $$;

ALTER TABLE public.job_distributions
  ADD COLUMN IF NOT EXISTS canonical_url TEXT,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS failure_screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS submission_screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS ready_for_review BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS unresolved_fields JSONB,
  ADD COLUMN IF NOT EXISTS dom_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

UPDATE public.job_distributions
SET canonical_url = job_url
WHERE canonical_url IS NULL;
UPDATE public.job_distributions SET status = 'pending' WHERE status IS NULL;
ALTER TABLE public.job_distributions
  ALTER COLUMN canonical_url SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_distributions'::regclass AND conname = 'job_distributions_status_pipeline_check') THEN
    ALTER TABLE public.job_distributions ADD CONSTRAINT job_distributions_status_pipeline_check
      CHECK (status IN ('pending','resolving','resolved','queued_for_submission','applying','submitted','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_distributions'::regclass AND conname = 'uq_client_canonical_url') THEN
    ALTER TABLE public.job_distributions ADD CONSTRAINT uq_client_canonical_url UNIQUE (applywizz_id, canonical_url);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scanned_jobs_stale
  ON public.scanned_jobs (status, lease_expires_at)
  WHERE status = 'scanning';
CREATE INDEX IF NOT EXISTS idx_job_distributions_stale
  ON public.job_distributions (status, lease_expires_at)
  WHERE status IN ('resolving', 'applying');

NOTIFY pgrst, 'reload schema';
COMMIT;
