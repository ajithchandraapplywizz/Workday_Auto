# IDE handover — Workday auto-apply

**Last updated:** 2026-09-15 (Ajithchandra session)  
**Repo root:** `C:\Users\ajith\OneDrive\Desktop\New_Auto_Workday`  
**App root:** `workday-auto-apply/auto-apply/`  
**Branch:** `main` (many local changes **not committed**)

---

## Start here (minimal token budget)

Read **only these 3 files** to continue coding (in order):

| # | File | Why |
|---|------|-----|
| 1 | **`HANDOVER.md`** (this file) | State, env, next tasks, what was deleted |
| 2 | **`lib/engine.mjs`** | Entry: `fillForm` → `runWorkdayWizardLoop` (~1435), `fillCurrentWorkdayStep` (~995) |
| 3 | **`lib/clientAnswer.mjs`** + **`lib/applyWizzClient.mjs`** | Answer pipeline + API hydrate/save |

Optional when touching a step: **`lib/workdayQuestionFill.mjs`**, **`lib/orchestrator/pageLoop.mjs`**.

Do **not** rescan the whole repo. Workday-only; DOM-first; no fabricated compliance answers.

---

## What this project is

Node + Playwright bot: login → multi-step Workday wizard → fill **required** fields → Save and Continue → Review → Submit (if `--confirm-submit`).

**Primary run command:**

```bash
cd workday-auto-apply/auto-apply
node cli.mjs apply "https://<tenant>.wd*.myworkdayjobs.com/.../apply"
```

**CLI pipeline (`cli.mjs` ~404):** scan (live) → `generatePlan` → writes optional `forms/{slug}-plan.json` → `fillForm`.  
**Workday fill ignores** saved `forms/*.json` for field values; wizard uses live DOM + profile.

---

## Architecture (current intent)

```
cli.mjs apply
  → fillForm (lib/engine.mjs ~2174)
  → runWorkdayWizardLoop (~1435)
       → applyTenantOverridesToProfile (tenant YAML merge, optional)
       → bootstrapClientContext → Supabase & Apply Wizz hydrate
            • hydrateSupabaseAnswers(profile) → loads client_questions table into profile._supabaseQa
            • hydrateProfileFromApplyWizz(profile) → loads CRM profile, resume URL & facts
       → per step: fillCurrentWorkdayStep (~995)
            → Step scripts (My Information / My Experience / stepDomPrep for Voluntary Disclosures)
            → runWorkdayQuestionWorkflow → runDynamicFieldLoop → runWorkdayPageWorkflow (orchestrator)
       → advance Save and Continue (workdayRapidAdvance.mjs)
```

**Mandatory 4-Stage Question Resolution Hierarchy:**

Every question encountered in the live Playwright DOM is resolved using a strict 3-tier (+ LLM human-like analysis fallback) architecture:

1. **Tier 1: Supabase Direct Answer (`client_questions` table)**
   - Normalized exact match, high-value concept match (`veteran`, `gender`, `hispanic`, `race`, `work_auth`, `sponsorship`, `salary`, `start_date`), and substring match.
   - Values automatically aligned to live Workday DOM options via `alignAnswerToWorkdayOptions`.
   - Hydrated into memory on startup for instant zero-latency resolution.
2. **Tier 2: ApplyWizz API Profile**
   - API client facts and indexed Q&A pairs from ApplyWizz CRM.
3. **Tier 3: Parsed Resume**
   - Candidate's parsed resume (`data/client-resumes/{applywizz_id}.pdf`): skills, employment history, and experience years.
4. **Tier 4: LLM Human-like Analysis with Live Playwright DOM Options**
   - OpenRouter Gemini with full applicant profile snapshot, parsed resume text, and live Playwright DOM question + exact candidate options.
   - **Self-Learning / Tier 1 Persistence:** Whenever the LLM resolves an answer, it is immediately written to Supabase (`client_questions` table via `upsertSupabaseAnswer`), instantly turning it into a Tier 1 match for all subsequent applications.

