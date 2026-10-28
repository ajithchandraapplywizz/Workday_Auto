-- ==============================================================================
-- Migration 040: Transactional Test Suite (Runs inside a Transaction, Rolled Back)
-- ==============================================================================
-- Proves all 16 status guard rules using a temporary test row and boolean assert.
-- Automatically rolls back so zero test rows are retained.
-- ==============================================================================

BEGIN;

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
    v_actor TEXT;
    v_events INT;
BEGIN
    -- T0a: INSERT with privileged actor ('stop') must be immediately reset to 'system'
    INSERT INTO public.submission_tasks (id, applywizz_id, job_url, company, role_title, status, status_actor)
    VALUES (v_id, 'AWL-TEST-GUARD', 'https://test.workday.com/job/1', 'Test Corp', 'Test Role', 'ready_for_review', 'stop');
    SELECT status_actor INTO v_actor FROM public.submission_tasks WHERE id=v_id;
    IF v_actor <> 'system' THEN RAISE EXCEPTION 'T0a FAILED: status_actor on insert persisted as %', v_actor; END IF;
    RAISE NOTICE 'T0a PASSED privileged status_actor on INSERT reset to system';

    -- T0b: UPDATE without status change attempting to set privileged actor ('manual_repair') must be reset to 'system'
    UPDATE public.submission_tasks SET error_message='noop', status_actor='manual_repair' WHERE id=v_id;
    SELECT status_actor INTO v_actor FROM public.submission_tasks WHERE id=v_id;
    IF v_actor <> 'system' THEN RAISE EXCEPTION 'T0b FAILED: status_actor on non-status update persisted as %', v_actor; END IF;
    RAISE NOTICE 'T0b PASSED privileged status_actor on non-status UPDATE reset to system';

    -- T1 ready_for_review -> applying : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T1 FAILED'; END IF;
    RAISE NOTICE 'T1 PASSED ready_for_review -> applying blocked';

    -- T2 ready_for_review -> failed : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='failed', error_message='x' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T2 FAILED'; END IF;
    RAISE NOTICE 'T2 PASSED ready_for_review -> failed blocked';

    -- T3 ready_for_review -> queued : allowed
    UPDATE public.submission_tasks SET status='queued' WHERE id=v_id;
    RAISE NOTICE 'T3 PASSED ready_for_review -> queued allowed';

    -- T4 queued -> applying with NULL worker_id : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='applying', worker_id=NULL WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T4 FAILED'; END IF;
    RAISE NOTICE 'T4 PASSED queued -> applying without worker_id blocked';

    UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=v_id;

    -- T5 applying -> ready_for_review as normal actor : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='ready_for_review', status_actor='system' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T5 FAILED'; END IF;
    RAISE NOTICE 'T5 PASSED applying -> ready_for_review as system blocked';

    -- T6 applying -> failed with no screenshot and no flag : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='failed', error_message='boom' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T6 FAILED'; END IF;
    RAISE NOTICE 'T6 PASSED applying -> failed without screenshot blocked';

    -- T7 applying -> submitted with no screenshot : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='submitted' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T7 FAILED'; END IF;
    RAISE NOTICE 'T7 PASSED applying -> submitted without screenshot blocked';

    -- T8 applying -> ready_for_review with actor stop : allowed, and actor must NOT persist
    UPDATE public.submission_tasks SET status='ready_for_review', status_actor='stop' WHERE id=v_id;
    SELECT status_actor INTO v_actor FROM public.submission_tasks WHERE id=v_id;
    IF v_actor <> 'system' THEN RAISE EXCEPTION 'T8 FAILED: status_actor persisted as %', v_actor; END IF;
    RAISE NOTICE 'T8 PASSED stop allowed and actor reset to system';

    -- T9 applying -> failed with error + screenshot : allowed
    UPDATE public.submission_tasks SET status='queued' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='failed', error_message='simulated', application_submitted_screenshot_url='https://example.test/fail.png' WHERE id=v_id;
    RAISE NOTICE 'T9 PASSED applying -> failed with error+screenshot allowed';

    -- T10 failed -> ready_for_review as normal actor : blocked
    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='ready_for_review' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T10 FAILED'; END IF;
    RAISE NOTICE 'T10 PASSED failed -> ready_for_review as system blocked';

    -- T11 failed -> ready_for_review via app.actor session fallback : allowed
    PERFORM set_config('app.actor', 'manual_repair', true);
    UPDATE public.submission_tasks SET status='ready_for_review' WHERE id=v_id;
    PERFORM set_config('app.actor', '', true);
    RAISE NOTICE 'T11 PASSED manual_repair via app.actor fallback allowed';

    -- T12 applying -> failed with review_flag escape hatch : allowed
    UPDATE public.submission_tasks SET status='queued' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='failed', error_message='screenshot crashed', review_flag='screenshot_capture_failed' WHERE id=v_id;
    RAISE NOTICE 'T12 PASSED screenshot_capture_failed escape hatch allowed';

    -- T13 failed -> ready_for_review via status_actor column : allowed
    UPDATE public.submission_tasks SET status='ready_for_review', status_actor='manual_repair' WHERE id=v_id;
    RAISE NOTICE 'T13 PASSED manual_repair via status_actor column allowed';

    -- T14 applying -> submitted with screenshot : allowed; T15 submitted -> anything : blocked
    UPDATE public.submission_tasks SET status='queued' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='applying', worker_id='worker_1' WHERE id=v_id;
    UPDATE public.submission_tasks SET status='submitted', application_submitted_screenshot_url='https://example.test/ok.png' WHERE id=v_id;
    RAISE NOTICE 'T14 PASSED applying -> submitted with screenshot allowed';

    IF NOT pg_temp.blocked(format($q$UPDATE public.submission_tasks SET status='ready_for_review', status_actor='manual_repair' WHERE id=%L$q$, v_id)) THEN RAISE EXCEPTION 'T15 FAILED'; END IF;
    RAISE NOTICE 'T15 PASSED submitted is terminal, even for manual_repair';

    -- T16 audit trail exists for the successful transitions
    SELECT count(*) INTO v_events FROM public.submission_task_events WHERE task_id=v_id;
    IF v_events < 10 THEN RAISE EXCEPTION 'T16 FAILED: only % events logged', v_events; END IF;
    RAISE NOTICE 'T16 PASSED % audit events recorded', v_events;

    RAISE NOTICE 'ALL TESTS PASSED';
END $$;

ROLLBACK;
