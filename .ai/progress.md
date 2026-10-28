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
- ✅ **4-Tier Answer Resolution Engine**: Strict priority resolution (Supabase -> Apply Wizz CRM -> Parsed Resume -> OpenRouter LLM with live DOM options).
- ✅ **Self-Learning Tier 1 Feedback**: Resolved LLM answers are automatically upserted into Supabase `client_questions` for instant zero-latency future use.
- ✅ **Zero Local Screenshots Compliance**: All browser audit screenshots captured in memory and streamed directly to Supabase cloud buckets.
- ✅ **Queue Daemon & Batch Processing**: Asynchronous worker processing of candidate applications from Supabase queue (`scripts/queue_daemon.mjs`, `cli.mjs batch`).
- ✅ **Workday Step Coverage**: Specialized modules for `My Information`, `My Experience` (including spin calendar dates), `Application Questions`, and `Voluntary Disclosures`.
- ✅ **Voluntary Disclosures Veteran & EEO Fixes**: Unconditional veteran question resolution and bidirectional matching for non-standard labels.
- ✅ **Frontend Dashboard**: React + Vite application for monitoring queue status, error reports, and candidate applications.
- ✅ **Native Claude Anthropic Integration**: Prioritized direct Anthropic SDK integration with zero deprecated parameters, enabling seamless question resolution using Claude.
- ✅ **Composite Task ID UUID Routing**: Extended `updateQueueTaskStatus` to parse composite task identifiers without triggering PostgreSQL `22P02` syntax errors.
- ✅ **Playwright Extra Stealth AddExtra**: Switched stealth browser launcher to `addExtra` with defensive fallback to standard Playwright, resolving Docker module resolution errors.
- ✅ **Security Hardening**: Zero hardcoded secrets, fail-fast verification on missing environment variables.

## In Progress (🚧 In Progress)
- 🚧 **AI Context Architecture Bootstrap**: Implementing the `.ai/` memory standard, Andrej Karpathy coding principles (`rules.md`), system architecture (`architecture.md`), and agent orchestrator rules (`AGENTS.md`).
- 🚧 **Queue Daemon Recovery Hardening**: Enhancing worker resilience against transient network timeouts or cloud storage drops during screenshot streaming.

## Planned / Next Up (📋 Backlog)
- 📋 **Expanded Workday Tenant Heuristics**: Additional specialized overrides for non-standard Workday subdomains and localized language interfaces.
- 📋 **Automated Retry Escalation**: Dynamic backoff and auto-rescheduling for rate-limited or temporarily unresponsive tenant portals.
- 📋 **Multi-Resume Profile Routing**: Intelligent switching between candidate resume variants depending on detected job requisition title.

## Known Bugs & Gotchas
- **OneDrive Sync Delays**: Storing project files on Windows OneDrive path can cause momentary file write locks.
- **Workday Custom Dropdown Shadow DOM / ARIA Quirks**: Some Workday tenants dynamically detach and re-render dropdown lists when scrolled; options should always be re-scanned if interaction fails on the first pass.
- **No Asterisk on Voluntary Disclosures**: Workday frequently marks fields required in backend validation without rendering an asterisk (`*`) or `aria-required="true"` on the DOM element. The orchestrator must fill all detected compliance fields rather than skipping non-required ones.
- **Missing Profile Statements from LLM**: Without strict prompt constraints, LLMs may return natural language explanations (e.g. `"The candidate has not provided this information"`). The engine guards against this with `isMissingProfileStatement`, but all prompts must instruct the LLM to return strictly valid field values or empty tokens.
