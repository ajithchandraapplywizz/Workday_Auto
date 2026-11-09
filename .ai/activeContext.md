# Active Context: Workday Auto

## Current Sprint / Focus
- **Multi-Replica Submitting Service Start Trigger Fix**:
  - In `backend/scripts/queue_daemon.mjs`: Fixed `isSubmitStartRequested` and `isScanStartRequested` to check sustained status flags `(bc && bc.is_running !== false && (bc.submit_status === 'running' || bc.submit_enabled === true))` and `(bc.scan_status === 'running' || bc.scan_enabled === true)` in addition to transient `last_action_requested` / `trigger_requested` signals. Previously, the first replica cleared `last_action_requested: null` and `trigger_requested: false`, leaving all subsequent submitter replicas permanently idle. Now all replicas start their respective worker pools concurrently.
- **Permanent Immutability of Submitted Applications & Zero Fallback Guarantee**:
  - In `backend/lib/submissionWorkerPool.mjs`:
    - `updateJobDistributionWithCheck`: Added an immutable pre-check that queries the existing row before executing an update. If the row is already `submitted` or possesses an authentic confirmation proof screenshot, any downgrade attempt to `ready_for_review`, `failed`, or `applying` is refused and skipped.
    - Stripped `application_submitted_screenshot_url: null` from update patches to prevent overwriting cloud screenshot URLs.
    - `claimTaskAtomically`: Hardened all 3 candidate priority queries (0th attempt, attempt 1, attempt 2) and the CAS update with `.is('application_submitted_screenshot_url', null).neq('status', 'submitted').neq('status', 'completed')`.
    - `reapExpiredLeases`: Added `.is('application_submitted_screenshot_url', null).neq('status', 'submitted').neq('status', 'completed')` on both query and lease reclaim update.
  - In `backend/scripts/queue_daemon.mjs`:
    - `recoverInterruptedSubmissionTasks`: Added `.is('application_submitted_screenshot_url', null).neq('status', 'submitted').neq('status', 'completed')`.
    - Targeted submission dispatchers: Added immutability guards.
  - In `backend/lib/workerPool.mjs`:
    - Added `.neq('status', 'submitted').neq('status', 'completed').is('application_submitted_screenshot_url', null)` to targeted submission failures and `already_applied` fallback handlers.
  - In `frontend/src/services/api.js`:
    - In `fetchDynamicKPIMetrics` and `fetchApplicationsDynamic`: Added `status.eq.submitted` to the date bounds `.or()` filter so authentic submitted applications and proof screenshots are never excluded from dashboard KPIs or Runs view when switching dates.
  - In Supabase `job_distributions`:
    - Restored all 11 genuine Unum submitted applications with authentic proof screenshots and verified timestamps.
    - Total verified count: **11 submitted**, **259 ready_for_review** (0 fallback).
- **Zoho Mail Disconnection Sibling Cascade & Immediate Stage 3 Failure Enforcement**:
  - **Stage 1 (Scanning)**: If a candidate's Zoho mailbox is disconnected or returns HTTP 400 (`mailbox_not_connected`), `clusterBatchRunner.mjs` immediately cascades to the next listed sibling candidate AWL ID in the batch queue without failing or halting the link.
  - **Stage 3 (Submissions)**: If an application requires Zoho verification and the candidate's mailbox is not connected, `submissionWorkerPool.mjs` immediately marks the job distribution as `failed` on Attempt 1 with zero retries.
- **WorkerPool Temporal Dead Zone (TDZ) Fix**:
  - Eliminated variable shadowing of `currentAttempt` in `backend/lib/workerPool.mjs` (renamed internal attempt counter to `attemptNum`), completely resolving the runtime error `Screenshot upload error in Step F: Cannot access 'currentAttempt' before initialization`.
- **Voluntary Disclosures Dropdown Sweeping & Strict Asian Multi-Checkbox Enforcement**:
  - In `backend/lib/workdayQuestionFill.mjs`: Added `sweepAndFillAllRemainingDropdowns`, which locates all unfilled dropdown triggers on the page, opens them, inspects live prompt options, classifies the question (Veteran Status, Gender, Hispanic, or profile close match), and clicks the matched option.
  - In `backend/lib/workdayQuestionFill.mjs` (`checkVoluntaryDisclosuresRequiredFields`): Flags any dropdown still having button text `"Select One"` or empty, preventing premature form advance.
  - In `backend/lib/workdayQuestionFill.mjs` & `backend/lib/engine.mjs`: Hardened race/ethnicity multi-checkbox enforcement so ONLY "Asian" is checked and all other 6 race options are strictly unchecked.
