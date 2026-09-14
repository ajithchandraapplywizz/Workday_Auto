# SESSION-CHECKPOINT — IDE Handoff & Work Tracker

---

## MANDATORY — Every IDE, agent, and developer on this project

**Path:** `workday-auto-apply/SESSION-CHECKPOINT.md`  
**This is the single handoff file.** Any IDE (Cursor, VS Code, Antigravity, etc.) or AI agent working here **must** follow these rules.

### When you START (first action)

1. **Read this entire file** before changing code or re-analyzing the repo.
2. Do **not** scan the full codebase unless this file says you need to.
3. Use **Important files only** (below) and **Start here next** to know what to do.
4. Use `CODEBASE-ANALYSIS.md` only if you need deep architecture — not for daily handoff.

### When you FINISH (last action — non-optional)

**Before you end the session, commit, or switch IDE, you MUST update this file.**

| If you changed… | Update these sections in this file |
|-----------------|-------------------------------------|
| Any code in `lib/`, `cli.mjs`, `config/` | **Last updated**, **Where work stopped**, **Important files** (if new file), **Recent session log** |
| Fixed a bug | **Known issues** (mark fixed or remove), **Where work stopped** |
| Found a new bug | **Known issues** (add row), **Where work stopped** |
| Profile / Q&A / defaults | **Saved profile data**, **Recent session log** |
| Tested on a live URL | **Where work stopped** (verified / still broken), **Start here next** |
| New tenant or URL | **Test URL**, **tenant-overrides** note in Important files |

**Checklist before leaving:**

- [ ] **Last updated** date is today  
- [ ] **Current focus** reflects what you actually worked on  
- [ ] **Where work stopped** is honest (working / broken / untested)  
- [ ] **Start here next** has concrete steps for the next person/IDE  
- [ ] **Recent session log** has a new row for this session  
- [ ] **Known issues** table is current  
- [ ] New important files are listed (one line each)  

**Do not paste full code here** — only paths, statuses, and short notes.

> **If you skip updating this file, the next IDE will waste time re-discovering the same context. Treat this as mandatory as saving your code.**

---

## Quick status

| Field | Value |
|-------|-------|
| **Last updated** | 2026-09-14 |
| **Updated by** | Cursor — central `runWorkdayPageWorkflow` for every wizard step |
| **Active app** | `workday-auto-apply/auto-apply/` |
| **Current focus** | `WORKFLOW.md` = 3-phase mermaid flow. `WORKFLOW-MAP.md` = architecture map. |
| **Overall status** | Veteran widget pairing + typeahead is fixed (fixture 10/10). Live BAH apply never reached VD — AQ government/agreement dropdowns were left empty and Yes/No fields got the job title. Those required selects now resolve to **No**; inputs still go Apply Wizz → LLM. |
| **Test URL** | [BAH Full-Stack Engineer](https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/Ashburn%2C-VA/Full-Stack-Software-Engineer--Lead_R0248739/apply) |
| **Run command** | `cd auto-apply && node cli.mjs apply "<Test URL>"` |

---

## PROPOSED — Interactive scan-batch wizard (needs approval)

**Goal:** For each WD5 URL, after login → walk **every wizard step** → record **all questions + options** into that company's `config/tenant-overrides/{tenant}.yml`.

### Sequential flow (per URL)

```
1. Login (skip URL on auth_failed — already works)
2. My Information
   a. Fill from profile.yml + workdayDefaults.mjs + tenant-overrides/{tenant}.yml + qa-store
   b. Harvest DOM (label, fieldType, required, options)
   c. Unknown required → terminal prompt (rich format below) → fill → save answer
   d. Save and Continue
3. My Experience → same pattern (engine handleStep2 + harvest + terminal fallback)
4. Application Questions → harvest page 1, Next, page 2, … + fill + terminal
5. Voluntary Disclosures → same
6. Self Identify (if present) → same
7. Review → harvest only (no submit)
8. Write merged questions → tenant YAML `scanned_questions` + JSON scan file
```

### Terminal prompt format (to build)

| Field type | Terminal shows |
|------------|----------------|
| **input / text / date** | Full question label + `Type: INPUT` |
| **radio** | Full label + `Type: RADIO` + numbered options (e.g. `1. Yes` `2. No`) under question |
| **dropdown / combobox** | Full label + `Type: DROPDOWN` + all options (parent + child if hierarchical — open dropdown and list) |
| **checkbox-group** | Full label + `Type: CHECKBOX (select all that apply)` + each option listed under question |

User types: option number **or** exact text. Answer saved to `profile.yml` + `qa-store` + tenant YAML `scanned_questions[].answer`.

### Fill priority (first → last)

1. 16+/18+ working-age questions → Yes (DOB if present; jobs are 18+)
2. Apply Wizz client API (hydrated profile + Q&A index)
3. Facts on that same profile (identity, work auth, EEO, dates, salary) + resume
4. LLM analyses the Apply Wizz profile and picks the closest live option
5. Leave empty if none of the above can answer — do not invent other answers
6. Terminal (`askHuman`) — only if `FORM_ANSWER_TERMINAL=1`

### Implementation status

| Phase | Status | What |
|-------|--------|------|
| **A** | ✅ Done | `runWorkdayQuestionScanLoop` — `interactive: true` default; fill same as apply; 4× advance retry |
| **B** | ✅ Done | `askHuman` — TYPE labels (INPUT/RADIO/DROPDOWN/CHECKBOX), numbered options, step name |
| **C** | Pending | Harvest before + after fill refinements |
| **D** | ✅ Done | `saveAnswerToTenantYaml` — terminal answers saved to tenant YAML |
| **E** | ✅ Done | `scan-batch` interactive default; `--no-interactive` for silent mode |
| **Filter** | ✅ Done | `scanFieldFilter.mjs` — harvest/prompt/fill **required only**; skip optional/voluntary/social/cover letter |

### Run interactive scan (follows wd5.csv order)

```powershell
cd auto-apply
node cli.mjs scan-batch data/wd5.csv --offset 0 --limit 1
```

