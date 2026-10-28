# Workday Auto: System Architecture

## Executive Overview
Workday Auto is an autonomous application automation and monitoring platform built to interact with Workday Job Portals (`*.myworkdayjobs.com`). It unites a headless/headed Playwright Chromium engine, a dynamic 4-tier answer resolution hierarchy, cloud persistence via Supabase, and an administrative React dashboard.

---

## System Architecture Diagram

```mermaid
flowchart TB
    subgraph CLIENT_LAYER["Client & Management Layer"]
        OPERATOR["Operator / CLI User"]
        DASHBOARD["React 18 Dashboard (Vite SPA)"]
    end

    subgraph WORKER_LAYER["Automation & Worker Layer"]
        CLI_RUNNER["CLI Dispatcher (backend/cli.mjs)"]
        DAEMON["Queue Daemon (backend/scripts/queue_daemon.mjs)"]
        ENGINE["Core Orchestration Engine (backend/lib/engine.mjs)"]
        PLAYWRIGHT["Playwright Chromium Browser Instance"]
    end

    subgraph RESOLUTION_LAYER["Hierarchical 4-Tier Answer Engine"]
        T1["Tier 1: Supabase client_questions / clients Cache"]
        T2["Tier 2: Apply Wizz CRM Profile API"]
        T3["Tier 3: Parsed Resume Facts (PDF Extractor)"]
        T4["Tier 4: Live DOM Option Matcher + LLM Dynamic Resolver"]
    end

    subgraph EXTERNAL_SERVICES["External Services & Portals"]
        WORKDAY["Workday ATS Portals (*.myworkdayjobs.com)"]
        APPLYWIZZ_API["Apply Wizz CRM REST API"]
        OPENROUTER["OpenRouter API (GPT-4o-mini / Gemini)"]
    end

    subgraph PERSISTENCE_LAYER["Cloud Persistence & Storage"]
        SUPABASE_DB[(Supabase PostgreSQL: Queues, Q&A, Profiles)]
        SUPABASE_STORAGE["Supabase Storage: submitted / failed screenshots (in-memory buffer stream)"]
    end

    %% Client Interactions
    OPERATOR -->|CLI Commands| CLI_RUNNER
    DASHBOARD -->|HTTPS / Supabase Client SDK| SUPABASE_DB
    DASHBOARD -->|Signed URLs| SUPABASE_STORAGE

    %% Worker Interactions
    CLI_RUNNER --> ENGINE
    DAEMON -->|Polls Queue (Interval Loop)| SUPABASE_DB
    DAEMON -->|Spawns Job Apply| ENGINE
    ENGINE -->|Controls Page & DOM Interaction| PLAYWRIGHT
    PLAYWRIGHT <-->|HTTPS Automation / DevTools Protocol| WORKDAY

    %% Answer Resolution Flow
    ENGINE --> RESOLUTION_LAYER
    RESOLUTION_LAYER -->|1. Sync Query| T1
    T1 -.->|Miss| T2
    T2 -->|HTTPS REST| APPLYWIZZ_API
    T2 -.->|Miss| T3
    T3 -.->|Miss| T4
    T4 -->|Scraped Live DOM Options| PLAYWRIGHT
    T4 -->|HTTPS Prompt Evaluation| OPENROUTER
    T4 -->|Self-Learning Feedback: Upsert Answer| SUPABASE_DB

    %% Storage & Audit
    ENGINE -->|In-Memory Screenshot Stream| SUPABASE_STORAGE
    ENGINE -->|Update Status & Metrics| SUPABASE_DB
```

---

## Component Breakdown & Communication Protocols

| Component | Responsibility | Communication Protocol |
|---|---|---|
| **Frontend Dashboard** | Displays queued jobs, success rates, failure diagnostics, and client profiles | HTTPS REST / Realtime WebSocket via `@supabase/supabase-js` |
| **Queue Daemon** | Polls Supabase for pending applications, coordinates concurrency, invokes engine | Database queries via Supabase REST client; internal Node process orchestration |
| **CLI Dispatcher** | Executes single applies, batch imports, scanning, and diagnostics | Local CLI process execution (Node.js ES Modules) |
| **Core Engine** | Manages browser lifecycle, step workflows, and DOM assertions | In-process Playwright Chromium automation via Chrome DevTools Protocol (CDP) |
| **4-Tier Answer Engine** | Resolves field values with strict precedence; updates Tier 1 memory | Internal function waterfalls; HTTPS REST to OpenRouter and Apply Wizz CRM |
| **Supabase Cloud** | Stores application states, candidate profiles, Q&A pairs, and screenshots | PostgreSQL over HTTPS; S3-compatible Blob storage over HTTPS |

---

## Subsystem Details

### 1. DOM Scanning & Normalization Pipeline
1. **Container Scrape**: `lib/workdayDom.mjs` locates all question wrappers (`[data-automation-id*="formField"]`, `fieldset[role="group"]`).
2. **Label Extraction**: Scrapes `aria-labelledby`, `<label for>`, and inner text; strips asterisks, suffixes, and noise.
3. **Live Option Collection**: Clicks open select/combobox controls and extracts the active, visible DOM choices before consulting the answer engine.
4. **Schema Normalization**: `lib/interaction/fieldSchema.mjs` emits a clean JSON schema of questions for the active page.

### 2. Answer Resolution Hierarchy
- **Tier 1 (Supabase DB)**: Authoritative pre-recorded candidate data and validated question hashes.
- **Tier 2 (Apply Wizz CRM API)**: Candidate profile fetched dynamically from Apply Wizz.
- **Tier 3 (Resume Facts)**: Parsed PDF resume data for education, technical tenure, and certifications.
- **Tier 4 (LLM + Live Options)**: Evaluates the question using candidate background constrained to the exact options extracted from the DOM.
- **Persistent Feedback**: Tier 4 answers are automatically written to Supabase `client_questions`, making subsequent runs instantaneous.

---

## Scalability, Resilience & Security Boundaries

### Scalability
- **Stateless Workers**: Automation workers do not maintain local state. Any machine running the daemon can pull a queue item from Supabase and execute.
- **Parallel Workspaces**: Independent browser contexts allow parallel job submissions without shared session pollution.
- **Cloud Centralization**: Queue and Q&A caches reside in Supabase, eliminating synchronization overhead between distributed workers.

### Resilience & Fault Tolerance
- **In-Memory Streaming**: Screenshots are held as in-memory buffers (`await page.screenshot()`) and streamed directly to Supabase cloud buckets, eliminating disk I/O bottlenecks and ensuring no orphaned local artifacts.
- **DOM-Native Assertions**: Every form interaction is followed by a DOM verification check before advancing. If an error is detected, the engine halts or applies targeted self-repair.
- **Fail-Fast Configuration**: Critical environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are checked on startup; missing credentials trigger an immediate, graceful exit rather than cascading runtime crashes.

### Security Boundaries
- **Zero Local Screenshots Policy**: Candidate PII, application records, and Workday forms are never written to disk as screenshots. Local storage of screenshots is strictly prohibited.
- **Secret Isolation**: `SUPABASE_SERVICE_ROLE_KEY` is restricted strictly to backend processes and CI/CD secret managers. It is never exposed to the frontend or bundled code.
- **Restricted Git Operations**: Autonomous coding agents are strictly forbidden from executing automated git staging, committing, or pushing (`git add`, `git commit`, `git push`), ensuring human approval for all source alterations.
