-- ==============================================================================
-- Migration 040: Mutation Check (Proves Test Suite Can Fail)
-- ==============================================================================
-- Temporarily drops trigger inside the transaction.
-- Demonstrates that without the trigger, T1 fails with "T1 FAILED".
-- Rolls back immediately, keeping schema and data untouched.
-- ==============================================================================

BEGIN;

-- Intentionally drop the trigger to simulate an unprotected table
DROP TRIGGER IF EXISTS trg_submission_task_guard ON public.submission_tasks;

CREATE FUNCTION pg_temp.blocked(q text) RETURNS boolean
LANGUAGE plpgsql AS $f$
BEGIN
    EXECUTE q;
    RETURN false;              -- statement succeeded => NOT blocked
EXCEPTION WHEN OTHERS THEN
    RETURN true;               -- statement raised => blocked
END
$f$;

DO $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO public.submission_tasks (id, applywizz_id, job_url, company, role_title, status)
    VALUES (v_id, 'AWL-TEST-MUTATION', 'https://test.workday.com/job/mutation', 'Mutation Corp', 'Mutation Role', 'ready_for_review');

    -- T1 ready_for_review -> applying : MUST BE BLOCKED
    -- Since trigger was dropped, this statement will SUCCEED, blocked() returns false, and it will RAISE EXCEPTION 'T1 FAILED'!
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=%L$q$, v_id)) THEN
        RAISE EXCEPTION 'T1 FAILED: ready_for_review -> applying succeeded because trigger is missing!';
    END IF;

    RAISE EXCEPTION 'MUTATION CHECK FAILED: Should not reach here!';
END $$;

ROLLBACK;