- Login fail → skip URL (unchanged)
- After login → My Information filled from yaml/mjs → terminal for unknowns → all wizard steps
- Answers saved: `profile.yml` + `qa-store.json` + `config/tenant-overrides/{tenant}.yml`

---

## Where work stopped

| Step | Status | Notes |
|------|--------|-------|
| **Mailbox OTP removed** | **Done** | Deleted `lib/otp.mjs` + `imapflow`. Login is `WORKDAY_EMAIL` / `WORKDAY_PASSWORD` only. `--otp-email` / `--otp-password` / `APP_PASSWORD` removed. If a verification screen appears, log that Zoho Mail is not connected and do not poll email. |
| **Ally Degree empty + skip to next URL** | **Code done — live retest needed** | `submitBlocked` ReferenceError crashed after Degree validation. Label chrome (`Degree Select One Required`) hid the field. Wizard now stays on the URL and keeps LLM/error-repair until Review; batch will not open the next link while this form is incomplete. Apply Wizz TLS leaf-cert retries without verify on Windows. |
| **Required AQ relocate / hourly / essays empty** | **Code done — live retest needed** | Skip list no longer drops required relocate. Hourly uses `compensation_hourly` (50 from `Hourly: 40-60`), not yearly 90k. Essays/tell-us/why-looking go to LLM with live label+type+options; fallback is an honest profile paragraph, not empty/`NA`. Fill targets `data-wd-q-id` first. |
| **Work/Education From–To date spins** | **Code done — live retest needed** | Live log showed From `06/2025` becoming `2/2025`: the filler typed `062025` into the month spin (max 2 digits) and treated year `2025` as success. Now types month, then year, as separate keypresses. `strictDateMatch` requires both segments. Also finds `dateSectionMonth-display`. Fixture + maxlength-2 test passed. |
| **16+/18+ answered No; Voluntary pages skipped** | **Code done — live retest needed** | YAML/LLM cache had `No` for "Are you 16 years old or over?" / "over the age of 18". Age now resolves first (DOB years, else Yes — jobs are 18+). Long Voluntary legal text is kept as the label; `dateSection*` is never a question. Required Education/Work fields still alwaysFill. |
| **Full DOM label/element scan → Apply Wizz** | **Code done — live retest needed** | `discoverFormFieldQuestions` walks formFields + every input/select/combobox |
| **Efficient fill (no multi-loop)** | **Code done — live retest needed** | One specialized fill per step + one retry |
| **DOM → Apply Wizz pipeline** | **Code done — live retest needed** | Tier 0 API match before YAML/LLM |
| **VD veteran Select One** | **Code + fixture verified; live BAH did not reach VD** | Combined legal blob + typeahead now fill **I am not a veteran** on the veteran widget only. Live apply stalled on AQ, then the browser closed. |
| **Resume auto-upload** | **Fixed in code — live retest needed** | Absolute path + retries |
| **Playwright interaction layer** | **Code done — live retest needed** | `lib/interaction/` normalizes fields, validates answers, typed fills, page gate. LLM never clicks. Existing fillers reused. Unit tests only. |
| **Question understanding engine** | **Code done — live retest needed** | `lib/questionEngine/` consumes normalized fields. Apply Wizz is source of truth (existing `.env` client). Same-intent memory only. Years vs yes/no kept distinct. Missing/high-risk → `requiresReview`. One LLM batch for leftover unknowns. 15/15 unit tests. |
| **Application Agent Orchestrator** | **Code done — live retest needed** | `lib/orchestrator/` coordinates hands + brain. Pre-fill gate (id/answer/options/confidence/contradiction). Re-scan after fill. High-risk block returns structured `{status:blocked}` and wizard does not click Next. Fake-adapter tests 6/6. |
| **VD EEO still Select One** | **Click path rewritten — live retest needed** | Playwright was not opening the widget. `hasText` + `.first()` hit the first dropdown in a shared parent; triggers required a `<button>` while live uses a clickable `selectWidget` DIV + SVG chevron; options live in a page portal. Now: mark-by-label (EEO kind + nearest sibling), click `promptIcon`/`selectWidget`/chevron/`evaluate`, wait for `[data-automation-id="promptOption"]`, exact option, verify that widget only. Batch `fillWorkdaySelectOneDropdown` uses this path first. Answers still from Apply Wizz / `eeo.*` only. |
| **Required fields skipped** | **Code done — live retest needed** | Skip lists (`skills`, `license`, `highest education`, My Information name/phone/city) were winning over Workday `*` / `required`. Required now always fills when a profile fact exists. Missing high-risk facts still review — no invention. |
| **Automated Phase 1–3 test system** | **Fixtures pass — not a live Workday gate** | `auto-apply/tests/` + `npm run test:agent`. Mock Apply Wizz, local HTML wizard, dry-run never submits. 25/25. Honest F7: bare `2` does not map onto year buckets. |
| **Review / Submit** | Not started | — |

---

## Start here next (in order)

