# Workday Auto-Apply Flow Report

**Review date:** 2026-09-04  
**Scope:** `workday-auto-apply/auto-apply` implementation plus `ProjectDocs/`  
**Conclusion:** The Local Phase is the current executable product. The Production Phase is specified in documentation, but the current checkout does not contain a runnable Telegram/Supabase service.

## 1. System overview

The project is a Node.js ES-module CLI using Playwright and a visible Chromium browser. It is Workday-only.

```text

CLI
  -> URL validation and discovery
  -> Workday authentication
  -> DOM/accessibility scan
  -> answer planning
  -> field filling and verification
  -> wizard transition and rescan
  -> review cross-check
  -> submit
  -> screenshot, CSV log, learning update
```

The shared core is intended to be reusable by both Local and Production:

```text
discovery.mjs -> scanner.mjs/workdayDom.mjs -> planner.mjs/qaStore.mjs
              -> fields.mjs/engine.mjs -> reporter.mjs/learner.mjs
```

## 2. Local Phase: current executable flow

### Entry points

Run from `workday-auto-apply/auto-apply`:

```text
node cli.mjs setup
node cli.mjs scan <workday-url>
node cli.mjs apply <workday-url>
node cli.mjs batch [targets.txt]
node cli.mjs queue add|list|remove|clear
node cli.mjs status
```

`apply` is the complete path. The browser is intentionally launched with `headless: false`.

### Local flow map

```text
START
  |
  v
Load .env and config/profile.yml
  |
  v
Validate URL
  |-- invalid/non-Workday --> print error and stop
  |
  v
Launch headed Chromium (1280x900)
  |
  v
Open Workday job URL
  |
  v
Discover application form
  |-- cookie banner --> accept
  |-- already in wizard --> continue
  |-- job page --> click Apply
  |-- application choice --> choose manual application
  |-- gateway --> detect sign-in/sign-up/email/social-SSO state
  |
  v
Authenticate
  |-- sign-in --> fill Workday email/password
  |-- sign-up --> create account, handle verification, then continue
  |
  v
Extract job description and choose resume
  |
  v
Scan visible DOM/accessibility fields
  |
  v
Generate plan
  |-- Q&A cache match
  |-- profile/resume fact
  |-- Workday default for known safe fields
  |-- optional field skip
  |-- required unknown --> terminal prompt
  |
  v
Fill field and verify value
  |-- dropdown/typeahead/radio/checkbox/file/phone handling
  |-- bounded retry and rescan after DOM mutations
  |
  v
Detect current Workday step
  |-- My Information
  |-- My Experience
  |-- Application Questions
  |-- Voluntary Disclosures
  |-- Review
  |-- Unknown --> diagnostics/failure path
  |
  v
Save and Continue
  |-- not Review --> settle DOM and repeat scan/fill
  |-- Review --> parse and cross-check summary
  |
  v
Submit and detect confirmation state
  |
  v
Take screenshot, write data/applied.csv, update queue/learnings
  |
  v
Close browser / continue next batch URL
```

### Local data flow

```text
config/profile.yml + config/resumes.yml + .env
                 |
                 v
          scan JSON / plan JSON in forms/
                 |
                 v
       Workday browser session
          |                 |
          v                 v
 data/applied.csv     screenshots/*.png
 data/queue.csv       data/learnings.json
 data/qa-store.json   profile.qa_answers
```

### Local functionality by module

| Module | Responsibility |
|---|---|
| `cli.mjs` | Command dispatch, credentials, browser lifecycle, orchestration |
| `discovery.mjs` | Workday URL validation, target parsing, Apply/gateway discovery |
| `workday.mjs` | Workday sign-in and account creation (email + password only) |
| `scanner.mjs` | Generic DOM field extraction and scan output |
| `workdayDom.mjs` | Workday-specific field discovery, required checks, review parsing |
| `stateDetector.mjs` | Detects the current wizard step from rendered DOM/a11y content |
| `planner.mjs` | Maps labels to profile values and produces fill decisions |
| `qaStore.mjs` | Normalization, fuzzy matching, local JSON/YAML persistence, Supabase store scaffold |
| `fields.mjs` | Locating fields and interacting with dropdowns/typeaheads |
| `engine.mjs` | Wizard loop, filling, verification, and submit path |
| `learner.mjs` | Records results and learned option corrections |
| `reporter.mjs` | Screenshots, CSV application log, queue management |

