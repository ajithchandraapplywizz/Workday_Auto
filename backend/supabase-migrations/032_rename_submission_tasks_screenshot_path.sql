-- ==============================================================================
-- Migration: 032_rename_submission_tasks_screenshot_path.sql
-- Description:
--   1. Drops the redundant application_submitted_screenshot_url column in submission_tasks.
--   2. Renames screenshot_path to application_submitted_screenshot_url in submission_tasks
--      (preserving all existing historical screenshot URLs).
--   3. Updates submission_tasks_status_check constraint to permit 'already_applied'.
--   4. Updates historical row(s) to 'already_applied'.
--   5. Reloads the PostgREST schema cache.
-- ==============================================================================

-- Step 1: Drop the extra application_submitted_screenshot_url column in submission_tasks
ALTER TABLE public.submission_tasks 
DROP COLUMN IF EXISTS application_submitted_screenshot_url;

-- Step 2: Rename screenshot_path to application_submitted_screenshot_url in submission_tasks
-- Preserves the original column and all existing historical screenshot links!
ALTER TABLE public.submission_tasks 
RENAME COLUMN screenshot_path TO application_submitted_screenshot_url;

-- Step 3: Update submission_tasks status check constraint to include 'already_applied'
ALTER TABLE public.submission_tasks 
DROP CONSTRAINT IF EXISTS submission_tasks_status_check;

ALTER TABLE public.submission_tasks 
ADD CONSTRAINT submission_tasks_status_check 
CHECK (status IN ('ready_for_review', 'queued', 'applying', 'submitted', 'failed', 'already_applied'));

-- Step 4: Patch existing records where application was already submitted
UPDATE public.submission_tasks
SET 
  status = 'already_applied',
  error_message = 'The application is already submitted',
  updated_at = NOW()
WHERE id = 'ea8ae509-44e0-47b6-8fd7-b7f2ed5d2bd2'
   OR (error_message = 'Submission ended with status: auth_failed' AND (application_submitted_screenshot_url ILIKE '%gateway_fail%' OR application_submitted_screenshot_url ILIKE '%applied%'));

UPDATE public.job_distributions
SET 
  status = 'already_applied',
  error_message = 'The application is already submitted',
  updated_at = NOW()
WHERE id = '8ad1e214-8387-4c51-bd32-bb7ab304a272';

-- Step 5: Reload PostgREST schema cache to ensure instant API reflection
NOTIFY pgrst, 'reload schema';
