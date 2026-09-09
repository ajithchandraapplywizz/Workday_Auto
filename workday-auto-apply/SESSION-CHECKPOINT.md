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
| **Last updated** | 2026-09-09 |
| **Updated by** | Cursor — source auto-fill from yaml/mjs/URL (no terminal) |
| **Active app** | `workday-auto-apply/auto-apply/` |
| **Current focus** | "How did you hear" — DOM scan + hierarchical defaults, parallel-safe |
| **Overall status** | Source + My Experience locator fixes; live parallel retest needed |
| **Test URL** | [BAH Full-Stack Engineer](https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/Ashburn%2C-VA/Full-Stack-Software-Engineer--Lead_R0248739/apply) |
| **Run command** | `cd auto-apply && node cli.mjs apply "<Test URL>"` |

---

## Where work stopped

| Step | Status | Notes |
|------|--------|-------|
| **My Information** — source dropdown | Rewritten — **live retest needed** | `fillSourceFieldAuto`: DOM label scan, yaml/mjs/URL, Job Sites→LinkedIn/Indeed/Glassdoor; **no terminal prompt** |
| **My Information** — City (Hyderabad) | Code updated — **live retest needed** | `workdayCity.mjs` — DOM detect/fill/verify on `#address--city` |
| **My Information** — phone, address, prior worker | Likely OK | `engine.mjs` `handleStep1MyInformation()` |
| **My Experience** — work + education | Locator fix — **live retest needed** | Was NOT FOUND (broken Playwright filter); now DOM label scan + `ensureSectionsExpanded` |
| **My Experience** — resume upload | Should run then continue fill | No longer skips after upload (`engine.mjs` fixed) |
| **Application Questions** | Not started | — |
| **Voluntary Disclosures** | Not started | — |
| **Review / Submit** | Not started | — |

---

## Start here next (in order)

1. Read **Quick status** and **Where work stopped** above.
2. Run apply from `auto-apply/` (see **Test URL**).
3. **My Experience:** verify Work Experience 1 — Job Title, Company, Location, From `06/2025`, To `08/2025`, Role Description; skip "I currently work here".
4. **My Experience:** verify Education 1 — School `Other`, Degree `Bachelor's`, Field of Study `Computer Science`, From `2022`, To `2026`; Save and Continue must show no "required" errors.
5. **My Information:** confirm source shows a **leaf** value in browser (e.g. `LinkedIn`), not empty / not `Job Board` only.
6. If Field of Study fails → note parent labels in browser → add to `WORKDAY_FIELD_OF_STUDY_ATTEMPTS` in `workdayDefaults.mjs`.
7. If source fails → note submenu after `Job Board` → add to `WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES` in `workdayDefaults.mjs`.
8. **Update this file** with test results before closing the IDE.

---

## Important files only (do not read whole repo)

| File | Why it matters |
|------|----------------|
| `SESSION-CHECKPOINT.md` | **This file** — read first, update last |
| `auto-apply/AGENTS.md` | Agent rules; points here for handoff |
| `auto-apply/cli.mjs` | Entry point — `apply`, `setup`, queue |
| `auto-apply/lib/engine.mjs` | Wizard steps, Save & Continue, Step 1 + 2 routing |
| `auto-apply/lib/workdaySource.mjs` | Source dropdown — defaults `.mjs` first, DOM verify, then terminal |
| `auto-apply/lib/workdayCity.mjs` | **City** — mandatory Hyderabad, DOM verify |
| `auto-apply/lib/workdayExperience.mjs` | My Experience — work history, education, dates |
| `auto-apply/lib/workdayDefaults.mjs` | Defaults, source hierarchy, field-of-study attempts |
| `auto-apply/lib/workdayQuestionFill.mjs` | formField DOM fill, dates, dropdowns |
| `auto-apply/lib/planner.mjs` | Label → profile mapping, terminal prompts |
| `auto-apply/lib/fields.mjs` | Dropdowns, `handleHierarchicalDropdown` |
| `auto-apply/config/profile.yml` | User answers (gitignored) |
| `auto-apply/config/profile.example.yml` | Profile template |
| `auto-apply/data/qa-store.json` | Q&A cache (`bah::` tenant keys) |
| `auto-apply/config/tenant-overrides/bah.yml` | Booz Allen field overrides |
| `CODEBASE-ANALYSIS.md` | Full architecture (optional deep dive) |

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
| Education | Other school, Bachelor's, Computer Science, 2022–2026, Bachelors of Technology |
| Source | LinkedIn (via Job Board submenu) |

Stored in: `auto-apply/config/profile.yml` + `auto-apply/data/qa-store.json`

---

## Known issues / watch list

| Issue | Status |
|-------|--------|
| Source not trying workdayDefaults list | Fixed — hierarchical prefs tried first in file order; Job Sites aliases added |
| City mandatory on wd5 visa tenants | Fixed in code — `workdayCity.mjs`; **live retest pending** |
| `Job Board` saved as final answer (parent only) | Fixed — profile uses leaf (`LinkedIn`) |
| My Experience skipped after resume upload | Fixed — `engine.mjs` |
| Workday From/To masked controls reject Playwright fill | Mapper now clicks label and uses native input events; **live retest pending** |
| Optional education fields should remain blank | Fixed in code — education fields are filled only when required markers/ARIA are present |
| City question needs a fixed answer | Fixed — `City` resolves to `Hyderabad` in profile and defaults |
| Field of Study parent may be “All” not “Engineering” | Add to `WORKDAY_FIELD_OF_STUDY_ATTEMPTS` if needed |
| `+91` in wrong field (source vs phone) | Fixed — strict `#source--source` locator |

---

## Recent session log

| Date | Who / IDE | What changed |
|------|-----------|--------------|
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

---

## Repo layout (one glance)

```
workday-auto-apply/
  SESSION-CHECKPOINT.md    ← READ FIRST · UPDATE LAST (mandatory)
  CODEBASE-ANALYSIS.md     ← optional deep architecture
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