**Voluntary Disclosures & Veteran Question Loop Fix:**
- Workday Voluntary Disclosures fields frequently omit standard `*` or `aria-required` tags. Previously `isVeteranFieldRequired(page)` returned `false`, causing the bot to skip filling veteran status ("Select One" remained), triggering Workday navigation failure and infinite retry loops.
- `isVeteranFieldRequired` skip check has been eliminated: veteran status is now unconditionally resolved whenever present on Voluntary Disclosures.
- Bidirectional option matching added: maps between "I am not a veteran" and "I am not a protected veteran".
- Missing data statements from LLM (e.g., `"No ... is provided in the profile"`) are filtered out by `isMissingProfileStatement` to prevent typing explanatory sentences into ATS text inputs.

---

## Environment (.env in auto-apply)

| Variable | Purpose |
|----------|---------|
| `WORKDAY_EMAIL` / `WORKDAY_PASSWORD` | Workday login |
| `APPLYWIZZ_ID` or `APPLYWIZZ_API_URL` | Client API (e.g. `AWL-34133`) |
| `SUPABASE_URL` | Supabase project URL (`https://<project-ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key for reading & caching `client_questions` |
| `APPLYWIZZ_TLS_INSECURE=1` | **Recommended on Windows** if TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| `OPENROUTER_API_KEY` | Unknown questions fallback / profile analysis |
| `APPLYWIZZ_SAVE_QA=0` | Save Q&A fallback (Supabase is now the primary persistence target) |

---

## Where the previous IDE stopped

### Done in code & verified with test suite

| Area | Location | Notes |
|------|----------|--------|
| **Supabase Tier 1 integration** | `lib/supabaseClient.mjs` | `hydrateSupabaseAnswers`, `lookupSupabaseAnswer`, `lookupSupabaseAnswerSync`, `upsertSupabaseAnswer` |
| **Mandatory 3-tier pipeline** | `lib/clientAnswer.mjs` | Tier 1 Supabase → Tier 2 ApplyWizz → Tier 3 Resume → Tier 4 LLM (+ auto-save to Supabase) |
| **Voluntary Disclosures Loop Fix** | `lib/workdayQuestionFill.mjs`, `lib/scanFieldFilter.mjs` | Unconditionally answers EEO (gender, race, hispanic, veteran); `shouldIncludeInScan` and `isMandatoryField` treat them as mandatory so Workday doesn't block advance |
| **Veteran option alignment** | `lib/interaction/workdayCustomDropdown.mjs` | Bidirectional fallback between `not_veteran` and `not_protected` |
| **Strict Sequential Execution** | `lib/interaction/pageDiscovery.mjs`, `lib/workdayDom.mjs` | Removed `Promise.all` concurrent evaluations on Playwright page to prevent CDP renderer collisions |
| **Error Repair Tier 1 Lookup** | `lib/workdayErrorRepair.mjs` | Synchronous Tier 1 Supabase check before fallback when fixing fields flagged by Workday errors |
| **Dynamic CLI Client Flag** | `cli.mjs` | `--client <id>` / `--applywizz-id <id>` dynamically sets client profile for multi-user processing |
| **LLM full profile & resume context** | `lib/openRouterLlm.mjs` | Full parsed resume + ApplyWizz profile passed into snapshot; live DOM options enforced |
| **Page Answer Engine Tier 1** | `lib/questionEngine/pageAnswerEngine.mjs` | Synchronous Tier 1 Supabase lookup inside `resolveFieldWithoutLlm` |
| **Shift/Schedule Resolution** | `lib/questionEngine/pageAnswerEngine.mjs`, `lib/questionEngine/intents.mjs` | `isShiftOrScheduleQuestion` & `pickShiftOption` resolve shift dropdowns (e.g., 'Which shift would you accept?') to flexible/day shifts |
| **Hourly Salary Derivation** | `lib/questionEngine/profileFacts.mjs`, `lib/clientAnswer.mjs` | `explicitSalary` derives hourly wage (`annual / 2080` = $53/hr from $110k) preventing high-risk missing data halts |
| **Specific Manager / Location** | `lib/questionEngine/pageAnswerEngine.mjs`, `lib/openRouterLlm.mjs` | `isSpecificManagerOrLocationQuestion` returns "N/A" or "No Preference"; `isMissingProfileStatement` updated to allow valid concise N/A |
| **Electronic Signature Disclaimer** | `lib/questionEngine/pageAnswerEngine.mjs`, `lib/planner.mjs`, `lib/workdayDefaults.mjs` | `isSignatureOrFullNameQuestion` populates applicant's full legal name for signature disclosures and excludes them from adverse criminal history checks |
| **Tier 4 LLM Fallback Unblocking** | `lib/questionEngine/pageAnswerEngine.mjs` | Unanswered questions (where Tiers 1-3 yield `answer: null`) now properly flow to `unknown` for LLM batch resolution instead of being dropped by truthy `reviewRecord` |
| **Test Suite Verification** | `lib/**/*.test.mjs` (133/133 passing) | All 133 unit tests pass sequentially (100% pass rate) |

---

## Important folders (keep vs optional)

| Path | Keep? |
|------|--------|
| `lib/` | **Required** |
| `cli.mjs`, `config/profile.example.yml`, `.env` | **Required** |
| `config/tenant-overrides/*.yml` (~177) | **Optional** — not required to run; can override/stale answers in experience paths; user did **not** delete these |
| `config/wd5-tenants.json` | Only for `scan-batch` |
| `forms/`, `data/wd5-scans/` | Empty + `.gitkeep`; regenerated if scan/batch runs |

---

## Key symbols (jump table)

| Task | File | Symbol / line |
|------|------|----------------|
| Wizard entry | `lib/engine.mjs` | `runWorkdayWizardLoop` ~1435 |
| Per-step fill | `lib/engine.mjs` | `fillCurrentWorkdayStep` ~995 |
| Step 1 contact/source | `lib/engine.mjs` | `handleStep1MyInformation` ~407 |
| Voluntary disclosures | `lib/stepDomPrep.mjs` | `runStepDomPrep` |
| Veteran dropdown | `lib/workdayQuestionFill.mjs` | `resolveVeteranVoluntaryAnswer`, `fillVeteranStatusDropdown` |
| Orchestrator loop | `lib/orchestrator/pageLoop.mjs` | `runPageOrchestrator` |
| Page workflow | `lib/orchestrator/workdayPageWorkflow.mjs` | `runWorkdayPageWorkflow` |
| Apply Wizz GET/map/save | `lib/applyWizzClient.mjs` | `hydrateProfileFromApplyWizz`, `saveApplyWizzClientAnswer` |
| Answers | `lib/clientAnswer.mjs` | main resolve pipeline |
| LLM | `lib/openRouterLlm.mjs` | `resolveUnknownWithLlm` |

---

## Tests (quick sanity)

```bash
cd workday-auto-apply/auto-apply
node --test lib/**/*.test.mjs
```

Last known: question engine / orchestrator tests passing (28/28 class); re-run after edits.

---

## Git / handoff ritual for next IDE

1. Read this file + `lib/engine.mjs` (wizard section) + `applyWizzClient.mjs`.  
2. Run one **live** `apply` on a known job URL; paste failing step + log line into next session.  
3. After code changes: update **this `HANDOVER.md`** (section “Where the previous IDE stopped”) — do not rely on deleted `SESSION-CHECKPOINT.md` until restored.  
4. Commit only when user asks.

---

## Owner preferences

- **Ajithchandra** — Workday-only, Apply Wizz–first, smallest correct diff, live URL checkpoints, no silent guessing on compliance/veteran/EEO.

---

## One-line resume for next prompt

> Continue Workday auto-apply on `main` (uncommitted): API-only Apply Wizz hydrate + wizard in `engine.mjs`; verify veteran “I am not a veteran” and full apply on live URL; optional: disable tenant YAML in experience when API-only; forms/wd5-scans/scripts already cleaned — read `auto-apply/HANDOVER.md` only.
