# AGENTS.md — Workday Auto-Apply Bot

Scope: **Workday only.** No Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters, or generic-ATS logic belongs in this codebase. If any such code exists from a prior iteration, remove it — do not leave it dormant.

Source-of-truth documents for this project (read before building anything): `docs/prd.md`, `docs/rd.md`, `docs/workflow.md`, `docs/ui-ux.md`, `docs/backend-schema.md`, `docs/implementation.md`, `docs/telegram-bot-setup.md`.

---

## Workflow Rules

- **SESSION-CHECKPOINT is mandatory** — read `../SESSION-CHECKPOINT.md` **first** when starting work; **update it last** before ending any session (every IDE, every agent, every developer). All code changes, bugs, tests, and profile updates must be reflected there for the next handoff.
- **Smallest diff per phase** — no speculative scope, no future-proofing beyond what `implementation.md` specifies for the current sub-phase.
- **Test before marking done** — every task has a Given/When/Then checkpoint (see `implementation.md`); it must pass on a **live Workday URL**, never a mock.
- **No paid tools beyond agreed subscriptions** — flag any new external API/service before adding it.
- **Ask if ambiguous** — do not guess at Workday selectors, page flow, Telegram/Supabase behavior, or code logic; check the source docs or ask the project owner directly.
- **Source of truth for handoff** — use `../SESSION-CHECKPOINT.md` for where work stopped and what to do next (do not re-analyze the whole repo).
- **Source of truth for code state** — use `CODEBASE-ANALYSIS.md` when unclear about what currently exists.
- **Update `../SESSION-CHECKPOINT.md` after every session** that changes code, config, profile, or test results (mandatory).
- **Update `STATE.md` after every commit.**
- **Update `CODEBASE-ANALYSIS.md` at every commit** that touches `lib/`, `cli.mjs`, or `config/`.
- **Git discipline** — one commit per vertical slice; branch name reflects the slice; clear commit message.

## Code Generation Tool

**Antigravity CLI (`agy`)** is the sole code generation tool for this project.

### Workflow per slice
1. **Plan mode** (`agy /grill`) — clarify architecture, dependencies, page flow if unclear.
2. **Diff review** (`agy /diff`) — inspect output before commit.
3. **Agent mode** (`agy` default) — implement, test locally, commit.
4. **Fresh `agy` chat** at the start of each major phase (Local-1, Local-2, Local-3, Prod-1 through Prod-4).

## State Auto-Update Rule

**After every session (before closing IDE):**
1. Update `../SESSION-CHECKPOINT.md` — Last updated, Where work stopped, Start here next, Recent session log, Known issues.

**After every commit:**
1. Run: `agy @workday-auto-apply/lib @workday-auto-apply/cli.mjs "Summarize current working features, broken features, and next blockers from this code."`
2. Paste the summary into `STATE.md` under **Current Status**.
3. `git add STATE.md && git commit -m "[State] Updated after [feature-branch] commit"`

## Codebase Analysis Auto-Update Rule

**After every commit** touching `lib/`, `cli.mjs`, or `config/`:
1. Update `CODEBASE-ANALYSIS.md`:
   - Behavior changed → update the relevant flow/field-map section.
   - File added/removed → update Section "Important Folders and Files" and "Directory Structure".
   - A gap closed → move it from "Limitations" to the relevant capability section.
   - A new limitation found → add it to "Limitations".
2. `git add CODEBASE-ANALYSIS.md && git commit -m "[Docs] Update CODEBASE-ANALYSIS after [feature-branch]"`

## Scope Boundary

- **In scope (Local Phase):** `lib/discovery.mjs`, `scanner.mjs`, `workdayDom.mjs`, `planner.mjs`, `fields.mjs`, `engine.mjs`, `workday.mjs`, `qaStore.mjs`, `learner.mjs`, `reporter.mjs`, `cli.mjs`, `config/*.yml`.
- **In scope (Production Phase, after Local Phase Gate only):** `lib/telegram/*.mjs`, Supabase schema per `docs/backend-schema.md`, `qaStore.mjs` extended to query Supabase instead of local YAML.
- **Out of scope permanently:** any non-Workday ATS adapter, any UI/dashboard beyond Telegram messages, any resume-content-generation feature.

