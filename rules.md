# Coding Rules & Behavioral Principles

This document defines the core behavioral principles and strict invariants governing all AI agents and engineers working in the Workday Auto codebase.

---

## The 4 Andrej Karpathy Principles (Adapted for AI Pair Programming)

### 1. Think Before Coding
- **Don't Assume**: Read existing files, configurations, and schemas before writing or editing code. Verify how a function or pattern works in the codebase rather than hallucinating an API.
- **Surface Tradeoffs**: When multiple approaches exist (e.g. DOM selector vs keyboard emulation), explicitly state the pros and cons.
- **Push Back on Complexity**: If a simpler pattern achieves the requirement, favor simplicity.
- **Stop and Ask When Unclear**: Never invent business rules, compliance logic, or credentials. If requirements are ambiguous, clarify before proceeding.

### 2. Simplicity First
- **Minimum Code That Solves the Problem**: Do not write unneeded helpers, premature abstractions, or single-use wrapper classes.
- **Nothing Speculative**: Implement strictly what is required for the current task. Do not add unused parameters or speculative "future-proofing".
- **Match Existing Idioms**: Use standard Node.js ES Modules (`.mjs`), Playwright async patterns, and existing project conventions.

### 3. Surgical Changes
- **Touch Only What You Must**: Keep diffs minimal, focused, and directly tied to the task.
- **Preserve Existing Working Code**: Do not conduct "drive-by refactoring" or reformats of adjacent, functioning code.
- **Clean Up Your Own Orphans**: If you replace a function or variable, clean up its unused imports and callers. Never leave orphan artifacts behind.
- **Preserve Documentation & Comments**: Maintain existing code comments and docstrings unless they are explicitly invalidated by your changes.

### 4. Goal-Driven Execution
- **Define Verifiable Criteria First**: Before modifying any code, know the exact command or assertion that proves the change succeeded (e.g., `npm test`, `npm run typecheck`, or running specific test suites).
- **Step-by-Step Execution Plan**: For multi-step tasks, lay out a clear plan with verification checks at every step.
- **Verify at Every Gate**: Never declare a task complete without running and verifying relevant tests and linters.

---

## Codebase-Specific Non-Negotiable Guardrails

### 1. Zero Local Screenshots Policy
- **Never Store Screenshots Locally**: NEVER save, write, or download screenshots to the local disk, workspace directories, or local folders (`screenshots/`, `data/`, `tmp/`).
- **In-Memory Buffer Only**: All browser screenshots captured via Playwright must be held strictly as in-memory buffers (`const buf = await page.screenshot()`) and streamed directly to cloud storage (Supabase Storage buckets `submitted-applications` or `failed-applications`).
- **Preserve Existing Screenshots**: Do NOT touch, delete, rename, or disturb any existing screenshots already present on local disk.

### 2. Git Workflow Policy
- **No Git Staging or Committing**: Never run `git add`, `git commit`, `git push`, or any automated commit commands.
- **Manual Control**: All Git staging, commits, and pushes must be handled manually by the human developer. Read-only commands (`git status`, `git diff`, `git log`) are permitted for inspection.

### 3. Workday DOM & Form Invariants
- **No Blind Fills**: Every form field interaction must be followed by DOM-level assertion (reading display text or input value).
- **Strict 4-Tier Resolution Hierarchy**: Supabase DB (Tier 1) -> Apply Wizz CRM (Tier 2) -> Resume Facts (Tier 3) -> Live DOM Options + LLM (Tier 4).
- **No Hallucinated Compliance Answers**: Never guess EEO, race, gender, disability, or veteran status. Missing answers must be flagged for review.
