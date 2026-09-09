# CLAUDE.md — Workday Auto-Apply Bot

Context file for Claude Code (or any Claude-based IDE agent) working in this repository. This complements `AGENTS.md` — read both before making changes.

## What this project is

A Node.js + Playwright bot that applies to jobs on live **Workday** career sites. Local Phase: single-user, terminal-driven. Production Phase: multi-user, Telegram + Supabase-driven. Full spec lives in `docs/` — always check there before assuming behavior.

## Non-negotiable rules for this codebase

1. **Workday only.** Do not add, restore, or reference Greenhouse/Lever/Ashby/iCIMS/SmartRecruiters logic.
2. **DOM-first.** Field discovery and decisions come from the DOM/accessibility tree, never from screenshots or vision models. Screenshots exist for audit only.
3. **Never fabricate an answer.** Sources, in priority order: (1) Q&A cache fuzzy match, (2) resume/profile factual data, (3) human-provided answer (terminal locally, Telegram in production) — which is then persisted permanently.
4. **Compliance questions always need a human-sourced answer on file** before they're ever auto-submitted (work auth, visa, EEO categories).
5. **Headed browser always** — `headless: false` is not configurable away in Local Phase.
6. **Config/data-driven, not hardcoded.** Profile data, answers, and credentials live in `config/*.yml` (Local) or Supabase (Production) — never inline in code.
7. **Ask, don't guess,** on any ambiguous Workday selector, page flow, or Telegram/Supabase behavior not covered by `docs/`.

## Where to look first

| Question | File |
|---|---|
| What are we building and why? | `docs/prd.md` |
| What exactly must this feature do? (by requirement ID) | `docs/rd.md` |
| What's the exact control flow? | `docs/workflow.md` |
| How should the bot interact with Workday's DOM / escalate to a human? | `docs/ui-ux.md` |
| What does the Supabase schema look like? | `docs/backend-schema.md` |
| What order do I build things in, and what's the checkpoint for each? | `docs/implementation.md` |
| How do I set up the Telegram bot? | `docs/telegram-bot-setup.md` |
| What currently works / is broken / is next? | `STATE.md` |
| What does the code actually do right now? | `CODEBASE-ANALYSIS.md` |

## Working style expected in this repo

- Smallest correct diff for the current sub-phase — no scope creep into a later phase's work.
- Every change that touches `lib/`, `cli.mjs`, or `config/` updates `CODEBASE-ANALYSIS.md` in the same commit.
- Every commit updates `STATE.md`.
- Do not mark a task done without a passing checkpoint on a **live Workday URL**.
- Do not silently swallow errors — catch, log (URL + timestamp + stack), screenshot, close cleanly, surface to the operator/user.

## Production Phase specifics (only after Local Phase Gate passes)

- `qaStore.mjs` switches its backing store from local YAML to Supabase `qa_answers` — same interface, different persistence layer. Don't fork the module; parameterize it.
- All Telegram-facing text must never leak internal selectors, stack traces, or field IDs — plain language only (see `docs/ui-ux.md` §2.3).
- Every table access must respect per-user isolation — verify with at least 2 concurrent test users before considering a Production task done.