- **Strict Race Multi-Checkbox Rule & Generic Dropdown Closest-Match Resolution**:
  - **Multi-Checkbox Race Selection**: Strictly enforced that in race/ethnicity multi-checkbox groups (e.g. Voluntary Disclosures EEO), ONLY "Asian" is selected. All other race/demographic options (Black, Hispanic, White, Native Hawaiian, Two or more, I do not wish to answer) are strictly unchecked and never checked by mandatory-field heuristics in `checkbox.mjs` and `pageLoop.mjs`.
  - **Generic Dropdown Deduplication & Error Repair**:
    - In `pageLoop.mjs`: `fieldDedupeKey` and `pickNext` no longer collapse multiple generic dropdowns (e.g. `"Please select from the dropdown menu below."`) into a single key, preventing second dropdowns from being discarded or skipped.
    - In `workdayCustomDropdown.mjs`: If exact demographic text is not found, dynamically leverages `resolveAnswerFromLiveOptions` to match against client profile `resolved_answers`, `qa_answers`, experience, skills, and resume (Tier 5 close match).
    - In `workdayErrorRepair.mjs`: When a generic dropdown is flagged with an error ("is required and must have a value"), the repair agent opens the trigger, reads the live prompt options, classifies the question, matches against the profile, and clicks the closest option so it never remains empty as "Select One".
    - In `workdayQuestionFill.mjs`: `markSelectOneWidget` prioritizes unselected / empty dropdowns over already-answered widgets when multiple dropdowns share the same generic label.
- **Permanent Protection of Submitted Applications & Root Cause Bug Fix for Status Fallback**:
  - **Root Cause Identified**:
    1. In `backend/lib/supabaseClient.mjs` (`recordJobDistributions`): When a job was re-scanned or re-distributed, PostgREST `on_conflict=applywizz_id,job_url` with `resolution=merge-duplicates` blindly pushed `status: 'ready_for_review'` and `application_submitted_screenshot_url: null` for all clients, completely overwriting already-submitted applications back to 0.
    2. In `backend/lib/supabaseClient.mjs` (`upsertSupabaseApplication`): Worker initialization and error retries executed `PATCH job_distributions` with `ready_for_review` or `applying` without checking if the candidate had already submitted.
    3. In `backend/lib/submissionWorkerPool.mjs` (`updateJobDistributionWithCheck`): Non-submitted patch updates lacked a `.neq('status', 'submitted')` filter.
  - **Permanent Architectural Guards Implemented**:
    1. In `recordJobDistributions`: Pre-queries `job_distributions` for the target URL. Any candidate row with `status === 'submitted'` or `status === 'completed'` (or with a verified proof screenshot) is strictly preserved. In-memory deduplication forbids replacing any submitted row with `ready_for_review`.
    2. In `upsertSupabaseApplication`: Added pre-check and `status=neq.submitted&status=neq.completed` query constraints, aborting non-submitted status writes for already-submitted candidates.
    3. In `updateJobDistributionWithCheck`: Appended `.neq('status', 'submitted').neq('status', 'completed')` to all non-submitted patches.
    4. In `backend/scripts/reset_distributions_and_workers.mjs`: Added explicit protection `status=neq.submitted&status=neq.completed&status=neq.already_applied&application_submitted_screenshot_url=is.null`.
  - **Database State Restored**:
    - Restored all 11 genuine submitted Unum applications in `job_distributions` (`AWL-44161`, `AWL-27321`, `AWL-35252`, `AWL-32063`, `AWL-36883`, `AWL-4593`, `AWL-35033`, `AWL-32458`, `AWL-1568`, `AWL-26832`, `AWL-29710`) with their authentic cloud screenshots from `submitted-applications` bucket.
    - Verified dynamic KPI counts: Total submitted is now **11** (100% authentic, zero fallback).
