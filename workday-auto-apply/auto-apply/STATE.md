# STATE.md — Workday Auto-Apply Bot

**Project:** Workday-only job application automation — Local Phase (terminal) + Production Phase (Telegram + Supabase)  
**Status:** Local Phase — Local-1/2/3 code aligned to ProjectDocs; live checkpoints pending  
**Last Updated:** 2026-09-04  
**Test Environment:** Live Workday sandbox account available

---

## Project Overview

Node.js/Playwright bot that:
1. Validates Workday URLs and authenticates (sign-in/sign-up).
2. Scans each wizard page via DOM + accessibility tree (screenshots audit-only).
3. Fuzzy-matches questions against `profile.qa_answers`; profile fallback for factual fields; terminal prompt for required unknowns.
4. Fills, verifies, clicks Save & Continue through dynamic wizard steps.
5. Cross-checks Review, then submits.
6. Logs results to CSV (Supabase + Telegram in Production Phase).

**Scope:** Workday only (`myworkdayjobs.com`). See `ProjectDocs/` + `AGENTS.md`.  
**Entry:** `node cli.mjs apply <workday-url>`

---

## Module Status

| Module | Purpose | Status |
|---|---|---|
| `discovery.mjs` | Workday URL validation, `targets.txt` intake, JD→Apply navigation | ✅ Updated (non-Workday removed) |
| `stateDetector.mjs` | Wizard step detection from DOM headings | ✅ New |
| `scanner.mjs` | Form field extraction + pre-scan auth | ✅ Working |
| `workdayDom.mjs` | DOM/a11y discovery, MutationObserver, Review parse | ✅ Working |
| `qaStore.mjs` | Fuzzy `findBestMatch`, compliance flags, YAML persist | ✅ Updated |
| `planner.mjs` | Answer hierarchy: cache → profile → human | ✅ Updated |
| `fields.mjs` | Field locate + dropdown strategies | ✅ Working |
| `engine.mjs` | Wizard loop: scan → fill → advance → Review → Submit | ✅ Updated |
| `workday.mjs` | Workday auth | ✅ Working |
| `adapters/` | `localQaAdapter`, `terminalHumanAdapter` | ✅ Scaffolded |
| `telegram/` | Production Phase only | ⏳ Gated behind Local Phase Gate |

---

## Phase Checklist (`ProjectDocs/6.implementation.md`)

### Local Phase
- [x] Local-1 code: URL validation, targets parsing, auth reuse
- [x] Local-2 code: DOM scan per page, fuzzy Q&A, profile fallback
- [x] Local-3 code: terminal escalation, YAML persist, wizard submit path
- [ ] **Local-1 checkpoint:** live URL → authenticated first form page
- [ ] **Local-2 checkpoint:** cached question fills without prompt
- [ ] **Local-3 checkpoint:** new question asked once, auto on second run
- [ ] **Local Phase Gate:** 3 real Workday tenants, ≥80% no-manual-intervention

### Production Phase (blocked until Local Gate)
- [ ] Prod-1 through Prod-4 — see `ProjectDocs/5.backend-schema.md`

---

## Current Status (2026-09-04)

- Master Prompt added to `ProjectDocs/6.implementation.md` §6
- `AGENTS.md` created with Workday-only rules and build order
- Multi-ATS navigation removed from `discovery.mjs`; CLI rejects non-Workday URLs
- Per-page flow: `discoverWorkdayFields` → `findBestMatch` / `resolveField` → fill → rescan
- Required unknowns prompt in terminal (ui-ux format); answers saved to `profile.qa_answers`
- Compliance questions never profile-inferred (`isComplianceSensitive`)
- Next: run live `node cli.mjs apply <url>` to pass Local-1/2/3 checkpoints
