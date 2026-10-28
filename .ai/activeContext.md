# Active Context: Workday Auto

## Current Sprint / Focus
Implemented centralized architectural fixes for Workday automation pipeline:
1. Deduplicated `submission_tasks` down to exact matching count (272) and fixed `distRes.json()` response handling.
2. Migrated `batch_job_queue` to 1 row per unique link format with all candidate AWL IDs stored in a single cell (`applywizz_id`), reducing 679 rows to 20 unique links.
3. Implemented `masterYamlManager.mjs` to generate a single deduplicated master reference YAML template (`config/master_scan_template.yml`) on first blueprint scan.
4. Enforced mock candidate (`AWL-1568`) selection across all 3 scanning workers.
5. Swapped `workerPool.mjs` to evasive Playwright stealth launcher (`./stealthBrowser.mjs`).
6. Enforced `SCANNER_RUN=true` and `SUBMIT_RUN=true` environment guards in `queue_daemon.mjs` preventing any unauthorized auto-starts.
7. Added 10-batch milestone reporting in scanning and 10-client milestone reporting in submissions.
8. Replaced legacy local disk `takeScreenshot` in `reporter.mjs` with in-memory streaming to Supabase Storage and automatic table updates in `submission_tasks`, `job_distributions`, `client_job_applications`, and `scanned_jobs`.
9. Fixed Workday Self-Identify (CC-305) Date spinbutton commitment error (`The field Date is required and must have a value`).

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

## Immediate Blockers & Risks
- **OneDrive Sync Collisions**: Working inside OneDrive (`C:\Users\ajith\OneDrive\Desktop\Workday_Auto`) can create file locks or sync duplicate files during rapid local file generation or temp builds.
- **Supabase Cloud Credentials**: Running end-to-end live applies requires valid `.env` secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLAUDE_API_KEY`). Unit tests run offline using mocks.

## Next Logical Steps
1. **Verify Context & Protocols**: Confirm all `.ai/` context files, `architecture.md`, `rules.md`, and `AGENTS.md` are aligned with the active codebase.
2. **Execute Full Quality Verification**: Run the verification test suite (`node --test backend/tests/*.test.mjs`) and ensure frontend build compiles without errors.
3. **Queue Daemon Health Check**: Validate that background polling and error handling correctly handle empty or invalid queue states without unhandled promise rejections.
4. **Resume Parser Edge-Case Coverage**: Expand test cases for complex multi-page PDF resume extractions and uncommon university degree formats.