## Workday-Specific Rules

- **Authentication before scanning** — always authenticate on Workday before extracting form fields, never after.
- **Post-signup redirect handling** — after account creation succeeds and Workday redirects, detect the destination state; do not blindly retry login.
- **Multi-step wizard loop** — Workday forms run 3–5 wizard pages that vary per requisition. Click "Save and Continue", rescan fields fresh, refill, repeat until "Submit" or a confirmation state appears. Never assume a fixed step count.
- **DOM-first, always** — `[data-automation-id="..."]` patterns first; `:has-text()` as fallback. Screenshots are audit-only, never decision inputs (see `docs/ui-ux.md`).
- **Force clicks for modals** — use `{ force: true }` or `.evaluate(el => el.click())` when a Workday backdrop overlay intercepts a Playwright click.
- **Honeypot filtering** — skip fields with `data-automation-id="beecatcher"`, `name="website"`, `type="hidden"`.
- **Session persistence (optional optimization)** — consider `browserContext.storageState()` after successful auth to avoid re-authenticating every run.
- **Fuzzy-match before asking** — every scanned question goes through the Q&A cache (local YAML in Local Phase, Supabase `qa_answers` in Production) before falling back to resume inference, then to human escalation. Never skip straight to asking.
- **Compliance questions are never guessed** — work authorization, visa sponsorship, government employment, EEO/voluntary disclosure always require a human-sourced answer on file (terminal in Local Phase, Telegram in Production) before auto-submit.

## Checkpoint Pattern

```
Given [precondition, e.g. "live Workday job URL + valid profile"],
When [action, e.g. "bot runs node cli.mjs apply <url>"],
Then [result, e.g. "form fields detected > 0 AND application.status = SUBMITTED"].
```
Checkpoint must pass on a real Workday URL before commit. No mocks, no assumptions.

## Code Style

- Language: JavaScript (Node.js, `.mjs` modules).
- `async`/`await` over callbacks; no bare `setTimeout` polling — use Playwright's `waitFor*` methods.
- Named exports over default exports.
- JSDoc on all public functions (purpose, params, return).
- Secrets via `.env` only, never hardcoded — see `docs/backend-schema.md` for Production-phase encrypted-column handling.
- Module separation: discovery ≠ scanning ≠ planning ≠ filling ≠ submission ≠ notification.

## Git & Branching

- Branch format: `fix/workday-{issue}` or `feat/workday-{feature}`.
- Commit format: `[Workday] Short description` or `[Scan/Fill/Auth/Telegram/Supabase] Short description`.
- After merge: delete branch, update `STATE.md` immediately.
- No merge until checkpoint passes on a real Workday URL.

## Blockers & Mitigation

| Blocker | Mitigation |
|---|---|
| Workday DOM changes / selector fails | Log failing selector + page URL; add fallback selector; update `planner.mjs` FIELD_MAP |
| Multi-step wizard shape unclear on a new tenant | Record the manual flow; extract a step map from the recording |
| Login fails | Check WORKDAY_EMAIL / WORKDAY_PASSWORD in `.env` (or `workday_credentials` in Production). Mailbox OTP is not connected; Zoho Mail can be added later if a tenant requires a code |
| Bot loops or hangs | Add timeout gates; log page URL at each step; inspect `screenshots/` for context |
| Telegram reply doesn't map to pending escalation | Verify `telegram_chat_id` ↔ pending question state is tracked per user, not globally |

---

**Established:** Workday-only bot, `agy`-only code generation, `STATE.md` auto-updated per commit, live Workday testing required for all checkpoints, Production Phase gated behind a passing Local Phase.
