# AGENTS.md: AI Orchestration & Governance Guide

Welcome to the Workday Auto repository. All AI assistants, coding agents, and automated pair programmers operating in this codebase MUST strictly adhere to the guidelines, loading orders, and protocols defined in this document.

---

## Always Load First Table

Before inspecting or writing code for ANY task, every AI agent must load and reference the following 6 core context files:

| Order | Document | Purpose & Authority |
|---|---|---|
| **1** | [`rules.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/rules.md) | The 4 Andrej Karpathy principles + project guardrails (Zero Local Screenshots & No Git Commits) |
| **2** | [`.ai/projectbrief.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/projectbrief.md) | Executive summary, user roles, scope boundaries, and non-negotiables |
| **3** | [`.ai/systemPatterns.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/systemPatterns.md) | System architecture, wizard state machine, 4-tier answer hierarchy, and data models |
| **4** | [`.ai/techContext.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/techContext.md) | Tech stack, active CLI scripts, environment variables, and file locations |
| **5** | [`.ai/activeContext.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/activeContext.md) | Current sprint focus, recent decisions, blockers, and next logical steps |
| **6** | [`.ai/progress.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/progress.md) | Shipped capabilities, in-progress items, backlog, and known gotchas |

---

## Load by Task Table

When assigned specific tasks, load and consult these specialized modules in addition to the core context:

| Task Domain | Relevant Files to Inspect | Focus Areas |
|---|---|---|
| **Database & Migrations** | `migrations/`, `backend/supabase-migrations/`, `backend/lib/supabaseClient.mjs` | Schema alterations, RLS policies, indexing on `client_questions` or `client_job_applications` |
| **DOM Scanning & Selectors** | `backend/lib/workdayDom.mjs`, `backend/lib/scanner.mjs`, `backend/lib/interaction/fieldSchema.mjs` | Container detection, ARIA labels, live option scraping, Workday CSS changes |
| **Answer Resolution & LLM** | `backend/lib/clientAnswer.mjs`, `backend/lib/openRouterLlm.mjs`, `backend/lib/applyWizzClient.mjs` | 4-tier waterfall precedence, prompt formats, option token matching, Supabase upsert |
| **Step-Specific Wizard Logic** | `backend/lib/workdayExperience.mjs`, `backend/lib/workdayDateFill.mjs`, `backend/lib/workdaySource.mjs` | Job history, spin calendars, referral source hierarchy, voluntary disclosures |
| **Queue & Daemon Automation** | `backend/scripts/queue_daemon.mjs`, `backend/cli.mjs` | Queue polling, concurrency locking, process error handling, graceful shutdown |
| **Frontend UI & Dashboard** | `frontend/src/`, `frontend/package.json`, `frontend/vite.config.js` | React components, Vite configuration, Supabase client authentication, UI state |
| **CI/CD & Containerization** | `.github/workflows/ci.yml`, `Dockerfile`, `frontend/Dockerfile` | Docker multi-stage builds, Playwright dependency installation, CI test gates |

---

## Hard Rules for AI Working in This Codebase

1. **Zero Local Screenshots Policy (STRICT)**:
   - NEVER save, write, or download screenshots to the local disk or workspace folders (`screenshots/`, `data/`, `tmp/`).
   - All Playwright screenshots must be kept strictly as in-memory buffers (`const buf = await page.screenshot()`) and streamed to Supabase Storage (`submitted-applications` or `failed-applications`).
   - Do NOT touch, delete, rename, or disturb any existing screenshots already present on local disk.
2. **Git Workflow Policy (STRICT)**:
   - NEVER execute `git add`, `git commit`, `git push`, or any automated commit commands.
   - All version control commits and pushes are strictly reserved for the human developer. Read-only commands (`git status`, `git diff`, `git log`) are permitted.
3. **No Blind Form Filling**:
   - Every input interaction must be followed by a verification step asserting that the value persisted in the DOM before proceeding.
4. **Strict 4-Tier Resolution Hierarchy**:
   - Order: Supabase (Tier 1) -> Apply Wizz CRM (Tier 2) -> Resume PDF (Tier 3) -> Live DOM Options + LLM (Tier 4). Never invert this order.
5. **No Hallucinated Compliance Answers**:
   - Never generate arbitrary or guessing answers for EEO, race, gender, disability, or veteran status. Stop and flag for review if missing from candidate data.
6. **No Drive-By Refactoring**:
   - Touch only the files relevant to your task. Match existing code style (Node.js ES modules, Playwright patterns).
7. **Clean Up Orphaned Code**:
   - If an edit removes or replaces a function/variable, clean up its unused imports and callers.
8. **Preserve Documentation**:
   - Maintain existing comments and docstrings. Do not strip context.

---

## Session Startup Protocol

Every AI agent must follow this protocol at the beginning of any work session:

1. **Acknowledge Rules & Principles**:
   - Read `rules.md` and confirm adherence to the 4 Karpathy principles (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution) and project guardrails (Zero Local Screenshots, No Git Commits).
2. **Establish Current State**:
   - Read `.ai/activeContext.md` and `.ai/progress.md` to identify current sprint tasks, blockers, and completed milestones.
3. **Formulate Goal-Driven Plan**:
   - Define concrete, verifiable success criteria before touching any code.
   - Outline a step-by-step plan with verification checks at every step.

---

## End-of-Session Protocol (Mandatory Before Closing)

Every AI agent must complete these steps before completing a session or wrapping up a task:

### 1. Run Verification Commands
Execute the project verification gates:
- Unit test suite:
  ```powershell
  npm test
  ```
- Syntax & typecheck:
  ```powershell
  npm run typecheck
  ```
- Frontend build validation (if frontend or dependencies were touched):
  ```powershell
  cmd /c "cd frontend && npm run build"
  ```
All commands must pass with exit code 0.

### 2. Update `.ai/` Project Docs
Keep the persistent memory accurate and up-to-date:
- **Completed feature or fix** -> Move to ✅ *Fully Shipped* in [`.ai/progress.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/progress.md).
- **New bug, gotcha, or edge case discovered** -> Record in *Known Bugs & Gotchas* in [`.ai/progress.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/progress.md).
- **Sprint focus shifted** -> Update *Current Sprint / Focus* in [`.ai/activeContext.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/activeContext.md).
- **Blockers encountered or resolved** -> Update *Immediate Blockers & Risks* in [`.ai/activeContext.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/activeContext.md).
- **Schema or migration added/altered** -> Update [`.ai/systemPatterns.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/systemPatterns.md).
- **New script or environment variable introduced** -> Update [`.ai/techContext.md`](file:///C:/Users/ajith/OneDrive/Desktop/Workday_Auto/.ai/techContext.md).
- *If in doubt, update `activeContext.md`.*

### 3. Provide Summary to Developer
Deliver a concise, structured report detailing:
- Changes made and files created/updated.
- Results of verification checks (`npm test`, build checks).
- Documentation state and recommended next steps for the developer.
