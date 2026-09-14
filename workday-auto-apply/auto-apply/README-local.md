# workday-auto-apply

**Autonomous Workday job application engine.** Give it your resume, profile, and job URLs — it detects the login/signup flow, scans each Workday wizard page via the DOM, fuzzy-matches questions against a permanent Q&A memory, fills every field, submits, and logs the result. Anything it can't answer, it asks you once — and never asks again.

Local Phase: single-user, terminal-driven. Production Phase: multi-user, Telegram + Supabase-driven. Built on [Playwright](https://playwright.dev).

```
node cli.mjs apply https://company.wd5.myworkdayjobs.com/en-US/careers/job/12345
```

> This project targets **Workday only.** Earlier prototypes explored other ATS platforms (Greenhouse, Lever, Ashby) — that logic has been removed. This is a Workday-specialist bot, not a multi-ATS generalist.

---

## How It Works

```
          ┌───────────┐
  URL ──> │  Discover  │──> detect login/signup, navigate to first form page
          └────┬──────┘
               │
          ┌────▼──────┐
          │   Scan     │──> DOM + accessibility tree → fields on current page
          └────┬──────┘     (screenshot taken in parallel, audit-only)
               │
          ┌────▼──────┐
          │  Match     │──> fuzzy-match each question against Q&A cache
          └────┬──────┘     miss → resume/profile fact → miss → ask human once
               │
          ┌────▼──────┐
          │   Fill     │──> apply value, verify in DOM
          └────┬──────┘
               │
          ┌────▼──────┐
          │  Advance   │──> Save and Continue → rescan next page (repeat)
          └────┬──────┘
               │
          ┌────▼──────┐
          │  Review    │──> cross-check summary vs intended values
          └────┬──────┘
               │
          ┌────▼──────┐
          │  Submit    │──> confirm, screenshot, log to CSV / Supabase
          └───────────┘
```

**Pipeline per URL:** Detect login/signup state → authenticate → scan current page (DOM-first) → fuzzy-match questions against Q&A memory → fall back to resume facts → fall back to asking the human once (and remembering forever) → fill → verify → advance → repeat until Review → cross-check → submit → screenshot → log.

---

## Quick Start (Local Phase)

```bash
git clone <this-repo>
cd workday-auto-apply
npm install
npx playwright install chromium
node cli.mjs setup
```

### 1. Create your profile

`setup` copies `config/profile.example.yml` → `config/profile.yml`. Edit with your real details (personal info, EEO, work authorization, education, experience).

### 2. Add your resume

Place a PDF in `resumes/` and reference it in `config/resumes.yml`.

### 3. List your target jobs

Add one Workday job URL per line to `targets.txt`.

### 4. Run

```bash
node cli.mjs apply <workday-job-url>     # single job
node cli.mjs batch                        # everything in targets.txt / queue
```

The browser opens **visibly** — this is intentional. Watch it. If it hits a question it can't answer, it will pause and ask you in the terminal, then remember your answer forever.

---

## Commands

```
node cli.mjs setup                Create your profile from the template
node cli.mjs scan <url>           Scan a Workday form → JSON (inspect field structure)
node cli.mjs apply <url>          Full pipeline: scan → match → fill → verify → submit
node cli.mjs batch [targets.txt]  Apply to every URL in the file / queue
node cli.mjs queue add <url> [company]
node cli.mjs queue list
node cli.mjs status                Stats: submitted / needs-review / failed, per run
```

---

## Architecture

```
workday-auto-apply/
├── cli.mjs                  CLI entry point
├── lib/
│   ├── discovery.mjs        Workday login/signup detection & navigation
│   ├── scanner.mjs          Form field scanner (DOM-first)
│   ├── workdayDom.mjs       DOM + accessibility discovery, MutationObserver, review parsing
│   ├── planner.mjs          Field → profile/cache value mapping, resume-fact fallback
│   ├── fields.mjs           Universal field finder, dropdown/typeahead handling
│   ├── engine.mjs           Fill, verify, wizard-loop, submit
│   ├── workday.mjs          Workday login & account creation
│   ├── qaStore.mjs          Permanent Q&A memory (local YAML → Supabase in Production)
│   ├── learner.mjs          Field-failure/correction learning store
│   ├── reporter.mjs         Screenshots, CSV logging, queue management
│   └── telegram/            Production Phase only — bot, onboarding, notifications
├── config/
│   ├── profile.yml          Your profile (gitignored)
│   ├── profile.example.yml  Template
│   └── resumes.yml          Resume variants & keywords
├── resumes/                 PDF resume files (gitignored)
├── forms/                   Scan JSONs
├── data/
│   ├── applied.csv          Application log
│   └── learnings.json       Self-learning corrections
├── screenshots/             Pre/post-submit screenshots
├── targets.txt              Job URL list
└── docs/                    Full spec set — prd, rd, workflow, ui-ux, backend-schema, implementation, telegram-bot-setup
```

---

## Q&A Memory (the core differentiator)

Every Workday tenant asks different questions. This bot doesn't hardcode answers per company — it builds a **permanent, per-user Q&A memory**:

1. Question scanned from the DOM.
2. Fuzzy-matched against everything you've answered before.
3. Hit → answered automatically. Miss → tries to infer from your resume/profile facts. Still miss → **asks you once, in the terminal (Local) or via Telegram (Production)** — and stores your answer forever.

Compliance-sensitive categories (work authorization, visa sponsorship, government employment, EEO/voluntary disclosure) always route through this human-confirmation step the first time, regardless of fuzzy-match confidence — see `docs/rd.md` FR-L5.3.

---

## Safety

- **Never headless** in Local Phase — the browser always opens visibly.
- **Never fabricates an answer** — cache, resume fact, or human-confirmed only.
- **Verifies before submit** — every field is re-checked in the DOM.
- **Screenshots everything** — pre- and post-submit, for audit, never for decision logic.
- **No credential storage in code** — `.env` locally (gitignored), encrypted Supabase columns in Production.

---

## Production Phase

Multi-user, Telegram + Supabase-driven. See `docs/prd.md` §6.2, `docs/workflow.md` §2, `docs/backend-schema.md`, and `docs/telegram-bot-setup.md` for the full spec. Summary: users link via a QR deep-link, the bot logs into their stored Workday account, notifies them of domain-matched jobs via Telegram, and applies on approval — with all unknown questions resolved once via Telegram and remembered forever per user.

---

## License

MIT
