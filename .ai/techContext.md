# Technical Context: Workday Auto

## Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **Runtime & Language** | Node.js (>= 18), ES Modules (`type: module`) | Modern JavaScript (MJS), async/await, native fetch |
| **Automation Engine** | Playwright Chromium | Headless & headed browser orchestration, DOM inspection, network interception |
| **Frontend Framework** | React 18, Vite | SPA dashboard for real-time queue monitoring, client management, and analytics |
| **Database & Auth** | Supabase (PostgreSQL) | Candidate profiles, queue tables, Q&A memory, in-memory screenshot bucket storage |
| **LLM Provider** | OpenRouter API | Models: `openai/gpt-4o-mini`, `google/gemini-2.5-flash` for question answering |
| **2FA / OTP** | `otplib`, `qrcode-terminal` | TOTP generation and terminal QR rendering for Workday accounts requiring 2FA |
| **Containerization** | Docker, Multi-stage builds | Production containers for backend daemon and frontend static serving |
| **Hosting & CI** | Railway, Render, GitHub Actions | Continuous integration for node tests, frontend builds, and Docker image validation |

## Core Commands & Scripts

| Command | Working Directory | Description |
|---|---|---|
| `npm test` | Root | Runs unit test suite (`node --test backend/tests/*.test.mjs`) |
| `npm run typecheck` | Root | Runs syntax and type check (`node --check backend/cli.mjs`) |
| `npm run lint` | Root | Runs ESLint validation on JavaScript and MJS modules |
| `npm run build` | Root | Builds the frontend React dashboard (`npm --prefix frontend run build`) |
| `npm run dev` | Root | Starts Vite development server for frontend |
| `npm run setup` | Root | Boots initial environment and template configurations |
| `npm run scan` | Root | Scans a Workday posting URL and extracts field schema |
| `npm run apply` | Root | Runs end-to-end apply pipeline for a single target URL |
| `npm run batch` | Root | Ingests a CSV list of job URLs and queues applications |
| `npm run submit` | Root | Runs the background queue daemon (`backend/scripts/queue_daemon.mjs submit`) |
| `npm run status` | Root | Displays current queue status and client metrics |

## Key File Locations

| Functional Area | Path | Responsibility |
|---|---|---|
| **Root Package & Config** | `package.json`, `index.js`, `Dockerfile` | Monorepo entry points, unified scripts, root Docker definition |
| **CLI & Dispatcher** | `backend/cli.mjs` | Primary CLI entry point for scan, fill, apply, batch, and queue tasks |
| **Engine Orchestrator** | `backend/lib/engine.mjs` | Application execution flow, step routing, wizard loops |
| **Page Workflow** | `backend/lib/orchestrator/` | Step detection, rapid advance, page loop state management |
| **Answer Resolution** | `backend/lib/clientAnswer.mjs` | 4-tier answer waterfall (Supabase -> CRM -> Resume -> LLM) |
| **DOM Inspection** | `backend/lib/workdayDom.mjs`, `scanner.mjs` | Playwright DOM querying, ARIA resolution, live option extraction |
| **Step-Specific Handlers** | `backend/lib/workday*.mjs` | Experience, referral source, demographic, and date pickers |
| **Queue Daemon** | `backend/scripts/queue_daemon.mjs` | Autonomous worker polling Supabase queue to execute applications |
| **Database Migrations** | `migrations/`, `backend/supabase-migrations/`| PostgreSQL schema definitions and table migrations |
| **Frontend Dashboard** | `frontend/src/` | React dashboard UI, queue viewer, client management components |

## Environment Variables & Configuration

| Variable Name | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | **Yes** | Supabase Project URL (`https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service-role secret (strictly backend/CI only; fail-fast if absent) |
| `OPENROUTER_API_KEY` | **Yes** | OpenRouter API token for Tier 4 question analysis |
| `OPENROUTER_MODEL` | No | Target model (default: `openai/gpt-4o-mini`) |
| `APPLYWIZZ_ID` | Optional | Fallback client candidate ID (e.g. `AWL-12345`) when not passed via CLI/DB |
| `WORKDAY_PASSWORD` | Optional | Default password for new/existing Workday candidate accounts |
| `HEADLESS` | No | Set `true` to run Playwright in headless mode (default: `false` for debugging) |
| `PORT` | No | Port for daemon server or API listener (default: `8080` or `3000`) |

## Deployment & Infrastructure
- **CI/CD (`.github/workflows/ci.yml`)**: Automatically triggers on pull requests and pushes to `main`. Runs node unit tests, frontend Vite builds, and tests Docker builds.
- **Docker Production**: Uses multi-stage Dockerfile with Playwright Chromium runtime dependencies installed (`npx playwright install-deps chromium`).
- **Cloud Hosting**: Deployed across Railway and Render with separation of worker daemon and dashboard UI.