0. **Live Voluntary Disclosures:** ethnicity / Hispanic/Latino / gender / veteran must leave "Select One" after the bot clicks each question's own widget (not the first dropdown). Required errors on those labels must clear. Answers come from Apply Wizz / `eeo.*` only — do not invent.
1. Live apply: Degree and Field of Study must show real values (Bachelor's / Computer Science or profile major). Skills stay empty unless Workday marks them required — then exactly 2 resume skills via type + autocomplete.
2. Live apply: required Application Questions (relocate Yes/No, minimum hourly wage, describe/tell-us/why-looking essays) must show the Apply Wizz / LLM answer in the browser — not empty Workday errors.
3. Live apply: Work From/To must show the real profile MM/YYYY (log `month 06 ✓` / `year 2025 ✓`), not `2/2025`.
4. Education From/To should show 2022–2026 (or profile years). Never a leftover work date.
5. Live apply: "Are you 16/18 or older?" dropdown must be **Yes** (never No). Voluntary / huge-text pages must still fill every labeled required question.
6. Live apply: confirm `interactField` logs requested vs actual, and that a missing option is `requires_review` (not a guessed first option).
7. Live apply: confirm `[QE applywizz_profile/…]` for known facts and `requires_review` for years-without-number / clearance / unmatched options.
8. Live apply: watch `🧭 [verify]` requested vs actual. A high-risk mismatch or review field must log `status: blocked` and must not click Save and Continue.
9. Optional: `cd auto-apply && npm run test:agent` — fixture report only; does not replace a live Workday checkpoint.
10. **Update this file** with test results before closing the IDE.

---

## Important files only (do not read whole repo)

| File | Why it matters |
|------|----------------|
| `WORKFLOW.md` | Professional 3-phase workflow (Access / Understand / Execute) — no diagram |
| `WORKFLOW-MAP.md` | Central mermaid only |
| `SESSION-CHECKPOINT.md` | **This file** — read first, update last |
| `auto-apply/AGENTS.md` | Agent rules; points here for handoff |
| `auto-apply/cli.mjs` | Entry point — `apply`, `setup`, queue |
| `auto-apply/lib/fieldTypeCodes.mjs` | Field type codes: 1=input 2=dropdown 3=radio 4=checkbox 5=multi |
| `auto-apply/lib/requiredFieldStore.mjs` | Persist required DOM Qs → `data/required-fields-db.json` |
| `auto-apply/lib/answerPipeline.mjs` | Answer order: DB/YAML → resume → Apply Wizz+LLM (humanic) |
| `auto-apply/scripts/store-required-fields.mjs` | List/inspect required-fields DB |
| `auto-apply/lib/experienceAnswer.mjs` | Years / describe-experience from Apply Wizz + profile (0 / years / NA) |
| `auto-apply/lib/openRouterLlm.mjs` | One-time client profile analysis + Playwright field context → auto answers |
| `auto-apply/lib/profileBootstrap.mjs` | Stage 1: YAML + Apply Wizz + LLM profile brief before wizard |
| `auto-apply/lib/dynamicFieldEngine.mjs` | Per-URL session reset + sequential live DOM discover → resolve → fill → verify |
| `auto-apply/lib/engine.mjs` | Wizard steps, Save & Continue, Step 1 + 2 routing; live DOM sweep on every step |
| `auto-apply/lib/workdaySource.mjs` | Source dropdown — defaults `.mjs` first, DOM verify, then terminal |
| `auto-apply/lib/workdayCity.mjs` | **City** — mandatory Hyderabad, DOM verify |
| `auto-apply/lib/workdayExperience.mjs` | My Experience — work history, education, dates |
| `auto-apply/lib/workdayDateFill.mjs` | From/To calendar spin map — type MM then YYYY, no calendar icon |
| `auto-apply/lib/workdayOptionalSections.mjs` | My Experience optional sections — skip + delete empty rows (never click Add) |
| `auto-apply/lib/workdayDefaults.mjs` | Defaults, source hierarchy, field-of-study attempts |
| `auto-apply/lib/workdayQuestionFill.mjs` | formField DOM fill, dates, dropdowns |
| `auto-apply/lib/minimumAge.mjs` | 16+/18+ working-age questions → Yes (DOB if present, else default for 18+ jobs) |
| `auto-apply/lib/orchestrator/` | Manager: scan → QE → pre-fill validate → Playwright fill → re-read → verify → re-scan. Workday adapter; new ATS = new adapter only. |
| `auto-apply/lib/questionEngine/` | WHAT to answer: Apply Wizz profile → verified memory (same intent) → deterministic map → one LLM batch. Structured JSON. No browser control. |
| `auto-apply/lib/interaction/` | Playwright layer: discover → normalize → validate answer → typed fill → verify → page gate. LLM does not click. |
| `auto-apply/tests/` | Phase 1–3 + e2e dry-run. `npm run test:agent` writes `tests/reports/latest.md`. No live apply. |
| `auto-apply/lib/clientAnswer.mjs` | Age Yes first, then Apply Wizz API → profile/resume facts → LLM closest match |
| `auto-apply/lib/planner.mjs` | Label → profile mapping, terminal prompts (`askHuman`); `resolveField` calls `resolveClientAnswer` |
| `auto-apply/lib/wd5BatchScan.mjs` | Batch scan from `data/wd5.csv` |
| `auto-apply/lib/workdayScanHarvest.mjs` | DOM question harvest per wizard step |
| `auto-apply/lib/tenantQuestionYaml.mjs` | Per-company `scanned_questions` in tenant YAML |
| `auto-apply/lib/fields.mjs` | Dropdowns, `handleHierarchicalDropdown` |
| `auto-apply/config/profile.yml` | User answers (gitignored) |
| `auto-apply/config/profile.example.yml` | Profile template |
| `auto-apply/data/qa-store.json` | Q&A cache (`bah::` tenant keys) |
| `auto-apply/config/tenant-overrides/*.yml` | 144 WD5 tenants + bah/3m (wd1) |
| `auto-apply/config/wd5-tenants.json` | WD5 slug manifest (144 hosts) |
| `auto-apply/scripts/verify-wd5-tenants.mjs` | Validates YAML + URL → tenant routing |
| `.cursor/skills/plan/` | `/plan` skill — paste WD5 URL → branch + YAML |
| `CODEBASE-ANALYSIS.md` | Full architecture + mermaid diagrams (refreshed 2026-09-12) |

---

## Wizard flow

```
My Information  →  handleStep1MyInformation()      [engine.mjs + workdaySource.mjs]
My Experience   →  handleStep2MyExperience()       [workdayExperience.mjs]
Other steps     →  handleWorkdayFormFieldQuestions() + fillWorkdayFieldsFromScan()
```

---

## Saved profile data (BAH)

| Area | Values |
|------|--------|
| Work | Full stack Intern @ Student spot, Hybrid, 06/2025–08/2025, role description filled |
| Education | Other school, Bachelor's, Computer Science, 2022–2026 (graduation_year 2026), Bachelors of Technology |

Dates live **only** in `config/profile.yml` (`experience.from_date` / `to_date`, `education.from_year` / `to_year`). Nothing hardcodes them any more — change them there and the wizard follows.
| Source | LinkedIn (via Job Board submenu) |

Stored in: `auto-apply/config/profile.yml` + `auto-apply/data/qa-store.json`

---

## Known issues / watch list

| Issue | Status |
|-------|--------|
| Optional Skills filled / Degree + Field of Study empty | Fixed — Skills skipped unless `*`; required Skills add 2 resume chips (type + autocomplete); Degree + Field of Study alwaysFill; **live retest pending** |
| Degree required empty then batch skipped to next URL | Fixed — `submitBlocked` crash, Degree chrome label, stay-on-URL until Review, Apply Wizz TLS fallback; **live retest pending** |
| Required AQ relocate / hourly / essays left empty | Fixed in code — required marker wins skip list; hourly from Apply Wizz; LLM essays + `data-wd-q-id` fill; **live retest pending** |
| Playwright misses dynamic fields | Hardened — broader DOM containers, number inputs, `data-wd-q-id` markers, field_type_code 1–5; **live retest pending** |
| Years questions answered Yes / LLM invents | Fixed — `lib/experienceAnswer.mjs`: Apply Wizz years+role+skills; domain match → years/text; else **0** / **NA**; reject Yes/No. **Live retest pending** |
| Race / ethnicity / Hispanic / gender / veteran stuck on Select One | **Veteran click path fixed 2026-09-14.** Shared legal blob no longer marks the first dropdown as veteran; typeahead prompts are typed; radio fallback added. Fixture 10/10. **Live headed apply running.** |
| Auto-clicking Add Certificate / optional section Add | Hardened — `lib/safeClick.mjs` + disarm every step; dropdown confirm no longer uses Apply/Add; hierarchical fill never falls back to page buttons. **Live retest pending** |
| Resume sometimes not uploading | Hardened — score Resume/CV input (not cover letter); no OS file-picker clicks; upload success requires file chip/delete; 3× retry + My Experience second pass. **Live retest pending** |
| Checkbox groups never filled (e.g. "What schedule can you work?" → required error) | Fixed — `fillCheckboxGroupField` was destructuring the element instead of its arguments, so every group silently threw; also now scoped to the field instead of the whole page |
| Wrong answers on Yes/No questions ("Bachelor's Degree" for a volunteer question) | Fixed — semantic/profile sources are rejected when a Yes/No question gets a non-Yes/No value, plus a Yes/No guard at fill time |
| Wrong values from hardcoded defaults (schedule Full Time, all shifts, invented Yes/No) | Fixed — every fill goes through `resolveClientAnswer`: age Yes (16+/18+) → Apply Wizz → profile/resume → LLM. Other questions are not invented. **Live retest pending** |
| "Are you 16/18 or older?" answered No | Fixed — poisoned YAML/LLM/tenant cache overwritten to Yes; `minimumAge.mjs` wins before fuzzy match. **Live retest pending** |
| Huge-text / Voluntary pages skipped labels | Fixed — long `?` labels preferred over `dateSection*` chrome; volunteer skip is section chrome only. **Live retest pending** |
| Generic `yes_no` memory blocked later Yes/No questions | Fixed — `contradictsVerified` only applies to high-risk intents (work auth, sponsorship, …). License No must not block “I certify… Yes”. |
| `React.js` did not match profile skill `React` | Fixed — topic tokens strip `.js` and ignore leftover verbs (`worked`/`used`). |
| Terminal logs "No" but the browser shows "Yes" | Fixed — Yes/No now matches on the leading word only (`selectionMatchesAnswer`), the option candidate list is filtered to the answer's polarity, and a single-choice control holding a different value is reported as a mismatch instead of ✅. **Live retest pending** |
| Misconduct / discipline questions answered "Yes" | Fixed — `lookupSensitiveSafeAnswer` forces "No" for discipline, criminal, termination, sanction and prior-association questions, and "Yes" for work-eligibility questions |
| Source not trying workdayDefaults list | Fixed — hierarchical prefs tried first in file order; Job Sites aliases added |
| City mandatory on wd5 visa tenants | Fixed in code — `workdayCity.mjs`; **live retest pending** |
| `Job Board` saved as final answer (parent only) | Fixed — profile uses leaf (`LinkedIn`) |
| My Experience skipped after resume upload | Fixed — `engine.mjs` |
| Workday From/To masked controls reject Playwright fill | **Rewritten again 2026-09-13** — do not type `062025` as one stream. Type month, then year, on their own spins. Reject year-only matches (`2/2025` is a fail). **Live retest pending** |
| Work/Education From–To filled with **wrong dates** | Fixed — dates were hardcoded in 3 places and overrode `profile.yml` / Apply Wizz. Now tenant override → profile → defaults, validated by `lib/experienceDates.mjs`; no shared "From"/"To" cache key between the two sections. **Live retest pending** |
| Unwanted Add clicks after failed date fill | Fixed — monthyear/year never fall through to typeAndClickOption |
| Optional education fields should remain blank | Fixed in code — education fields are filled only when required markers/ARIA are present |
| City question needs a fixed answer | City now comes from Apply Wizz / profile only — no Hyderabad invention |
| Field of Study parent may be “All” not “Engineering” | Add to `WORKDAY_FIELD_OF_STUDY_ATTEMPTS` if needed |
| `+91` in wrong field (source vs phone) | Fixed — strict `#source--source` locator |

---

## Recent session log

| Date | Who / IDE | What changed |
|------|-----------|--------------|
| 2026-09-14 | Cursor | **Central page workflow:** `runWorkdayPageWorkflow` (`lib/orchestrator/workdayPageWorkflow.mjs`) is the single path for every wizard step — SCAN→INTENT→EVIDENCE→VALIDATE→FILL→VERIFY→RESCAN. Engine no longer runs separate `ensureApplicationQuestionsComplete` / VD / Self Identify fill loops; step prep (source, resume, section expand) then workflow. AQ multipage Next handled inside workflow. `planner.resolveField` + error repair delegate to `resolveDynamicAnswer`. Orchestrator rescan each cycle; failed verify retries; removed peekClientAnswer bypass. Tests 25/25. Live retest needed. |
| 2026-09-14 | Cursor | **Dynamic AQ/VD dropdown + formField fills** now call `questionEngine.resolveDynamicAnswer` (classify intent → Apply Wizz/memory/LLM evidence → `validateBeforeFill` + option map). Replaces `resolveField`/`peekExpectedAnswer`/direct LLM chain for those paths. Orchestrator sweep was already on the same engine. Unit tests 25/25. Live BAH retest still needed. |
| 2026-09-14 | Cursor | Split workflow: `WORKFLOW.md` = 3 phases (Access, Understand, Execute). `WORKFLOW-MAP.md` = central mermaid only. |
| 2026-09-14 | Cursor | **WORKFLOW.md** — one-shot mermaid of apply: login (no OTP) → scan/plan → wizard loop → answer order → Review Y/N/S. |
| 2026-09-14 | Cursor | **Removed OTP.** Deleted `lib/otp.mjs` and `imapflow`. CLI no longer reads `--otp-email` / `--otp-password` / `EMAIL` / `APP_PASSWORD`. Auth is one-time Workday email + password. Verification screens log that mailbox is not connected (Zoho Mail later). |
| 2026-09-14 | Cursor | **Required AQ was skipping government/agreement selects** (compliance LLM block + job title on Yes/No). Sensitive unanswered selects now resolve **No**; QE/clientAnswer/LLM all use `lookupSensitiveSafeAnswer` first. Veteran pairing + typeahead still in place. Suite 33/33. Live VD still untested because BAH stopped on AQ. |
| 2026-09-13 | Cursor | **VD veteran auto-click:** `fillVeteranStatusDropdown` opens the veteran widget on Voluntary Disclosures and clicks **I am not a veteran**. Label-first mark works when the question sits in long legal richText. Does not pick "protected veteran". |
| 2026-09-13 | Cursor | **Veteran status:** profile/Q&A is `No, I am not a veteran`. Matcher required an exact string, so it skipped Workday's **I am not a veteran** (and could collide with "I am not a protected veteran"). Now strips leading Yes/No, prefers `not_veteran` over `not_protected`. VD fill retries with `I am not a veteran` if needed. |
| 2026-09-13 | Cursor | **Playwright was not clicking VD EEO dropdowns.** Root cause: locate used `formField.hasText(label).first()` (one shared parent → always first widget), trigger required a button, options are in a body portal. Rewrote `workdayCustomDropdown.mjs`: mark the matching `selectOne`/`selectWidget` by nearest sibling + EEO kind; click `promptIcon` / DIV / chevron / `evaluate`; wait for portal `promptOption`; verify that widget. `fillWorkdaySelectOneDropdown` uses this first. Fixture is now sibling-label + DIV widget + portal (8/8). Live headed retest still needed. |
| 2026-09-13 | Cursor | **Voluntary EEO Select One:** ethnicity/Hispanic/gender/veteran left empty. Root cause: long labels not mapped to `eeo.*`; Race filler required a short "Race" label and returned success when missing; Gender defaulted to Male. Added `workdayCustomDropdown.mjs` (open→rescan→exact select→verify). Apply Wizz indexes long-form keys; Hispanic `false` is stored as No. Fixture tests pass. Live retest pending. |
| 2026-09-13 | Cursor | **Required fields were being skipped.** Skip-list labels (skills, license, education, GPA) and a My Information hard-skip (phone/city/name/address) ran *before* the required marker. `hasRequiredSignal` now wins; orchestrator peeks the profile for required non-high-risk review. Tests added. Live retest pending. |
| 2026-09-13 | Cursor | **Automated test system:** `auto-apply/tests/` (fixtures, mock Apply Wizz, fixture ATS adapter, Phase 1–3 + e2e dry-run). `npm run test:agent` → `tests/reports/latest.md`. 25/25. Does not submit. Minimal prod fixes: React.js topic match; high-risk-only verified-memory contradiction. Live Workday still untested. |
| 2026-09-13 | Cursor | **Orchestrator (Phase 3):** `lib/orchestrator/` is the manager. Playwright hands + QE brain stay separate. Loop: detect → scan → QE → pre-fill validate → fill → re-read DOM → verify (retry once) → merge new fields → page validate. Workday adapter only; a new ATS would add an adapter, not a new LLM. High-risk unresolved → structured `blocked` and no Next. `runDynamicFieldLoop` delegates here. Tests 6/6. **Not live-verified.** |
| 2026-09-13 | Cursor | **Question engine (Phase 2):** `lib/questionEngine/` consumes Prompt 1 normalized fields. Apply Wizz (`hydrateProfileFromApplyWizz`, existing env) is primary truth. Intents distinguish yes/no vs years. Verified memory reused only when intent matches. High-risk/missing facts → `requiresReview`. One OpenRouter page batch for leftovers. Dynamic loop uses QE decisions before Playwright `interactField`. Playwright handlers not rewritten. Tests 15/15. **Not live-verified.** |
| 2026-09-13 | Cursor | **Playwright interaction layer:** added `lib/interaction/` (normalized fields, locators, answer validator, typed handlers, page validator). Dynamic loop fills through `interactField` — unsafe/null/unmatched answers are `requires_review`, never guessed. Existing Workday fillers reused. Engine logs page validation before Save and Continue. Unit tests 4/4. **Not live-verified.** |
| 2026-09-13 | Cursor | **Age + Voluntary labels:** "Are you 16 years old or over?" was filled **No** from cached YAML/LLM. Now `minimumAge.mjs` answers **Yes** first (DOB years if present; jobs are 18+). Long Voluntary legal text is kept as the question; `dateSection*` never used as a label. Required Education/Work fields unchanged (alwaysFill title/company/dates/degree/FoS). Cached No answers corrected in profile.yml, qa-store, llm-qa-store, enbridge/rrhs YAML. |
| 2026-09-13 | Cursor | **My Experience loop:** Save and Continue failed on required Field of Study, then refilled the whole step (rewrote dates, 30s click hang) forever. Now types Computer Science into Field of Study and clicks the option; error repair hits that field first; dropdown clicks timeout at 5s; wizard stops after 3 failed advances. |
| 2026-09-13 | Cursor | **Skills / Degree / Field of Study:** optional Skills never filled. If Skills is required, parse the resume and add exactly 2 skills (type + click autocomplete). Degree and Field of Study always fill (type + live option), using profile major when present. |
| 2026-09-13 | Cursor | **Ally Degree empty then skipped to CareOregon.** Crash: `submitBlocked is not defined` after Degree required errors. Degree widget label was `Degree Select One Required` so locate/repair missed it; searchable fill only tried exact `Bachelor's`. Apply Wizz then failed TLS (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Now: no crash, strip Select One/Required chrome, always-fill Degree from live options, stay on the URL with LLM/error-repair until Review, batch does not open the next link while incomplete, TLS retries without leaf verify. |
| 2026-09-13 | Cursor | **Required AQ still empty** (NE/IA relocate, hourly wage, hospital revenue essay, CPT/HCPCS areas, tell-us, why-looking). Fixes: required `*` wins over relocate skip; hourly uses Apply Wizz `Hourly: 40-60` → 50 (not yearly 90k); describe/tell-us/why-looking classified for LLM; Yes/No extracted from LLM prose; fill uses `data-wd-q-id`; checkbox-group with a describe textarea falls back to typing the LLM paragraph. **Live retest pending** |
| 2026-09-13 | Cursor | **Work Experience dates still wrong.** Live log: From answer `06/2025` → after `2/2025`, marked FILLED because year matched. Cause: typing `062025` into the 2-digit month spin. Fix: `typeSegment` keypresses month then year separately; `strictDateMatch` requires both; ignore `MM/YYYY` placeholders; support `dateSectionMonth-display`. Tests 6/6. |
| 2026-09-13 | Cursor | **Required AQ years/describe/proceed left empty.** Root causes: (1) OpenRouter still used Node `fetch` so IPv6 failed the same way as Apply Wizz; (2) the experience heuristic returned `0`/`NA` and skipped LLM; (3) essay answers >100 chars were treated as unfilled; (4) textarea/number were not typed unless fieldType was exactly `text`. Now: IPv4 OpenRouter with 45–60s; Playwright sends label + type code + live options to LLM; domain years/describe always go to LLM when the API has no exact match; proceed dropdowns get Yes so the form can continue; long describe text counts as filled. Suite 41/41. **Live retest pending** |
| 2026-09-13 | Cursor | **Apply Wizz `fetch failed` during apply.** Config was fine (`AWL-34133`); Node `fetch` tried the host's IPv6/NAT64 address first and Windows often drops that as a bare "fetch failed". Client now loads over IPv4 HTTPS with 3 retries, logs the real error code, and does not mark the profile hydrated on failure so a later step can retry. Verified IPv4 load: 94 Q&A keys. |
| 2026-09-13 | Cursor | **Stopped inventing answers.** Every fill now goes through `lib/clientAnswer.mjs`: Apply Wizz client profile first, then profile/resume facts, then LLM closest match. Removed hardcoded defaults from `resolveField`, `peekExpectedAnswer`, `adjustAnswerForFieldType`, checkbox groups (no more "check all shifts" / force Full Time), `mergeWorkdayDefaultAnswers` (no longer injects Yes/No/Male/Hyderabad into qa_answers), FIELD_MAP `_static` Yes/No, and city/address fallbacks. If Apply Wizz and LLM both miss, the field stays empty. 3 new tests; suite 35/35. **Live retest pending** |
| 2026-09-13 | Cursor | **Full DOM scan:** every formField + input/select/combobox/radio/checkbox walked; labels from richText/aria/sibling/placeholder/container; short labels kept; multi-signal Apply Wizz match (`labelCandidates` + `containerText`); logs `Full DOM scan` + label preview. Live retest pending |
| 2026-09-13 | Cursor | **Fixed the terminal reporting an answer the browser does not hold.** The volunteer question logged `✅ ← "No"` while the page had "Yes" selected. Three compounding causes, all substring matching on Yes/No: (1) the prompt-option picker used `filter({ hasText: 'No' })`, which matched "**Yes, I have been no**tified" and clicked it because it comes first in DOM order; (2) the verifier used `a.includes(e)`, so that same string "verified" as a "No"; (3) `verifyFieldFilled` in `dynamicFieldEngine` only asked *is the field filled*, never *is it filled with the right value*, then logged the intended answer rather than the DOM value. Now: `selectionMatchesAnswer`/`leadingYesNo` in `workdayDefaults.mjs` compare Yes/No on the leading word ("Not Hispanic or Latino" still counts as No); the option picker tries exact text, then leading-word, and only substring-matches non-Yes/No answers; candidates are filtered to the answer's polarity so a "No" can never click "Hispanic or Latino"; a single-choice control holding a different value logs `⛔ Wrong value in DOM` and is retried instead of recorded; the radio path anchors Yes/No the same way; the success line prints the browser's value when it differs. 6 new tests (32/32 suite) plus a 5-case browser fixture covering volunteer, related-to-employee, hispanic, work-authorisation and travel. **Live retest pending** |
| 2026-09-13 | Cursor | **Fixed wrong From/To dates on Work Experience + Education.** Root cause: the dates were hardcoded in three places in `workdayExperience.mjs` (`resolveAnswer` returned `05/2025` / `06/2026` / `2020` / `2024` before reading any source; `handleStep2MyExperience` overwrote `profile.experience`/`profile.education` after the spread; a "hard-lock" reset the work dates again after LLM hydrate) — whatever was in `profile.yml` or Apply Wizz was ignored. Dates now resolve tenant override → profile/Apply Wizz → defaults through new `lib/experienceDates.mjs`, which parses MM/YYYY, YYYY-MM, MM/DD/YYYY and "June 2025", swaps a reversed range, clamps a future work To to the current month, keeps a future expected graduation year, and refuses to fill an unparseable value. Also: `hydrateExperienceFromLlm` no longer overwrites configured dates with resume-guessed ones; half-filled spin pairs no longer read back as `"/2025"`; the month/year pair is set and verified per segment instead of typing `"MM/YYYY"` into the month box; the year segment is chosen by its label rather than by position; and date answers are no longer cached under the bare "From"/"To" key (Work and Education were overwriting each other — `qa_answers.from` had been left holding an education year). Removed the two polluted keys from `config/profile.yml`. 9 new tests, suite 26/26, verified on a Workday-shaped browser fixture. **Live retest pending** |
| 2026-09-13 | Cursor | Work Experience dates: spin map type MM+Enter / YYYY+Enter (hard-lock From=05/2025 To=06/2026, alwaysFill); date failures never fall through to dropdown/Add clicks; re-disarm Adds after expand |
| 2026-09-12 | Cursor | **DOM → Apply Wizz pipeline:** `resolveDomQuestionFromApplyWizz` + `domQuestionResolver.mjs`; Tier 0 in `resolveField`; expanded API Q&A index (bools, school, work prefs); align answers to live DOM options; LLM only after API miss. Live retest pending |
| 2026-09-12 | Cursor | **Efficient fill:** one specialized pass per step + one retry; skip live sweep when required=0; AQ/SI/VD no double ensure*; dropdown batch all Select Ones in one pass; dynamic loop caps/settle cut; formField loop 8→3; wizard maxNoProgress 3→2; fixed VD `gender` ReferenceError. Live retest pending |
| 2026-09-12 | Cursor | Hardened unknown-question flow: retained sanitized complete ApplyWizz client context in memory; passed it with Playwright label, field type code (input/dropdown/radio/checkbox/multi-checkbox), required state and live options. OpenRouter now returns structured JSON; low-confidence, ungrounded and non-option answers are rejected; multi-checkbox arrays are validated for the filler. Removed blank-preference first-option fabrication and blocked unknown compliance answers from LLM. Documented ApplyWizz env configuration. Added 5 tests; suite 17/17 passes. Live Workday retest pending |
| 2026-09-12 | Cursor | DOM+LLM pipeline: field_type_code 1–5; `requiredFieldStore` + `answerPipeline` (DB→YAML→resume→ApplyWizz/LLM humanic); Playwright `data-wd-q-id` markers; script `store-required-fields.mjs` |
| 2026-09-12 | Cursor | INPUT fields: `answerInputFieldWithLlm` — LLM analyses question vs full Apply Wizz/profile; years→number/0, describe→text/NA; heuristic only when LLM off |
| 2026-09-12 | Cursor | `experienceAnswer.mjs` — analyse Apply Wizz experience (5 yrs, AI/ML Engineer) + skills/role; numeric years Q → years if topic matches else **0**; describe Q → text or **NA**; reject Yes/No; wired into planner, questionFill, LLM prompts; fixed bad profile Yes answers |
| 2026-09-12 | Cursor | **Default-deny Add guard** (`installOptionalAddClickGuard`): a capture-phase listener injected into the page cancels *every* Add click except Work Experience and Education — Certifications, Languages, Awards, Websites and any unrecognised Add are refused no matter which module clicks them. Installed at the start of both the apply and scan loops; `drainBlockedAddClicks` logs what was blocked each step; `window.__wdAllowAddClicks = true` in devtools re-enables manual clicking. Verified on a browser fixture (heading-only and automation-id markup, both directions). Live retest pending |
| 2026-09-12 | Cursor | Script-only Playwright: `installScriptOnlyClickGuard` blocks optional Add + Help/Share chrome; skills/agreements only when required; skip more optional labels. Live retest pending |
| 2026-09-12 | Cursor | Misclick guard: new `lib/safeClick.mjs` — `disarmRiskyAddButtons` + `safeClick` / `isRiskyMisclickButton`; wired into every wizard step, My Experience, and dropdown fills; removed hierarchical page-button fallback and bare `Create` adaptive click. Live retest pending |
| 2026-09-12 | Cursor | Debug session: resume upload verifies DOM file chip (no false success); never opens OS picker; Certifications Add hard-blocked via `disarmOptionalAddButtons` + scoped section Add; optional cert/lang/award labels skipped in fill filter. Live retest pending |
| 2026-09-12 | Cursor | **Root cause of "Add Certificate" clicks found**: `typeAndClickOption` in `fields.mjs` ended every dropdown fill by clicking the first visible button named `Done/OK/Add/Confirm/Apply` — on My Experience that is the Certifications **Add** button. It is now restricted to confirm buttons inside the open prompt popup, and "add" was removed from the pattern. **Auto-submit closed off**: `clickSubmitButton` refuses unless the caller passes `allowSubmit: true` (only the Review Y/N/S flow and the explicit scan-Review choice do); `advanceWorkdayStep` refuses to click a footer button whose text is Submit (on Review the footer "next" button *is* Submit) and reports `submitBlocked` so the loop goes to the Review prompt; the adaptive loop no longer lists Submit as an action button and stops at Review; the `fillForm` fallback submit loop needs `--confirm-submit`. Verified on local fixtures; live retest pending |
| 2026-09-12 | Cursor | Harden resume auto-upload: multi-root absolute path + resumes.yml; 3× setInputFiles retry; broader Workday file-input find. Live retest pending |
| 2026-09-12 | Cursor | Answer safety + checkbox groups (Valley Health System run): fixed `fillCheckboxGroupField` — the Playwright `evaluate` callback destructured the element instead of its arguments, so **every checkbox group silently failed** (cause of "What schedule can you work? is required"); it is now scoped to the field, shift questions check **all** boxes, schedule questions pick **Full Time**. New `lookupSensitiveSafeAnswer` forces "No" on discipline/criminal/prior-association questions and "Yes" on work-eligibility. Yes/No guard rejects values like "Bachelor's Degree" from semantic/profile sources. Corrected wrong stored answers in `tenant-overrides/valleyhealth.yml` + `data/qa-store.json`. Verified on a local DOM fixture; live retest pending |
| 2026-09-12 | Cursor | Optional sections fully hands-off: `skipOptionalExperienceSections` / `handleWebsitesSection` no longer click Delete on empty Certifications/Languages/Awards/Websites rows; a row is removed only when required-marked, erroring, or `force: true` after Workday blocks Save and Continue. Live retest pending |
| 2026-09-12 | Cursor | Fix VD Race: discover short EEO labels (Race/Gender/Sex); `fillRaceEthnicityDropdown`; more VD dropdown passes; Asian leaf match. Live retest pending |
| 2026-09-12 | Cursor | Made apply/scan fully per-URL dynamic: `resetPerApplicationSessionState`; live DOM label sweep after My Information / My Experience / Self Identify / VD; fresh discover log each wizard page. Live retest pending |
| 2026-09-12 | Cursor | `experienceAnswer.mjs` — full Apply Wizz/profile analysis for years/describe Qs (match→years/text, else 0/NA); reject Yes; wire planner + questionFill + LLM |
| 2026-09-12 | Cursor | Hardened optional Add guard: never click Add Certificate/Language/Awards/etc.; `clickRequiredSectionAdd` scopes work/education only; re-skip after expand; websites optional fill skipped. Live retest pending |
| 2026-09-08 | Cursor | `workdaySource.mjs` — hierarchical source, DOM verification |
| 2026-09-08 | Cursor | `workdayExperience.mjs` — My Experience autofill |
| 2026-09-08 | Cursor | `engine.mjs` — Step 2 handler; removed skip-after-resume |
| 2026-09-08 | Cursor | Profile, qa-store, bah.yml, profile.example.yml |
| 2026-09-08 | Cursor | Created SESSION-CHECKPOINT.md; added mandatory IDE rules |
| 2026-09-08 | VS Code | Changed My Experience From/To to label-opened calendar spin mapper; live run exposed masked-input behavior, native-event fix applied; final retest pending |
| 2026-09-09 | VS Code | Confirmed City input mapping and centralized the default as `WORKDAY_DEFAULT_CITY = Hyderabad`; added City to the example Q&A template |
| 2026-09-08 | VS Code | Added required-marker detection so optional School, Degree, and Field of Study controls are skipped |
| 2026-09-08 | VS Code | Added Job Sites → LinkedIn/Indeed/Glassdoor cascading source preferences; source attempt ordering verified locally |
| 2026-09-09 | Cursor | Source: try `WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES` first; parent aliases; terminal only after DOM fail |
| 2026-09-09 | Cursor | My Experience rewrite: required-field scan, section-scoped DOM fill, terminal fallback |
| 2026-09-09 | Cursor | My Experience v2: fill-at-any-cost — Playwright spinbuttons, degree variants, structured logs, 3× retry |
| 2026-09-09 | Cursor | My Experience v3: fixed NOT FOUND — DOM label scan (`data-wd-exp-target`), expand Add sections, engine visible-input check |
| 2026-09-09 | Cursor | Source v4: `fillSourceFieldAuto`, broader DOM locate, URL `?source=web_LinkedIn`, no terminal for parallel runs |
| 2026-09-09 | Cursor | Websites: `workdayWebsites.mjs` fill URL or delete empty; removed generic "Add Another" clicks |
| 2026-09-09 | Cursor | WD5: generated 144 `tenant-overrides/{slug}.yml` (shared template), `wd5-tenants.json`, verify script, `.cursor/skills/plan/` |
| 2026-09-09 | Cursor | `workdaySource.mjs` — fix QVC Job Board: skip label trigger, scroll submenu, fallback Careerbuilder/DICE/LinkedIn |
| 2026-09-09 | Cursor | DOM parse fix: checkbox-group (work types), Application Questions page 1/2 Next, stop false skip on empty fields |
| 2026-09-09 | Cursor | `scan-batch` + `catalog-show` for data/wd5.csv — batch DOM question harvest (15 URLs/batch default) |
| 2026-09-09 | Cursor | Per-company YAML storage (`tenantQuestionYaml.mjs`); full wizard scan loop drafted; interactive terminal plan added — **awaiting user approval** |
| 2026-09-09 | Cursor | Phase A+B: interactive scan-batch, rich `askHuman`, `saveAnswerToTenantYaml`, `--no-interactive` flag |
| 2026-09-12 | Cursor | Rewrote `CODEBASE-ANALYSIS.md` as Workday-only architecture map with mermaid diagrams |
| 2026-09-12 | Cursor | Implemented autonomous Q&A: Apply Wizz → YAML → profile/resume → LLM; no form-answer terminal (opt-in `FORM_ANSWER_TERMINAL=1`) |
| 2026-09-12 | Cursor | Wizard loop fix: `computeStepFingerprint` + progress detection, skip re-fill of completed pages, stop after 3 no-progress passes; Y/N/S submit prompt restored at Review |
| 2026-09-12 | Cursor | `workdayOptionalSections.mjs` — Certifications/Languages/Awards/etc. skipped + empty rows deleted; `markFieldByLabel` ignores optional sections; `typeAndClickOption` requires a real option match; dropdown attempts narrowed by live DOM options (faster). Live retest pending |
| 2026-09-12 | Cursor | My Experience switched to **required-only**: non-required fields skipped, work/education expanded only when the section is required, LLM experience hydration only when a section will be filled. Verified on local DOM fixtures; live retest pending |

---

## Repo layout (one glance)

```
workday-auto-apply/
  SESSION-CHECKPOINT.md    ← READ FIRST · UPDATE LAST (mandatory)
  CODEBASE-ANALYSIS.md     ← architecture + mermaid (refreshed 2026-09-12)
  auto-apply/
    AGENTS.md              ← agent rules (references this file)
    cli.mjs
    lib/
    config/profile.yml
    data/qa-store.json
```

---

## Copy-paste template for next session log row

```markdown
| YYYY-MM-DD | IDE name | Short summary of what changed and what is still untested |
```