- Removed `already_applied` label and its connection from Dev Dashboard (`DeveloperDashboard.jsx`): removed the dropdown filter option `<option value="already_applied">Already Applied</option>`, excluded `already_applied` rows from Dev Dashboard applications list and Runs tab filtering, and disconnected `already_applied` from Dev Dashboard's `SUBMITTED` KPI counter so it strictly counts authentic `submitted` / `completed` applications.
0. Fixed `job_distributions` terminal status overwrite bug in `backend/lib/supabaseClient.mjs`: added status guard in `recordJobDistributions` so existing `submitted`, `completed`, `already_applied`, or `applying` rows and their screenshot URLs are strictly preserved when re-distributing a scanned job, preventing the dashboard Submitted counter from resetting.
1. Fixed `qa_bank` Supabase 409 duplicate key conflict on `(tenant, normalized_question)` by aligning PostgREST `on_conflict=tenant,normalized_question` in `backend/lib/masterYamlManager.mjs` and `backend/lib/supabaseClient.mjs`, deduplicating rows on `(tenant, normalized_question)`, and adding row-by-row fallback.
2. Created migration `051_align_qa_bank_unique_constraint.sql` ensuring `qa_bank_tenant_question_unique` is active and dropping legacy constraints.
1. Deduplicated `submission_tasks` down to exact matching count (272) and fixed `distRes.json()` response handling.
2. Migrated `batch_job_queue` to 1 row per unique link format with all candidate AWL IDs stored in a single cell (`applywizz_id`), reducing 679 rows to 20 unique links.
3. Implemented `masterYamlManager.mjs` to generate a single deduplicated master reference YAML template (`config/master_scan_template.yml`) on first blueprint scan.
4. Enforced mock candidate (`AWL-1568`) selection across all 3 scanning workers.
5. Swapped `workerPool.mjs` to evasive Playwright stealth launcher (`./stealthBrowser.mjs`).
6. Enforced `SCANNER_RUN=true` and `SUBMIT_RUN=true` environment guards in `queue_daemon.mjs` preventing any unauthorized auto-starts.
7. Added 10-batch milestone reporting in scanning and 10-client milestone reporting in submissions.
8. Replaced legacy local disk `takeScreenshot` in `reporter.mjs` with in-memory streaming to Supabase Storage and automatic table updates in `submission_tasks`, `job_distributions`, `client_job_applications`, and `scanned_jobs`.
9. Fixed Workday Self-Identify (CC-305) Date spinbutton commitment error (`The field Date is required and must have a value`).
10. Dropped duplicate column `failure_screenshot_url` via migration `043_cleanup_failed_jobs_columns.sql` and standardized on `screenshot_path` as the single canonical proof column in `failed_jobs`.
11. Standardized all failure screenshots across `workerPool.mjs`, `submissionWorkerPool.mjs`, and `reporter.mjs` to strictly stream to the `failed-applications` bucket.
12. Implemented strict 2-attempt per-link retry policy (MAX_ATTEMPTS = 2): Attempt 1 failure re-queues without writing to failed_jobs; Attempt 2 failure upserts with all client_ids. Expired links skip retries and upsert directly.
13. Enforced Enter and Tab commitment on all text inputs (phone, postal code, city, address line 1, legal names) in `engine.mjs` and `workdayQuestionFill.mjs`.
14. Added Address Line 1 fallback to satisfy Workday required constraint, and added resume error detection in `workdayErrorRepair.mjs`.

## Recent Decisions in Flight
- **Prevent Automatic Daemon Execution on Deployment**: Initialized `initOnStartup()` to explicitly reset all Supabase `bot_control` and `worker_control` states to `off`/`idle` with `last_action_requested: null` and `trigger_requested: false`, preventing any automatic execution upon Railway container startup.
- **Single-Pass Scan & Resolve Execution**: Removed the endless 10-second `while` loop from `runScanAndResolveParallel()`. Scanning and resolving now runs for the triggered pass, saves applications to `ready_for_review`, and terminates cleanly to `idle`.
- **Enforced Two-Stage User Trigger Flow**: Stage 3 (Submissions) will never start automatically after scanning/resolving finishes. It remains halted until the user explicitly clicks "Trigger Submissions" in the frontend.
- **Hardened Secret Management**: Completely eradicated hardcoded Supabase `service_role` keys. Enforced strict fail-fast validation in `supabaseClient.mjs` if secrets are missing.
- **Claude as Primary LLM Engine**: Promoted direct Anthropic Claude integration (`CLAUDE_API_KEY` / `ANTHROPIC_API_KEY`) as first-class, removing deprecated `temperature` parameters that caused 400 errors with modern Claude models.
- **Queue Daemon & Worker Stability**: Removed unmigrated columns (`possibly_submitted`, `status_actor`, `review_flag`), resolved duplicate `server.listen` port conflicts, and added composite UUID handling in `updateQueueTaskStatus`.
- **Scanned & Failed Jobs Ingestion Fixed**:
  - Implemented missing `saveScannedJob` and `getScannedJob` functions in `backend/lib/supabaseClient.mjs` returning full row representation.
  - Aligned `saveScannedJob` payload with `scanned_jobs` schema (removed invalid `status` column, targeted Postgres `UNIQUE(job_url)`).
  - Aligned `failed_jobs` insertion with schema columns (`applywizz_id`, `job_id`, `job_url`, `company`, `role_title`, `failure_reason`, `failed_at_step`, `screenshot_path`).
  - Added non-expired failure recording (`recordFailedJob`) in `clusterBatchRunner.mjs` for lead candidate auth, bot, or form errors, releasing attempted tasks in `batch_job_queue` from `processing` to `failed`.
  - Added worker-level exception handling in `workerLoop` to record unexpected worker crashes to `failed_jobs` and fail corresponding queue tasks instead of leaving them stuck.
  - Relaxed distribution gate in `recordJobDistributions` to safely handle nullable `scannedJobRecord?.id`.