## 3. Production Phase: documented target flow

### Production flow map

```text
Admin creates onboarding deep-link token
  |
  v
QR encodes https://t.me/<bot>?start=<token>
  |
  v
User opens Telegram bot and submits email
  |
  v
Resolve user + telegram_links in Supabase
  |
  v
Read encrypted Workday credentials
  |
  v
Run the same Workday login/core engine
  |
  v
Send login confirmation in Telegram
  |
  v
Query active job_links by user's domain
  |-- daily cap / duplicate window check
  |
  v
Send job approval message with Apply/Skip buttons
  |-- Skip --> mark skipped/ineligible
  |-- Apply --> create application and enqueue run
  |
  v
Run shared scan -> match -> fill -> verify -> review -> submit engine
  |
  v
Unknown required question
  |-- Supabase Q&A hit --> fill
  |-- resume/profile fact --> fill
  |-- miss --> Telegram question
                         |
                         v
                 store user answer in qa_answers
  |
  v
Write status/screenshots/audit data to Supabase
  |
  v
Send final result to Telegram
```

### Production data model

The design specifies these tables:

```text
users
  ├── telegram_links
  ├── workday_credentials
  ├── resumes
  ├── qa_answers
  ├── applications
  └── notifications_log

job_links (shared job pool, filtered by domain)
```

Required production controls are per-user isolation, encrypted Workday passwords, RLS, daily apply caps, duplicate suppression, and status transitions such as `pending -> submitted|needs_review|failed`.

## 4. Production implementation status

### Present

- Production architecture, workflow, schema, Telegram setup, and security requirements are documented in `ProjectDocs/`.
- `qaStore.mjs` contains a `SupabaseQAStore` class and a backend factory hook.
- The Local engine has the abstractions needed to share scanning/filling logic conceptually.

### Not present as a runnable current service

- No current `lib/telegram/` bot implementation.
- No current onboarding handler or QR-token service.
- No current job approval queue/worker connected to Supabase.
- No current Supabase application/status reporter.
- No production human-interaction adapter that pauses the engine and resumes from Telegram replies.
- No production deployment configuration or runnable service entry point.
- No completed RLS/deployment verification in the current implementation.

Therefore, Production should be treated as **design/specification only**, not as an available production environment.

## 5. Important gaps and risks

1. **Live checkpoints are pending.** `STATE.md` marks Local-1, Local-2, Local-3, and the three-tenant Local Gate as not completed.
2. **Production is gated on the Local Gate.** The documented build order requires reliable runs on three real Workday tenants before Prod-1 through Prod-4.
3. **Current error handling is not fully auditable.** Several modules intentionally return empty/null values after broad catches; this can hide selector, storage, or Supabase failures.
4. **The Supabase store is incomplete for the documented schema.** Its current queries do not show explicit `user_id` scoping, compliance metadata, or the complete production audit contract.
5. **The root workspace configuration now targets the active Workday project under `workday-auto-apply`, which is the valid local execution path in this filesystem.** Root scripts were aligned to the actual project directory instead of the stale legacy workspace.6. **Batch isolation is local-process based.** Local queue/CSV/YAML files are appropriate for one operator, not concurrent users.7. **Credentials remain operationally sensitive.** Local credentials come from `.env`/profile fallback; production must not reuse this file-based approach.
8. **Workday UI variability remains the main runtime risk.** Selectors, wizard headings, gateway states, and required-field detection need live tenant validation.

## 6. Recommended execution order

```text
1. Complete Local-1 live auth checkpoint
2. Complete Local-2 cached-question checkpoint
3. Complete Local-3 first-time-question learning checkpoint
4. Validate on 3 real Workday tenants and measure >=80% success
5. Implement production adapters and Telegram onboarding
6. Add Supabase persistence, RLS, queue/worker, and per-user pending-question state
7. Validate two concurrent users with isolated data
8. Deploy only after production gate passes
```

## 7. Final assessment

The core local Workday automation flow is coherent and substantially implemented: discovery, authentication, DOM-first scanning, answer planning, dynamic wizard handling, verification, submission, screenshots, and local reporting are all represented in code.

The production concept is also coherent at the architecture/document level, but it is not yet an executable production system. The next meaningful milestone is not deployment; it is completing and recording the Local live checkpoints, then implementing the production shell around the already-defined core.
