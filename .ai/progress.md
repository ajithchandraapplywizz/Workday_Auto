# Project Progress & Roadmap

## What's Shipped (✅ Fully Shipped)
- ✅ **Centralized Queue Consolidation (1 Row Per Link)**: Migrated `batch_job_queue` from 679 repetitive rows down to 20 unique links, storing all candidate AWL IDs in a single cell (`applywizz_id`).
- ✅ **Master YAML Reference Bank**: Implemented `masterYamlManager.mjs` creating a single deduplicated `config/master_scan_template.yml` on first run for automatic question matching across all clients.
- ✅ **Strict Deduplication on `submission_tasks`**: Deduplicated existing 2,522 rows down to the authentic 272 tasks, fixed `distRes.json()` response handling, and enforced pre-check and uniqueness.
- ✅ **Stealth Browser & In-Memory Review Proof**: Swapped worker pool launcher to `stealthBrowser.mjs`, verified Review & Submit page screenshots stream strictly to cloud storage (`submitted-applications`).
- ✅ **Service Role & RUN=true Environment Gating**: Enforced `SCANNER_RUN=true` and `SUBMIT_RUN=true` environment guards in `queue_daemon.mjs`, eliminating accidental auto-starts while maintaining instant frontend Stop control.
- ✅ **Authoritative 10-Item Milestone Reports**: Added periodic 10-batch scanning reports and 10-client submission reports in service logs.
- ✅ **Railway Daemon Idle Boot & Trigger Gating**: Container startup unconditionally resets all bot and worker states to `idle`/`off` with `last_action_requested: null`, preventing autonomous log spam or auto-running upon deployment.
- ✅ **Single-Pass Scan & Resolve**: Removed 10-second infinite loop in `runScanAndResolveParallel()`; workers scan and resolve to `ready_for_review`, then safely idle.
- ✅ **Strict Sequential Trigger Architecture**: Submissions will never auto-start after scanning & resolving; submissions strictly require manual user click on "Trigger Submissions" after Stage 1 finishes.
- ✅ **Core Playwright Engine**: Complete browser automation loop for Workday applications (`engine.mjs`, `workdayPageWorkflow.mjs`).
- ✅ **5-Tier Answer Resolution Engine**: Strict priority waterfall (Tier 1 Supabase -> Tier 2 Resume -> Tier 2.5 Universal YAML / qa_bank -> Tier 3 CRM -> Tier 4 Claude Haiku 5.5 with live DOM options).
- ✅ **Self-Learning Tier 1 Feedback**: Resolved LLM answers are automatically upserted into Supabase `client_questions` for instant zero-latency future use.
- ✅ **Zero Local Screenshots Compliance**: All browser audit screenshots captured in memory and streamed directly to Supabase cloud buckets.
- ✅ **Queue Daemon & Batch Processing**: Asynchronous worker processing of candidate applications from Supabase queue (`scripts/queue_daemon.mjs`, `cli.mjs batch`).
- ✅ **Workday Step Coverage**: Specialized modules for `My Information`, `My Experience` (including spin calendar dates), `Application Questions`, and `Voluntary Disclosures`.
- ✅ **Voluntary Disclosures Veteran & EEO Fixes**: Unconditional veteran question resolution and bidirectional matching for non-standard labels.
- ✅ **Frontend Dashboard**: React + Vite application for monitoring queue status, error reports, and candidate applications.
- ✅ **Claude Haiku 5.5 As Sole LLM Provider**: Completely removed OpenRouter. Built claudeLlm.mjs with strict JSON formatting, no temperature parameter, and no fabricating prompts. Returns null/requiresReview on unanswerable submission questions.
- ✅ **Composite Task ID UUID Routing**: Extended `updateQueueTaskStatus` to parse composite task identifiers without triggering PostgreSQL `22P02` syntax errors.
- ✅ **Playwright Extra Stealth AddExtra**: Switched stealth browser launcher to `addExtra` with defensive fallback to standard Playwright, resolving Docker module resolution errors.
- ✅ **Security Hardening**: Zero hardcoded secrets, fail-fast verification on missing environment variables.