- **Zero Local Screenshots Enforcement**: Formally codified that all Playwright screenshots must be kept as in-memory buffers and uploaded directly to Supabase Storage (`submitted-applications` and `failed-applications`), ensuring zero disk pollution and strict candidate PII protection.
- **Strict Manual Git Control**: Enforced guardrail that automated agents never stage or commit code (`git add/commit/push` forbidden).
- **Railway BuildKit Daemon Failure Resolved**: Diagnosed and resolved the fatal `/run/buildkit/buildkitd.sock: use of closed network connection` error affecting scanning/resolver and admin services:
  1. Identified that `backend/.dockerignore` was completely missing; Railway's backend service build context was uploading 385MB (11,322 files including 158MB `backend/node_modules`, 135MB `backend/runs` traces, 71.5MB `backend/screenshots`), triggering BuildKit daemon OOM-kill. Created `backend/.dockerignore`.
  2. Root `.dockerignore` previously used shallow names (`runs`, `screenshots`, `data`) that failed to match nested folders (`backend/runs`, etc.). Hardened root and frontend `.dockerignore` with recursive `**/` patterns.
  3. Optimized `backend/Dockerfile` to copy `package*.json` first, run `npm install --omit=dev --legacy-peer-deps` for layer caching, and avoid copying host Windows node_modules before install.
  4. Removed conflicting `railpack.json` and explicitly declared `"dockerfilePath": "Dockerfile"` across `railway.json`, `backend/railway.json`, and created `frontend/railway.json`.
- **Pre-Push Evaluation Gate Installed**: Implemented a 2-layer branch evaluation gate:
  - Local hooks (`.githooks/pre-push` and `.githooks/pre-commit`) via `scripts/precheck/install-hooks.mjs`.
  - Required CI gate (`.github/workflows/precheck.yml`) enforcing status check `precheck`.
  - Comprehensive 12-check validation suite in `scripts/precheck/precheck.mjs` verifying git-state, paths-and-size, secrets, code-patterns, syntax, imports, migrations, dependencies, smoke-import, lint, tests, and build, writing full Markdown report to `.precheck/report.md`.
  - Configurable via `scripts/precheck/precheck.config.json` with documented guide in `docs/ci-precheck.md`.

## Immediate Blockers & Risks
- **OneDrive Sync Collisions**: Working inside OneDrive (`C:\Users\ajith\OneDrive\Desktop\Workday_Auto`) can create file locks or sync duplicate files during rapid local file generation or temp builds.
- **Supabase Cloud Credentials**: Running end-to-end live applies requires valid `.env` secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLAUDE_API_KEY`). Unit tests run offline using mocks.

## Next Logical Steps
1. **Verify Context & Protocols**: Confirm all `.ai/` context files, `architecture.md`, `rules.md`, and `AGENTS.md` are aligned with the active codebase.
2. **Execute Full Quality Verification**: Run the verification test suite (`node --test backend/tests/*.test.mjs`) and ensure frontend build compiles without errors.
3. **Queue Daemon Health Check**: Validate that background polling and error handling correctly handle empty or invalid queue states without unhandled promise rejections.
4. **Resume Parser Edge-Case Coverage**: Expand test cases for complex multi-page PDF resume extractions and uncommon university degree formats.
