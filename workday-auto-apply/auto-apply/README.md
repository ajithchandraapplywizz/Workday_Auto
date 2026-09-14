# workday-auto-apply

**Autonomous Workday job application engine.** Supply Apply Wizz client data (API + local YAML), resume PDFs, and job URLs. The bot logs into Workday, scans each wizard page from the live DOM, resolves every question by **intent + verified evidence** (never keyword guessing), fills controls through Playwright, verifies acceptance, and advances until Review → Submit.

Built on [Playwright](https://playwright.dev). **Workday only** — no Greenhouse, Lever, Ashby, or other ATS logic.

```bash
cd workday-auto-apply/auto-apply
node cli.mjs apply https://company.wd5.myworkdayjobs.com/en-US/careers/job/12345
```

---

## How it works (every page, every question)

Each wizard step runs the same **page workflow** (`runWorkdayPageWorkflow`):

```
  SCAN ──> normalize all fields on the current page (DOM + accessibility)
    │
  INTENT ──> classify what the question means (semantic intent, not label keywords)
    │
  EVIDENCE ──> retrieve answers in strict priority:
    │            1) Apply Wizz client API + profile/qa YAML on disk
    │            2) Verified Q&A memory (same intent only)
    │            3) Resume / profile facts tied to that intent
    │            4) LLM batch — may only choose from evidence; no invented facts
    │
  VALIDATE ──> map to exact live option, confidence floor, high-risk gates
    │
  FILL ──> Playwright interaction layer (text, dropdown, radio, date, file, …)
    │
  VERIFY ──> re-read DOM; retry if not accepted
    │
  RESCAN ──> conditional questions may appear; loop until required fields done
    │
  ADVANCE ──> Save and Continue (or Next on Application Questions sub-pages)
```

**No mid-run human prompts** in normal apply mode. If evidence is missing, contradictory, or low confidence → `requiresReview` / step blocked — the bot does **not** guess.

Optional: set `FORM_ANSWER_TERMINAL=1` only if you explicitly want terminal Q&A during scan/dev (not the default apply path).

---

## Answer priority (evidence, not fuzzy labels)

| Priority | Source | Role |
|----------|--------|------|
| 1 | **Apply Wizz** (`APPLYWIZZ_ID` / API) + hydrated `profile.yml` / `qa_answers` | Source of truth |
| 2 | **Local YAML** — `config/profile.yml`, tenant overrides, persisted answers | Same facts when API offline |
| 3 | **Verified memory** — prior answers reused only when **intent matches** | Not substring keyword match |
| 4 | **Resume PDF** — factual inference for experience/skills/education shapes | Never salary/compliance guesses |
| 5 | **LLM** (OpenRouter) — analyzes question + live options against client evidence | Picks closest **supported** option only |

Compliance fields (work auth, sponsorship, EEO, clearance, etc.) require **verified** data on file before auto-submit.

---

## Quick start

```bash
npm install
npx playwright install chromium
node cli.mjs setup
```

1. **Profile** — `setup` creates `config/profile.yml` from `config/profile.example.yml` (gitignored).
2. **Apply Wizz** — set `APPLYWIZZ_ID` (and API URL if used) in `.env`.
3. **Resume** — PDF in `resumes/`, referenced in `config/resumes.yml`.
4. **Run** — `node cli.mjs apply <workday-url>` or `node cli.mjs batch`.

Browser is **always headed** (`headless: false`).

---

## Commands

| Command | Purpose |
|---------|---------|
| `node cli.mjs setup` | Create profile from template |
| `node cli.mjs scan <url>` | DOM scan → JSON |
| `node cli.mjs apply <url>` | Full apply pipeline |
| `node cli.mjs batch [file]` | Queue / targets file |
| `node cli.mjs queue add/list` | Application queue |
| `node cli.mjs status` | Run stats |

---

## Architecture (application root)

```
auto-apply/
├── cli.mjs
├── lib/
│   ├── engine.mjs              Wizard loop, submit, review
│   ├── dynamicFieldEngine.mjs  Session + page workflow entry
│   ├── orchestrator/           SCAN→reason→validate→fill→verify→rescan
│   ├── questionEngine/         Intent, evidence, option mapping
│   ├── interaction/            Playwright fill handlers (HOW, not WHAT)
│   ├── applyWizzClient.mjs     Client API + YAML hydration
│   ├── workdayDom.mjs          DOM discovery
│   ├── planner.mjs             Plan generation (delegates to question engine)
│   ├── qaStore.mjs             Persistent Q&A (local YAML)
│   └── workday*.mjs            Step-specific DOM prep (source, city, experience)
├── config/                     profile.example.yml, tenant-overrides/
├── resumes/                    PDFs (gitignored)
└── data/                       applied.csv, qa-store (gitignored)
```

Deep specs: `../ProjectDocs/` and `AGENTS.md` at repo root (Local Phase only).

---

## Safety

- DOM-first decisions; screenshots are audit-only.
- Never fabricate personal or compliance answers.
- Pre-fill validation before every interaction.
- Post-fill DOM verification before advancing.
- Secrets in `.env` only; never commit `profile.yml` or credentials.

---

## License

MIT
