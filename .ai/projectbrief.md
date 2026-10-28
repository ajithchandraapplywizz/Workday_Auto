# Project Brief: Workday Auto-Apply

## What This Is
Workday Auto is an enterprise-grade, local-first automation engine and management dashboard that automates end-to-end job application workflows on Workday ATS platforms (`*.myworkdayjobs.com`). It leverages Playwright for headless/headed browser control, performs live DOM scanning and verification at every wizard interaction, and resolves form questions via a hierarchical 4-tier answer engine backed by Supabase and OpenRouter LLMs.

## Target Users & Workflows
- **Apply Wizz Operators / Job Placement Specialists**: Ingest candidate batches via CSV (`cli.mjs batch`), manage daemon application queues (`scripts/queue_daemon.mjs`), and monitor job application throughput via the React dashboard.
- **Job Candidates**: Benefit from automated, high-fidelity applications with verified custom responses, accurate resume uploads, and zero hallucinated compliance answers.
- **AI Coding Agents & Developers**: Maintain, extend, and harden DOM interactions, tenant heuristics, and CRM synchronization while adhering strictly to zero-local-screenshot and no-auto-commit policies.

## Core Problem Solved
Workday job applications are notoriously long, repetitive, and technically complex—spanning multiple wizard steps, dynamic nested ARIA form structures, hierarchical referral dropdowns, spin calendars, custom demographic questionnaires, and strict validation gates. Manual submission takes 10–20 minutes per job, leading to human fatigue and errors. Traditional scrapers fail because Workday forms are highly dynamic and lack stable IDs. Workday Auto solves this with real-time DOM evaluation, adaptive option matching, tiered truth resolution, and automated verification loops.

## Hard Constraints (Non-Negotiables)
- **Zero Local Screenshots Policy**: Browser screenshots captured via Playwright MUST NEVER be written or saved to local disk or workspace folders (`screenshots/`, `data/`, `tmp/`). They must remain in-memory buffers (`const buf = await page.screenshot()`) and stream directly to cloud storage (Supabase Storage buckets `submitted-applications` or `failed-applications`). Existing local screenshots must remain untouched.
- **Git Workflow Policy**: AI agents MUST NEVER run `git add`, `git commit`, `git push`, or any automated commit commands. All staging and commits are strictly manual. Read-only git commands are permitted.
- **Workday Scope Only**: Exclusively targets Workday tenant domains (`*.myworkdayjobs.com`). Third-party platforms (Greenhouse, Lever, Taleo) are rejected.
- **Strict 4-Tier Answer Resolution Hierarchy**:
  1. *Tier 1 (Highest)*: Supabase Database (`client_questions`, `clients`, `client_additional_information`).
  2. *Tier 2*: Apply Wizz CRM API profile facts.
  3. *Tier 3*: Parsed PDF resume facts (skills, university, dates).
  4. *Tier 4*: Playwright Live DOM Options + LLM analysis (OpenRouter), immediately persisted back to Tier 1 upon resolution.
- **No Fabricated Compliance Answers**: Never hallucinate legal authorizations, EEO disclosures, disability status, or veteran identity.
- **DOM-Native Verification**: Never perform blind fills; all inputs must be asserted against the live DOM before triggering wizard advancement.

## Explicit Out of Scope
- Automated submission on non-Workday ATS platforms (e.g., BambooHR, Taleo, Greenhouse).
- Automated git commits, branch management, or deployment pushing by AI assistants.
- Storing unencrypted candidate PII in unsecured public logs or storing screenshots locally.
- Bypassing captchas or security challenges via unauthorized exploit tools (falls back to operator intervention or aborts cleanly).

## Input / Output Matrix

| Input Component | Description | Expected Output |
|---|---|---|
| **Job URL** | Direct Workday posting URL (e.g. `https://tenant.wd5.myworkdayjobs.com/...`) | Completed application submitted to Workday with confirmation ID |
| **Batch CSV** | Candidate ID and job link rows | Sequenced queue in Supabase `client_job_applications` table |
| **Apply Wizz CRM ID** | Unique applicant ID from CRM | Hydrated applicant profile, resume PDF, work history, and Q&A answers |
| **Live DOM Fields** | Dynamic Workday inputs (dropdown, radio, text, spin-date, checkbox) | Verified filled values conforming strictly to candidate evidence |
| **Submission Audit** | Application outcome (success or failure) | In-memory screenshot streamed to Supabase bucket + status update in Supabase DB |