- ✅ **In-Memory Screenshot Table Persistence & Cloud Streaming**: Replaced legacy local disk `takeScreenshot` in `reporter.mjs` with in-memory streaming to Supabase Storage (`submitted-applications` and `application-failures`), added `updateRecordScreenshot` in `supabaseClient.mjs` linking screenshot paths to `submission_tasks`, `job_distributions`, `client_job_applications`, and `scanned_jobs`, and added informative terminal logs.
- ✅ **Workday CC-305 Date Spinbutton Commit Fix**: Dispatched click, fill, change, blur, and tab across all 3 date spinbuttons (Month, Day, Year) in `workdayQuestionFill.mjs`, fixing Workday's validation rejection `Error-DateThe field Date is required and must have a value`.
- ✅ **Failure Screenshot Column Consolidation (`failed_jobs`)**: Dropped duplicate `failure_screenshot_url` column in `failed_jobs` via migration `043_cleanup_failed_jobs_columns.sql`, merging any existing URLs into `screenshot_path` and designating `screenshot_path` as the single canonical failure proof column.
- ✅ **Every Failure Screenshot Cloud Upload**: Updated `workerPool.mjs` so every failure/incomplete run captures and uploads its screenshot to `application-failures` and links it in `screenshot_path`.
- ✅ **2-Attempt Per-Link Retry Policy (MAX_ATTEMPTS = 2)**: Replaced legacy candidate-switching loop with per-link retry. Attempt 1 failure logs exact retry line and re-queues without touching failed_jobs. Attempt 2 failure upserts into failed_jobs with client_ids and screenshot. Expired links skip retries and upsert immediately.
- ✅ **Enter/Tab Text Commitment & Address Fallback**: Dispatched `Enter` and `Tab` after typing in City, Phone Number, Postal Code, Address Line 1, and Legal Name inputs, and added a safe Address Line 1 fallback to prevent Workday validation errors.
- ✅ **Pre-Push Evaluation Gate Passed**: Deployed two-layer branch evaluation gate (local git hooks `.githooks/` and GitHub Action `precheck.yml`) enforcing 12 automated checks (git-state, paths-and-size, secrets, code-patterns, syntax, imports, migrations, dependencies, smoke-import, lint, tests, build) reporting to `.precheck/report.md`. Verified `0` failures across all 180 branch files.
- ✅ **CI/CD & Local Runtime Audit**: Fixed Windows cross-platform `postinstall` commands in root and backend `package.json`, resolved syntax error in `backend/lib/llmFallback.mjs`, exported missing `request` in `backend/lib/supabaseClient.mjs` resolving runtime load crashes in `masterYamlManager.mjs`, and added clean bridge handlers for `demoRunner.mjs`, `queueBatchRunner.mjs`, and `tenantQuestionYaml.mjs`. Verified `npm ci`, `npm test` (11/11 passing), `npm run typecheck`, and `cd frontend && npm run build` (1.68s) all passing cleanly.

## In Progress (🚧 In Progress)
- 🚧 **AI Context Architecture Bootstrap**: Implementing the `.ai/` memory standard, Andrej Karpathy coding principles (`rules.md`), system architecture (`architecture.md`), and agent orchestrator rules (`AGENTS.md`).
- 🚧 **Queue Daemon Recovery Hardening**: Enhancing worker resilience against transient network timeouts or cloud storage drops during screenshot streaming.

## Planned / Next Up (📋 Backlog)
- 📋 **Expanded Workday Tenant Heuristics**: Additional specialized overrides for non-standard Workday subdomains and localized language interfaces.
- 📋 **Automated Retry Escalation**: Dynamic backoff and auto-rescheduling for rate-limited or temporarily unresponsive tenant portals.
- 📋 **Multi-Resume Profile Routing**: Intelligent switching between candidate resume variants depending on detected job requisition title.

## Known Bugs & Gotchas
- **Railway BuildKit Daemon Failure (`buildkitd.sock`)**: Triggered when BuildKit exhausts memory during build context packaging or builder worker initialization. Solved by: (1) Creating `backend/.dockerignore` to block 385MB of local node_modules, traces, and screenshots from being uploaded when building from `/backend`, (2) Hardening root and frontend `.dockerignore` files with recursive `**/` patterns, (3) Optimizing `backend/Dockerfile` with layer-cached `npm install --omit=dev`, (4) Removing conflicting `railpack.json` and declaring `"dockerfilePath": "Dockerfile"` across all services. In Railway UI, selecting "Clear build cache and redeploy" completes the reset.
- **OneDrive Sync Delays**: Storing project files on Windows OneDrive path can cause momentary file write locks.
- **Workday Date Spinbutton React Commitment**: Workday's 3-segment date inputs (Month, Day, Year) do not commit their value to React/Workday state on `.fill()` alone unless change/blur events are dispatched and the Year segment is tabbed out of; otherwise Workday throws `Error-DateThe field Date is required and must have a value`.
- **Workday Custom Dropdown Shadow DOM / ARIA Quirks**: Some Workday tenants dynamically detach and re-render dropdown lists when scrolled; options should always be re-scanned if interaction fails on the first pass.
- **No Asterisk on Voluntary Disclosures**: Workday frequently marks fields required in backend validation without rendering an asterisk (`*`) or `aria-required="true"` on the DOM element. The orchestrator must fill all detected compliance fields rather than skipping non-required ones.
- **Missing Profile Statements from LLM**: Without strict prompt constraints, LLMs may return natural language explanations (e.g. `"The candidate has not provided this information"`). The engine guards against this with `isMissingProfileStatement`, but all prompts must instruct the LLM to return strictly valid field values or empty tokens.

