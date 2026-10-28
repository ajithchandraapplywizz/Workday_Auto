  # ApplyWizz — Handover Audit Report (READ-ONLY)

  > **Document Status:** Complete Handover Audit  
  > **Mode:** Strictly READ-ONLY (No code, database, or schema mutations executed)  
  > **Target Environment:** Supabase (`yuppxmwrztbirsnzgfjh.supabase.co`) / Railway / Local Workers  
  > **Date:** October 28, 2026  

  ---

  ## Executive Summary & Live Findings

  | Metric / Problem Area | Status | Live Finding / Evidence |
  |---|---|---|
  | **P1: Scanned Jobs Upsert Failure** | **CONFIRMED** | `scanned_jobs` has **0 rows**. Code sends non-existent column `scan_run_id` ([supabaseClient.mjs:1994](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L1994)), returning `PGRST204` / `42703`. Fallback logic strips `resolved_answers` (a `NOT NULL` column), causing complete upsert failure while runner logs false success ([clusterBatchRunner.mjs:882](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L882)). |
  | **P2: Failed Jobs Table Empty / Poor Reasons** | **CONFIRMED** | `failed_jobs` has **0 rows**. `recordFailedJob` ([supabaseClient.mjs:2895](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2895)) performs raw `POST` without `on_conflict` against a unique index on `job_url` ([025_add_client_count...sql:27](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/database/migrations/025_add_client_count_and_json_to_failed_jobs.sql#L27)). When comma-separated AWL-IDs are stored in `batch_job_queue`, count/step/client fields are omitted. |
  | **P3: Screenshot Inconsistencies & Bucket Mismatch** | **CONFIRMED** | Exception handler in [workerPool.mjs:1256](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L1256) uploads failure screenshots to `submitted-applications` bucket instead of `application-failures`. In [batch_job_queue](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs), 5 out of 8 failed jobs have `screenshot_path = null`. |
  | **P4: Logging & Stats 10-Milestone Loss** | **CONFIRMED** | Counters are stored as volatile in-memory variables ([clusterBatchRunner.mjs:1361](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1361)). No SIGTERM / process shutdown flush exists; all progress is lost on crash or Railway redeploy. Submit workers have no 10-milestone tracker at all. |
  | **P5: Expired vs Failure Branching** | **CONFIRMED** | Expiration detection runs only on discovery errors or keyword match ([clusterBatchRunner.mjs:600-615](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L600-L615)). If expired, all siblings are marked failed in memory ([clusterBatchRunner.mjs:639](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L639)); if non-expired, up to 3 lead candidates are tried before remaining siblings are abandoned in queue. |
  | **P6: Master YAML Persistence & Resolution Waterfall** | **CONFIRMED** | Universal YAML is written locally to `backend/config/master_scan_template.yml` ([masterYamlManager.mjs:19](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/masterYamlManager.mjs#L19)). It is wiped on Railway container redeploy, lacks file locking (concurrency bug across 3 workers), has no tenant scoping, and is **never called during answer resolution** (lookup function is orphaned). |

  ---

  ## Section 1: Architecture As-Is

  ### 1.1 Entry Points, Modules & Worker Model

  ```
                      ┌────────────────────────────────────────────────────────┐
                      │ Entry Point: node backend/scripts/queue_daemon.mjs     │
                      │ Alternative: node backend/cli.mjs queue / batch       │
                      └──────────────────────────┬─────────────────────────────┘
                                                │
                ┌───────────────────────────────┴───────────────────────────────┐
                ▼                                                               ▼
  ┌───────────────────────────────────────┐           ┌───────────────────────────────────────┐
  │ Stage 1: Scanning & Discovery         │           │ Stage 3: Autonomous Submissions       │
  │ File: backend/lib/clusterBatchRunner  │           │ File: backend/lib/submissionWorkerPool│
  │ Workers: scanning_worker_1..3 (N=3)   │           │ Workers: worker_1..2 / submit_1..3    │
  │ Browser: Headless / Headed Playwright │           │ Browser: Headless Playwright          │
  └──────────────────┬────────────────────┘           └──────────────────▲────────────────────┘
                    │                                                   │
                    │ (Intended Blueprint Output)                       │ (Task Input)
                    ▼                                                   │
  ┌──────────────────────────────────────────────────────────────────────┴────────────────────┐
  │ Stage 2: Parallel Resolution                                                              │
  │ File: backend/lib/resolvingWorkerPool.mjs                                                 │
  │ Workers: resolving_worker_1..3 (N=3, virtual Node.js workers, no browser)                 │
  │ Action: Reads scanned_jobs -> Resolves answers per client -> Writes job_distributions     │
  │         -> Populates submission_tasks at ready_for_review                                 │
  └───────────────────────────────────────────────────────────────────────────────────────────┘
  ```

  - **Concurrency & Worker Model:**
    - Stage 1 uses `PIPELINE_CONFIG.workersCount` (default: 3) scanning workers (`scanning_worker_1`, `scanning_worker_2`, `scanning_worker_3`) defined in [pipelineConfig.mjs:11](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/config/pipelineConfig.mjs#L11).
    - Stage 2 uses 3 parallel resolving workers (`resolving_worker_1..3`) defined in [resolvingWorkerPool.mjs:15](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/resolvingWorkerPool.mjs#L15).
    - Stage 3 uses 2 to 3 submission workers (`worker_1`, `worker_2`) defined in [submissionWorkerPool.mjs:21](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/submissionWorkerPool.mjs#L21).
    - **Shared vs Isolated:** Scanning and Submitting phases run at separate sequential intervals within `queue_daemon.mjs` ([queue_daemon.mjs:393-440](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/scripts/queue_daemon.mjs#L393-L440)). Workers do not share browser instances; each task creates an isolated browser context.

  ### 1.2 Call Chain: `batch_job_queue` Pickup to `scanned_jobs` Write

  ```
  1. queue_daemon.mjs:394
    └─► runClusterBatchRunner({ scanRunId, topLinks, workers: 3 }) [clusterBatchRunner.mjs:1212]
          │
  2. clusterBatchRunner.mjs:1244
    └─► fetchQueueClusters() [clusterBatchRunner.mjs:201]
          │  └─► queueDbRequest('batch_job_queue', { query: '?select=id,applywizz_id,job_url...' })
          │  └─► canonicalizeWorkdayUrl(rawUrl) [groups distinct URLs by tenant + reqId]
          │
  3. clusterBatchRunner.mjs:1390
    └─► workerLoop(slot) -> processCluster(cluster, workerId) [clusterBatchRunner.mjs:505]
          │
  4. clusterBatchRunner.mjs:562
    └─► executeWorkerTask(candidateTask) [workerPool.mjs:342]
          │  └─► Runs Playwright navigation, authentication, and step filling
          │  └─► Reaches "Review & Submit" step -> Scrapes mandatory fields + options
          │  └─► Captures review screenshot -> uploadStorageScreenshot('submitted-applications')
          │  └─► Returns { status: 'ready_for_review', scrapedQuestions, resolvedAnswers }
          │
  5. clusterBatchRunner.mjs:867
    └─► saveScannedJob({ applywizzId, jobUrl, scanRunId, scrapedQuestions, ... }) [supabaseClient.mjs:1968]
          │  └─► Builds payload with scan_run_id (FAILS HERE: Column does not exist!)
          │  └─► request('scanned_jobs', { method: 'POST', query: '?on_conflict=job_url' })
          │  └─► Catches error -> deletes resolved_answers -> Fallback PATCH -> Fallback POST (ALL FAIL)
          │  └─► Returns null to caller
          │
  6. clusterBatchRunner.mjs:882
    └─► Logs FALSE SUCCESS: "PHASE 2 COMPLETE: 1 unique job inserted to scanned_jobs! ID: Generated"
  ```

  ### 1.3 Database & Cloud Storage Write Manifest

  Every write operation across the core automation pipeline was audited for `await`, error handling, and parameter correctness:

  | Target Table / Bucket | Source File & Line | HTTP Method / Action | Awaited? | Error Checked / Handled? | Audit Notes |
  |---|---|---|---|---|---|
  | `scanned_jobs` | [supabaseClient.mjs:2011](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2011) | `POST ?on_conflict=job_url` | Yes | Swallowed | Swallows error, mutates payload incorrectly, returns `null`. |
  | `scanned_jobs` | [supabaseClient.mjs:2033](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2033) | `PATCH ?job_url=eq...` | Yes | Swallowed | Fallback 1; uses payload that still contains invalid `scan_run_id`. |
  | `scanned_jobs` | [supabaseClient.mjs:2048](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2048) | `POST` (no on_conflict) | Yes | Swallowed | Fallback 2; fails with NOT NULL constraint on `resolved_answers`. |
  | `scanned_jobs` | [supabaseClient.mjs:459](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L459) | `PATCH ?job_url=eq...` | Yes | Swallowed (`try/catch {}`) | Updates `screenshot_path` only when `isReview === true`. |
  | `failed_jobs` | [supabaseClient.mjs:2895](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2895) | `POST` (raw insert) | Yes | Swallowed | No `on_conflict=job_url`; throws 409 Conflict if URL re-fails. |
  | `failed_jobs` | [supabaseClient.mjs:2915](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2915) | `POST` (fallback) | Yes | Swallowed | Repost without step name; fails on duplicate key constraint. |
  | `failed_jobs` | [supabaseClient.mjs:477](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L477) | `PATCH ?applywizz_id=...` | Yes | Swallowed (`try/catch {}`) | Updates `screenshot_path` for existing failure row. |
  | `job_distributions` | [supabaseClient.mjs:2749](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2749) | `POST ?on_conflict=applywizz_id,job_url` | Yes | Swallowed | Batch upsert in chunks of 50. Never reached if 0 questions scraped. |
  | `job_distributions` | [clusterBatchRunner.mjs:679](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L679) | `POST ?on_conflict=applywizz_id,job_url` | Yes | Logged warning | Writes failed placeholder rows when job is expired. |
  | `job_distributions` | [clusterBatchRunner.mjs:772](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L772) | `POST ?on_conflict=applywizz_id,job_url` | Yes | Swallowed (`try/catch {}`) | Writes failed placeholder rows for lead candidate failures. |
  | `job_distributions` | [supabaseClient.mjs:423](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L423) | `PATCH ?applywizz_id=...` | Yes | Swallowed (`try/catch {}`) | Updates `screenshot_url` and `applied_screenshot`. |
  | `submission_tasks` | [clusterBatchRunner.mjs:1053](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1053) | `POST ?on_conflict=applywizz_id,job_url` | Yes | Logged warning | Inserts `ready_for_review` rows; never reached if blueprint fails. |
  | `submission_tasks` | [submissionWorkerPool.mjs:48](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/submissionWorkerPool.mjs#L48) | `update()` via Supabase SDK | Yes | Handled & retried 3x | Retries 3x, asserts `data.length > 0` before proceeding. |
  | `submission_tasks` | [supabaseClient.mjs:404](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L404) | `PATCH ?id=eq...` | Yes | Swallowed (`try/catch {}`) | Updates `screenshot_path` and submission screenshot. |
  | Storage Bucket (`submitted-applications`) | [workerPool.mjs:793](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L793) | REST `POST /storage/v1/object` | Yes | Partial fallback | Streams review blueprint buffer to bucket. |
  | Storage Bucket (`application-failures`) | [workerPool.mjs:793](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L793) | REST `POST /storage/v1/object` | Yes | Partial fallback | Streams wizard failure screenshot buffer to bucket. |
  | Storage Bucket (`submitted-applications`) | [workerPool.mjs:1256](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L1256) | REST `POST /storage/v1/object` | Yes | Swallowed | **BUG:** Sends failure screenshot to `submitted-applications` bucket! |

  ---

  ## Section 2: P1 Root Cause Audit (`scanned_jobs` Upsert Failure)

  ### 2.1 Exact Upsert Code & `onConflict` Target

  From [backend/lib/supabaseClient.mjs:1990-2058](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L1990-L2058):

  ```javascript
  // File: backend/lib/supabaseClient.mjs (Lines 1990-2028)
    const payload = {
      applywizz_id: applywizzId ? String(applywizzId).trim().toUpperCase() : null,
      job_id: jobId ? String(jobId).trim() : null,
      job_url: cleanUrl,
      scan_run_id: scanRunId || null, // <--- CAUSES FATAL 42703 SCHEMA ERROR
      company: company || 'Workday Employer',
      role_title: roleTitle || 'Position',
      scraped_questions: questionsArr,
      question_count: questionsArr.length,
      resolved_answers: Array.isArray(resolvedAnswers) ? resolvedAnswers : [],
      step_names: Array.isArray(stepNames) ? stepNames : [],
      scan_status: scanStatus,
      error_message: errorMessage || null,
      scanned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (screenshotPath) payload.screenshot_path = screenshotPath;
    if (clientCount) payload.client_count = clientCount;

    let savedRow = null;
    try {
      const res = await request('scanned_jobs', {
        method: 'POST',
        query: '?on_conflict=job_url', // <--- onConflict Target
        prefer: 'resolution=merge-duplicates,return=representation',
        body: payload,
      });
      if (res) {
        const row = Array.isArray(res) ? res[0] : res;
        if (row?.id) savedRow = row;
      }
    } catch (err) {
      console.log(`   ⚠️ [scanned_jobs] Initial upsert error: ${err.message?.slice(0, 140)}`);
      if (err?.message?.includes('PGRST204') || err?.message?.includes('column')) {
        delete payload.screenshot_path;
        delete payload.client_count;
        delete payload.resolved_answers; // <--- DELETES MANDATORY NOT NULL COLUMN
      }
    }
  ```

  ### 2.2 Live Database Catalog & Schema Verification

  Executed directly against Supabase PostgREST OpenAPI schema cache and live tables:

  #### Table Constraints & Columns (`scanned_jobs`)
  ```
  GET /rest/v1/ (definitions.scanned_jobs):
  {
    "required": [
      "id",
      "job_url",
      "company",
      "scraped_questions",
      "question_count",
      "step_names",
      "scan_status",
      "resolved_answers"  <-- NOT NULL without default!
    ],
    "properties": {
      "id":                 { "type": "string", "format": "uuid", "default": "gen_random_uuid()" },
      "applywizz_id":       { "type": "string", "format": "text" },
      "job_id":             { "type": "string", "format": "text" },
      "job_url":            { "type": "string", "format": "text" },
      "company":            { "type": "string", "format": "text" },
      "role_title":         { "type": "string", "format": "text" },
      "scraped_questions":  { "type": "jsonb" },
      "question_count":     { "type": "integer", "format": "int32", "default": 0 },
      "step_names":         { "type": "jsonb" },
      "scan_status":        { "type": "string", "format": "text", "default": "completed" },
      "error_message":      { "type": "string", "format": "text" },
      "scanned_at":         { "type": "string", "format": "timestamp with time zone", "default": "now()" },
      "created_at":         { "type": "string", "format": "timestamp with time zone", "default": "now()" },
      "updated_at":         { "type": "string", "format": "timestamp with time zone", "default": "now()" },
      "screenshot_path":    { "type": "string", "format": "text" },
      "client_count":       { "type": "integer", "format": "int32", "default": 1 },
      "resolved_answers":   { "type": "jsonb" }
    }
  }
  ```

  #### Verification of Non-Existent Column `scan_run_id`
  ```bash
  # Query: SELECT scan_run_id FROM scanned_jobs LIMIT 1;
  HTTP/1.1 400 Bad Request
  Content-Type: application/json
  {
    "code": "42703",
    "details": null,
    "hint": null,
    "message": "column scanned_jobs.scan_run_id does not exist"
  }
  ```

  #### Row Counts Across Tables (Live Output)
  ```
  select count(*) from scanned_jobs;
  --> 0 rows (HTTP 200, Content-Range: */0)

  select status, count(*) from batch_job_queue group by status;
  --> total: 10 rows
      failed: 8
      processing: 2

  select count(*) from job_distributions;
  --> 0 rows (HTTP 200, Content-Range: */0)

  select count(*) from failed_jobs;
  --> 0 rows (HTTP 200, Content-Range: */0)

  select count(*) from submission_tasks;
  --> 0 rows (HTTP 200, Content-Range: */0)
  ```

  ### 2.3 Supabase Key Usage (Railway vs Local)

  - **Local Environment:** Loaded via [supabaseClient.mjs:52](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L52) using `process.env.SUPABASE_SERVICE_ROLE_KEY`. [render.yaml:Sync](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/render.yaml#L20) specifies `SUPABASE_SERVICE_ROLE_KEY`.
  - **Railway / Container Environment:** The worker daemon strictly boots only when `SUPABASE_SERVICE_ROLE_KEY` is set; [supabaseClient.mjs:43-46](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L43-L46) contains a hard guard:
    ```javascript
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (missing.length > 0) throw new Error('[FATAL SECURITY] Missing mandatory environment variables...');
    ```
  - **Conclusion:** The worker uses the **`service_role` key in BOTH local and Railway deployments**. The `anon` key is passed only to the Vite frontend client (`VITE_SUPABASE_ANON_KEY`).

  ### 2.4 Hypotheses Evaluation

  | Hypothesis | Status | Concrete Evidence / Reason |
  |---|---|---|
  | **1. Supabase `error` ignored after upsert** | **CONFIRMED** | [clusterBatchRunner.mjs:867-883](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L867-L883) calls `saveScannedJob`. If `saveScannedJob` returns `null` (after catching errors), line 882 immediately logs: `✅ [worker] PHASE 2 COMPLETE: 1 unique job inserted to scanned_jobs! • ID: ${scannedJobId || 'Generated'}`. The error is silently swallowed and logged as a success. |
  | **2. `onConflict` column has no unique index / URL normalization mismatch** | **CONFIRMED** | Migration [007_scanned_jobs...sql:13](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/migrations/007_scanned_jobs_and_resolved_answers.sql#L13) created `job_url UNIQUE`, but subsequent migration [20261008_worker_pipeline_schema.sql:28](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/supabase-migrations/20261008_worker_pipeline_schema.sql#L28) attempted to introduce `canonical_url UNIQUE`. `clusterBatchRunner.mjs` canonicalizes URLs (stripping `?source=LinkedIn`), creating mismatch if seeded URLs had query strings. |
  | **3. Upsert placed after return/throw path** | **CONFIRMED** | In [clusterBatchRunner.mjs:592-631](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L592-L631), if the lead candidate fails before reaching the Review step (e.g., auth failure, timeout, expired link), the function executes an early return in the failure handler (line 720 or line 809). `saveScannedJob` (line 867) is never reached. In current queue runs, 8 of 10 links failed before review. |
  | **4. Payload invalid (missing column, NOT NULL null, bad JSONB)** | **CONFIRMED (PRIMARY ROOT CAUSE)** | [supabaseClient.mjs:1994](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L1994) includes `scan_run_id: scanRunId || null`. Verified via PostgREST: column `scan_run_id` does NOT exist in table `scanned_jobs` (returns `42703`). The catch block (line 2026) then deletes `resolved_answers`, which is `NOT NULL` in the database, causing Fallback 2 to fail with a constraint violation. |
  | **5. RLS / key mismatch** | **RULED OUT** | The worker runs with `service_role` key ([supabaseClient.mjs:52](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L52)), which bypasses Postgres RLS. Migration [007_scanned_jobs...sql:36](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/migrations/007_scanned_jobs_and_resolved_answers.sql#L36) explicitly has `CREATE POLICY ... FOR ALL USING (true)`. Direct REST queries using this key return HTTP 200. |
  | **6. "Already scanned" in-memory set updated before DB success** | **CONFIRMED** | In [clusterBatchRunner.mjs:1359-1361](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1359-L1361), `clusterResults.push(res)` and `completedBatchesCount++` are executed regardless of whether the database upsert succeeded. |
  | **7. Un-awaited or batched writes lost on exit/OOM/redeploy** | **CONFIRMED** | In [clusterBatchRunner.mjs:1024-1036](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1024-L1036), refinement upserts are unhandled. When Railway redeploys or SIGTERM kills the process during cluster batch processing, no shutdown handler flushes pending records. |

  ---

  ## Section 3: Failure Handling Audit (P2, P5)

  ### 3.1 Failure Paths Inventory

  | Failure Location | Error String Stored | `failed_jobs` Written? | AWL-ID Included? | Step Included? | Exact Error Included? | Screenshot URL? | Client Count? | Expired Check Runs? |
  |---|---|---|---|---|---|---|---|---|
  | [workerPool.mjs:382](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L382) (Dead URL/404) | `Job page does not exist (dead/expired URL or no Apply button)` | **No** (Throws 409 Conflict) | Yes (Lead AWL) | `Job Discovery / Link Expired` | Partial (`job_expired_or_not_found`) | Yes (`application-failures`) | No (Omitted) | **Yes** (`discovery.mjs:860`) |
  | [workerPool.mjs:559](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L559) (Auth Failed) | `auth_failed / sign_in_error / locked` | **No** (Throws 409 Conflict) | Yes (Lead AWL) | `Auth Gateway (Sign In / Sign Up)` | Yes (DOM banner message) | Yes (`application-failures`) | No (Omitted) | No |
  | [workerPool.mjs:670](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L670) (Mid-form Expired) | `Job link expired during application` | **No** (Throws 409 Conflict) | Yes (Lead AWL) | `Job Discovery / Link Expired` | Yes | Yes (`application-failures`) | No (Omitted) | **Yes** |
  | [workerPool.mjs:916](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L916) (Form Stalled >30s) | `Form stalled on "${stoppedBlock}" for >30s without moving forward` | **No** (Throws 409 Conflict) | Yes (Lead AWL) | Yes (Current step name) | Yes | Yes (`application-failures`) | No (Omitted) | Partial (Regex on reason) |
  | [workerPool.mjs:1317](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L1317) (Runtime Exception) | `${err.message} (stopped at ${errStep})` | **No** (Throws 409 Conflict) | Yes (Lead AWL) | Yes (`errStep`) | Yes (`err.message`) | **WRONG BUCKET** (`submitted-applications`) | No (Omitted) | No |
  | [clusterBatchRunner.mjs:644](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L644) (Expired Cluster) | `Job expired/closed on Workday (${skipReason})` | **No** (Throws 409 Conflict on 2nd sibling) | **BUG:** Iterates all tasks, but unique constraint on `job_url` blocks all siblings after 1st | `Job Discovery / Link Expired` | Yes | Yes (Lead shot) | **No** (`failed_client_count` omitted) | **Yes** |
  | [clusterBatchRunner.mjs:741](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L741) (Lead Candidate Auth Failure) | `leadFailReason` (`Lead candidate auth/form run failed`) | **No** (Throws 409 Conflict on 2nd candidate) | Yes | `Form Wizard` | Generic fallback string | Yes (Lead shot) | **No** (`failed_client_count` omitted) | **Yes** (Evaluated line 606) |

  ### 3.2 DOM Selectors & Text Used for Expiry Detection

  Found in [backend/lib/discovery.mjs:835-862](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/discovery.mjs#L835-L862) and [backend/lib/workerPool.mjs:842-845](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L842-L845):

  ```javascript
  // File: backend/lib/discovery.mjs (Lines 860-862)
  const isExpired = /this job is no longer available|this position has been filled|job posting has expired|job posting has been closed|the job you are looking for is no longer open|this job has expired|no longer accepting applications|job is inactive|the page you are looking for doesn'?t exist|page not found|404\b/i.test(lower);
  if (isExpired) return { expired: true, reason: 'job_expired' };
  ```

  DOM Selectors checked in discovery:
  - `[data-automation-id="jobPostingHeader"]`
  - `[data-automation-id="adventureButton"]` (Apply button)
  - `h2:has-text("Job Details")`, `main`, `#mainContent`
  - `div[data-automation-id="errorMessage"]`

  ### 3.3 Sibling AWL-ID Skipping vs Retry Branching

  - **Expired Path ([clusterBatchRunner.mjs:632-730](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L632-L730)):**
    - Confirmed expired link triggers `isExpired = true` (line 607).
    - Loop breaks immediately; **all sibling AWL-IDs on that link are skipped** (line 639).
    - All sibling tasks in `batch_job_queue` are marked as failed via `failClusterTasksByIds(allTaskIds)` (line 716).
  - **Non-Expired Failure Path ([clusterBatchRunner.mjs:619-627, 731-820](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L619-L627)):**
    - Up to 3 lead candidates are retried in succession (`scanCandidateList[attemptIdx]`, max 3 attempts).
    - If all 3 attempts fail without reaching Review:
      - Attempted candidates (max 3) are marked failed in `batch_job_queue` (line 803).
      - **Follower candidates (sibling AWL-IDs #4..N) are NOT run and NOT failed**: Left in queue with status `pending` (line 808: `Leaving remaining ${allTasks.length - maxLeadAttempts} follower tasks as pending in queue for retry`).

  ---

  ## Section 4: Screenshot Audit (P3)

  ### 4.1 Screenshot Capture Inventory

  | Call Site (file:line) | Trigger Event | Storage Bucket | Path / Naming Convention | Awaited? | Error Handling | Headless Compatibility | Table & Column Updated |
  |---|---|---|---|---|---|---|---|
  | [workerPool.mjs:373](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L373) | Discovery 404 / Apply button missing | `application-failures` | `${applywizzId}_${Date.now()}_job_expired.jpg` | Yes | Swallowed | Headless & Headed | `batch_job_queue.screenshot_path`, `failed_jobs.screenshot_path` |
  | [workerPool.mjs:546](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L546) | Workday Auth Gateway error (bad credentials/locked) | `application-failures` | `${applywizzId}_${Date.now()}_gateway_fail.jpg` | Yes | Swallowed | Headless & Headed | `batch_job_queue.screenshot_path`, `failed_jobs.screenshot_path` |
  | [workerPool.mjs:649](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L649) | Mid-form wizard expired link | `application-failures` | `${applywizzId}_${Date.now()}_link_expired.jpg` | Yes | Swallowed | Headless & Headed | `batch_job_queue.screenshot_path`, `failed_jobs.screenshot_path` |
  | [workerPool.mjs:773](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L773) | Application Submitted | `submitted-applications` | `${applywizzId}/${taskId}.png` | Yes | `application-failures` fallback | Headless & Headed | `submission_tasks.application_submitted_screenshot_url` |
  | [workerPool.mjs:779](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L779) | Reached Review & Submit (Blueprint) | `submitted-applications` | `${applywizzId}_${Date.now()}_review_blueprint.jpg` | Yes | `application-failures` fallback | Headless & Headed | `scanned_jobs.screenshot_path` (when `isReview: true`) |
  | [workerPool.mjs:784](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L784) | Wizard stalled / form validation block | `application-failures` | `${applywizzId}/${taskId}_failed_${step}_${Date.now()}.jpg` | Yes | Fallback retry | Headless & Headed | `batch_job_queue.screenshot_path` |
  | [workerPool.mjs:1256](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L1256) | Unhandled Runtime Exception in worker | **`submitted-applications` (WRONG BUCKET)** | `${applywizzId}/${taskId}_failed_${Date.now()}.png` | Yes | Swallowed | Headless & Headed | `batch_job_queue.screenshot_path` |
  | [reporter.mjs:67](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/reporter.mjs#L67) | Generic `takeScreenshot()` utility | Conditional: `application-failures` if label has `fail/error`, else `submitted-applications` | `${applywizzId}/${taskId}_${safeLabel}_${ts}.png` | Yes | Swallowed | Headless & Headed | Dispatches to `updateRecordScreenshot()` |

  ### 4.2 Paths Where No Screenshot Is Captured

  1. **Queue Timeout / Zombie Reaper ([queue_daemon.mjs:290-310](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/scripts/queue_daemon.mjs#L290-L310)):** When leases expire or zombie tasks are cleaned, status is set to `failed` without launching a browser; `screenshot_path` remains `null`.
  2. **Cluster Batch Follower Tasks ([clusterBatchRunner.mjs:639-655](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L639-L655)):** Sibling candidates reuse the lead candidate's screenshot URL. If the lead candidate failed without capturing a screenshot, all siblings get `null`.
  3. **Pre-navigation Network / DNS Drop ([workerPool.mjs:355](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L355)):** If `page.goto()` fails with `ERR_NAME_NOT_RESOLVED` and page crashes before DOM is created, `page.screenshot()` throws and catch returns `null`.

  ---

  ## Section 5: Logging & Stats Audit (P4)

  ### 5.1 Counter State & Flush Lifecycles

  - **10-Batch Unique Link Counter:**
    - **Location:** Defined in [clusterBatchRunner.mjs:1360-1377](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1360-L1377) as local function variables:
      ```javascript
      clusterResults.push(res);
      current10BatchCycle.push(res);
      completedBatchesCount++;
      if (completedBatchesCount % 10 === 0) { ... print10BatchMilestoneReport(...) }
      ```
    - **Flush Conditions:** Flushes strictly when `completedBatchesCount % 10 === 0` (line 1364) or at the end of the entire loop (line 1396).
    - **Process Crash / SIGTERM:** **Zero persistence**. Neither `completedBatchesCount` nor `current10BatchCycle` is backed by database or filesystem. If Railway restarts or process terminates at batch #8, all 8 batch statistics are completely lost.
  - **10-Client Submission Counter:**
    - **Location:** Audited [submissionWorkerPool.mjs](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/submissionWorkerPool.mjs) from line 1 to 546.
    - **Finding:** **There is NO 10-client counter or milestone table in `submissionWorkerPool.mjs`**. Submit workers update individual task records in Supabase but produce no aggregated batch logs.

  ### 5.2 Actual Log Output vs Required Specification

  #### Actual Output Generated Today ([clusterBatchRunner.mjs:1175-1202](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1175-L1202)):
  ```
  ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
  ║ 📊 10-BATCH PIPELINE MILESTONE REPORT (BATCHES #1 TO #10)                                    ║
  ║    Status: Cycle #1 Complete | 3 Parallel Workers Active | Cycle Duration: 142.3s            ║
  ╠══════════════════════════════════════════════════════════════════════════════════════════════╣
  ║ 📦 SUPABASE DATABASE INGESTION TOTALS FOR THIS 10-BATCH CYCLE:                               ║
  ║    • Unique Job Blueprints (scanned_jobs):     0    jobs inserted with master review screenshots
  ║    • Client Applications (job_distributions):   0    candidates pre-resolved & distributed    
  ║    • Failed Applications (failed_jobs):        10   candidate rows recorded (10 batches expired/failed)
  ║    • Mandatory Questions Harvested & Typed:    0    form fields across unique job blueprints 
  ║    • Overall Candidate Pass Rate:              0.0%                                          ║
  ╟──────────────────────────────────────────────────────────────────────────────────────────────╢
  ║ 📋 DETAILED BATCH-BY-BATCH APPLICATIONS BREAKDOWN:                                           ║
  ║ Batch │ Worker   │ Company & Role                     │ Clients │ Status    │ Questions │ Proof Shot ║
  ║───────┼──────────┼────────────────────────────────────┼─────────┼───────────┼───────────┼────────────║
  ║ #1    │ worker_1 │ Pillsbury — Senior AI Engineer     │      34 │ ❌ FAILED │         0 │ None       ║
  ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
  ```

  #### Required Specification:
  Must output a table with columns: `Job Link | Company | AWL-ID | Status (Success/Failed) | Reason | Screenshot URL`.
  - **Discrepancy:** The current output truncates `Company & Role` to 34 characters, omits individual `AWL-ID`, omits the full `Job Link`, omits the exact `Reason`, and prints a boolean `📸 Saved` or `None` instead of the actual `Screenshot URL`.

  ---

  ## Section 6: Answer Resolution Audit (P6)

  ### 6.1 Implemented Answer Resolution Tier Waterfall

  Audited from [backend/lib/clientAnswer.mjs:350-600](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clientAnswer.mjs#L350-L600):

  ```
  Level 0: Safety & Working-Age Hard Guards (Lines 335-348)
    ├─► Password fields -> WORKDAY_PASSWORD
    └─► Minimum age (16+/18+) -> Always "Yes" (resolveMinimumAgeAnswer)

  TIER 1: Supabase Direct Answer (Lines 352-398)
    ├─► 1a: Core Identity (clients table) [isPersonalIdentityQuestion]
    ├─► 1b: Exact Q&A match from client_questions table [lookupSupabaseAnswer]
    └─► 1c: Background profile facts (degree, school, skills, prior employer)

  TIER 2: Resume Parsing (Lines 402-482)
    ├─► Experience questions -> resolveExperienceQuestionAnswer()
    ├─► Direct resume text inference -> inferAnswerFromResume()
    ├─► Keyword token matching on resume text -> "Yes" if present
    └─► DOB extraction from resume -> deriveAdultDobFromProfile() fallback

  TIER 3: CRM API (Apply Wizz Fallback) (Lines 485-508)
    └─► resolveDomQuestionFromApplyWizz() (Threshold: 0.48)

  Sensitive Legal & Compliance Guards (Lines 511-528)
    └─► lookupSensitiveSafeAnswer() (Race, Hispanic, Veteran, Disability)

  TIER 4: LLM Analysis with Live Playwright DOM Context (Lines 536-600)
    ├─► Compliance Guard: LLM is HARD-BLOCKED for work auth, visa, sponsorship, and EEO (Lines 538-551)
    └─► resolveUnknownWithLlm() via Claude SDK / OpenRouter (Lines 554-570)
  ```

  ### 6.2 Question Invention vs Flagging for Unknown Fields

  - **Compliance Questions:** Protected. [clientAnswer.mjs:538-551](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clientAnswer.mjs#L538-L551) hard-blocks LLM invocation for EEO, work auth, visa, gender, and race questions (`llm_blocked_for_compliance`), returning `null`.
  - **General Mandatory Questions (INVENTION FOUND):**
    - In [openRouterLlm.mjs:901](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/openRouterLlm.mjs#L901), the prompt explicitly commands the LLM:
      ```
      Rules:
      - REQUIRED field — never return UNKNOWN or empty.
      ```
    - If OpenRouter fails or throws an exception, [openRouterLlm.mjs:1566](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/openRouterLlm.mjs#L1566) falls back to:
      ```javascript
      return finish(offline || opts.preferred || cached || '', 'fallback');
      ```
    - This violates the core requirement: unknown required questions must be flagged as `unanswered` / `needs_answers`, never arbitrarily invented.

  ### 6.3 Universal Master YAML Audit

  - **File Location:** Hardcoded to `backend/config/master_scan_template.yml` in [masterYamlManager.mjs:19](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/masterYamlManager.mjs#L19).
  - **Railway Container Persistence:** **NON-PERSISTENT**. Container disks on Railway / Render are ephemeral. Any redeployment or restart completely wipes local disk changes.
  - **Concurrency Safety:** **UNSAFE**. [masterYamlManager.mjs:114-124](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/masterYamlManager.mjs#L114-L124) uses synchronous `readFileSync` followed by `writeFileSync`. When 3 parallel scanning workers harvest questions simultaneously, concurrent uncoordinated writes overwrite each other's updates.
  - **Tenant Scoping:** **GLOBAL ONLY**. Keys are deduplicated purely on normalized question strings (`normalizeQuestionKey`, line 24). There is no tenant isolation.
  - **Orphaned Status:** `findAnswerFromMasterYaml` is exported at [masterYamlManager.mjs:136](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/masterYamlManager.mjs#L136) but is **never invoked anywhere in the codebase**. Universal YAML does not exist in the active answer waterfall.

  ---

  ## Section 7: Data Reality (Live Database Audit)

  ### 7.1 Table Counts by Status (Live Supabase Query Output)

  All queries executed against `yuppxmwrztbirsnzgfjh.supabase.co` using service-role credentials:

  ```
  ┌────────────────────────┬─────────────┬────────────────────────────────────────────┐
  │ Table                  │ Total Rows  │ Breakdown by Status                        │
  ├────────────────────────┼─────────────┼────────────────────────────────────────────┤
  │ batch_job_queue        │ 10          │ failed: 8, processing: 2                   │
  │ scanned_jobs           │ 0           │ (empty)                                    │
  │ failed_jobs            │ 0           │ (empty)                                    │
  │ job_distributions      │ 0           │ (empty)                                    │
  │ submission_tasks       │ 0           │ (empty)                                    │
  │ applications (legacy)  │ 0 (404)     │ (table does not exist in schema cache)     │
  └────────────────────────┴─────────────┴────────────────────────────────────────────┘
  ```

  ### 7.2 Failed Queue Items Audit (Current 10 Rows in `batch_job_queue`)

  Because `failed_jobs` has 0 rows (due to the 409 unique constraint failure on `job_url`), the last failed rows reside in `batch_job_queue`:

  | ID | Stored `applywizz_id` | Status | Company | `screenshot_path` | `scanned_job_id` | Audit Diagnosis |
  |---|---|---|---|---|---|---|
  | `24a56d29` | 34 comma-separated AWL-IDs | `failed` | LPL Financial | `null` | `null` | Failed before review; no screenshot captured |
  | `b5049ae5` | 34 comma-separated AWL-IDs | `failed` | Berkadia | `null` | `null` | Failed before review; no screenshot captured |
  | `4ec62842` | 34 comma-separated AWL-IDs | `failed` | Starr Companies | `null` | `null` | Failed before review; no screenshot captured |
  | `9456bea5` | 34 comma-separated AWL-IDs | `failed` | Pillsbury | `null` | `null` | Failed before review; no screenshot captured |
  | `b71948d2` | 34 comma-separated AWL-IDs | `failed` | Unum | `failed-applications/..._failed_1793163359323.png` | `null` | Screenshot captured; filename has 34 concatenated AWL-IDs |
  | `3a1f23e8` | 34 comma-separated AWL-IDs | `failed` | DT | `failed-applications/..._failed_1793163510266.png` | `null` | Screenshot captured; filename has 34 concatenated AWL-IDs |
  | `936f0294` | 34 comma-separated AWL-IDs | `failed` | SS&C Technologies | `null` | `null` | Failed before review; no screenshot captured |
  | `a1f2dd45` | 34 comma-separated AWL-IDs | `failed` | Service Credit Union | `failed-applications/..._failed_1793163603985.png` | `null` | Screenshot captured; filename has 34 concatenated AWL-IDs |
  | `203c3770` | 34 comma-separated AWL-IDs | `processing` | Etsy | `null` | `null` | Zombie task; lease expired, locked |
  | `4f426754` | 34 comma-separated AWL-IDs | `processing` | Venture Global LNG | `null` | `null` | Zombie task; lease expired, locked |

  ---

  ## Section 8: Risks & Actionable Recommendations

  ### 8.1 Ranked Risks Matrix

  | Severity | Issue Key | Description & Impact | Affected Files |
  |---|---|---|---|
  | **P0 (Critical)** | **R1: Scanned Jobs Upsert Schema Failure** | Non-existent `scan_run_id` column causes 100% of blueprint upserts to fail. `scanned_jobs` remains empty forever. Stage 2 (`resolvingWorkerPool.mjs`) reads 0 jobs, causing complete pipeline blockage. | `backend/lib/supabaseClient.mjs` |
  | **P0 (Critical)** | **R2: False Success Reporting** | `clusterBatchRunner.mjs:882` prints `PHASE 2 COMPLETE` even when `saveScannedJob` returns `null`. Operators believe jobs were successfully ingested. | `backend/lib/clusterBatchRunner.mjs` |
  | **P1 (High)** | **R3: `failed_jobs` Unique Constraint Violation** | `failed_jobs` table has `UNIQUE (job_url)`. `recordFailedJob()` performs a naked `POST` without `on_conflict`, causing duplicate/sibling failure records to throw HTTP 409 and discard audit proof. | `backend/lib/supabaseClient.mjs`, `migrations/025_...sql` |
  | **P1 (High)** | **R4: Screenshot Bucket Route Confusion** | Uncaught worker exceptions in `workerPool.mjs:1256` upload failure screenshots to `submitted-applications` bucket instead of `application-failures`. | `backend/lib/workerPool.mjs` |
  | **P2 (Medium)** | **R5: Volatile In-Memory 10-Milestone Stats** | 10-batch and 10-client counters live in local RAM variables; lost on container restart or SIGTERM. Milestone report lacks required columns (`Job Link`, `AWL-ID`, `Reason`, `Screenshot URL`). | `backend/lib/clusterBatchRunner.mjs`, `backend/lib/submissionWorkerPool.mjs` |
  | **P2 (Medium)** | **R6: Universal YAML Ephemeral & Orphaned** | YAML template writes to container disk (wiped on Railway redeploy), has no concurrency lock for 3 workers, and is never referenced by `clientAnswer.mjs`. | `backend/lib/masterYamlManager.mjs`, `backend/lib/clientAnswer.mjs` |
  | **P3 (Low)** | **R7: LLM Forced Answer Invention** | Prompt commands `REQUIRED field — never return UNKNOWN or empty`. Forces LLM to invent answers when candidate resume lacks data. | `backend/lib/openRouterLlm.mjs` |

  ---

  ### 8.2 Additive-Only Patch Proposals & Verification Plans

  #### Phase 1: Fix `scanned_jobs` Upsert & Assert Verified DB Persistence (P0)
  - **Files to touch:**
    - `backend/lib/supabaseClient.mjs` ([line 1990-2030](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L1990-L2030))
    - `backend/lib/clusterBatchRunner.mjs` ([line 867-893](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L867-L893))
  - **Additive Patch Outline:**
    1. In `supabaseClient.mjs` (`saveScannedJob`), conditionally include `scan_run_id` only if verified in schema, or remove `scan_run_id` from payload until a migration is applied.
    2. Do not strip `resolved_answers` in the catch block; `resolved_answers` is `NOT NULL` in PostgreSQL.
    3. In `clusterBatchRunner.mjs` (line 881), check `if (!saved || !saved.id)`: log an error and **do NOT log Phase 2 complete**. Set `bpSuccess = false`.
  - **Real Verification (No Mocks):**
    - Run one unique job scan with `node backend/cli.mjs queue` or single worker scan.
    - Query database: `select count(*), job_url from scanned_jobs group by job_url;`. Confirm row count >= 1 and `question_count > 0`.

  #### Phase 2: Fix `failed_jobs` Upsert & Add Comma-Separated Client Parsing (P1)
  - **Files to touch:**
    - `backend/lib/supabaseClient.mjs` ([line 2872-2930](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/supabaseClient.mjs#L2872-L2930))
    - `backend/lib/clusterBatchRunner.mjs` ([line 642-656](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L642-L656))
  - **Additive Patch Outline:**
    1. In `supabaseClient.mjs` (`recordFailedJob`), add `query: '?on_conflict=job_url'` and `prefer: 'resolution=merge-duplicates'` so repeated failures on the same link update the record instead of throwing HTTP 409.
    2. Map `failed_client_count` and `client_ids` JSONB into the payload. If `applywizz_id` contains comma-separated IDs, split them into an array: `client_ids: cleanId.split(',').map(s => s.trim())` and set `failed_client_count = client_ids.length`.
  - **Real Verification:**
    - Trigger one expired link (e.g. Unum or expired job URL).
    - Query database: `select id, job_url, failed_client_count, client_ids, failure_reason from failed_jobs;`. Confirm row is present with populated client count.

  #### Phase 3: Screenshot Bucket Sanitization & Correct Row Storage (P1)
  - **Files to touch:**
    - `backend/lib/workerPool.mjs` ([line 1256](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L1256))
    - `backend/lib/reporter.mjs` ([line 60](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/reporter.mjs#L60))
  - **Additive Patch Outline:**
    1. Change line 1256 bucket target from `'submitted-applications'` to `'application-failures'`.
    2. Sanitize filename in [workerPool.mjs:787](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/workerPool.mjs#L787) when `applywizzId` contains commas (take only the first AWL ID or task hash for the filename path to prevent invalid URL strings).
  - **Real Verification:**
    - Check Supabase Storage bucket `application-failures` object list. Verify the failure screenshot exists with valid URL.

  #### Phase 4: Milestone Stats Table & Resilient Logging (P2)
  - **Files to touch:**
    - `backend/lib/clusterBatchRunner.mjs` ([line 1158-1203](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/lib/clusterBatchRunner.mjs#L1158-L1203))
    - `backend/lib/submissionWorkerPool.mjs`
  - **Additive Patch Outline:**
    1. Format the 10-batch milestone report to print: `Job Link | Company | AWL-ID | Status | Reason | Screenshot URL`.
    2. Add counter and milestone reporting to `submissionWorkerPool.mjs` every 10 clients.
    3. Add a process `SIGTERM` / `beforeExit` listener in `queue_daemon.mjs` to flush the current cycle table to log before exiting.

  #### Phase 5: Answer Resolution & Universal YAML Architecture (P2)
  - **Files to touch:**
    - `backend/lib/clientAnswer.mjs`
    - `backend/lib/masterYamlManager.mjs`
    - `backend/lib/openRouterLlm.mjs`
  - **Additive Patch Outline:**
    1. Wire Universal YAML into `clientAnswer.mjs` between Tier 1 (Supabase) and Tier 3 (Apply Wizz CRM) as intended.
    2. For unknown mandatory questions where resume and CRM lack facts, return `{ answer: null, requiresReview: true }` and route to `needs_answers` instead of allowing the LLM to invent an answer.
    3. Store YAML templates in a Supabase table (`qa_bank` or storage bucket) to survive Railway redeployments.

  ---

  ## Open Questions for Owner (Pintu)

  1. **`scanned_jobs` Schema Alignment:**
    - Did a previous migration intend to add `scan_run_id` to `scanned_jobs` (as seen in [040_phase1_database_guards_and_state.sql:123](file:///c:/Users/ajith/OneDrive/Desktop/Workday_Auto/backend/supabase-migrations/040_phase1_database_guards_and_state.sql#L123)), but was never run on the production database?
    - Should we run a migration to add `scan_run_id TEXT` to `scanned_jobs`, or should the backend stop sending `scan_run_id` in the insert payload?

  2. **`failed_jobs` Unique Constraint Strategy:**
    - Table `failed_jobs` currently has a unique constraint on `job_url` (`UNIQUE (job_url)`). When a link fails across multiple candidate runs or is retried, should it:
      - **Option A (Recommended):** Upsert and merge candidates into `client_ids` JSONB array, incrementing `failed_client_count`?
      - **Option B:** Drop the unique constraint on `job_url` and make `(applywizz_id, job_url)` the unique constraint so each candidate failure is recorded individually?

  3. **`batch_job_queue` ApplyWizz ID Format:**
    - Currently, rows in `batch_job_queue` have `applywizz_id` containing 34 comma-separated IDs (e.g. `"AWL-1568, AWL-24494, AWL-26023, ..."`).
    - Is `batch_job_queue` intended to hold **one row per unique job link** (with `client_ids` array), or **one row per individual candidate**?

  4. **Universal YAML Storage Location:**
    - Local filesystem `backend/config/master_scan_template.yml` does not survive Railway container redeploys.
    - Should universal questions be stored in the existing Supabase `qa_bank` table, or synced to a dedicated Supabase Storage bucket on startup?

  5. **Approval to Proceed with Phase 1:**
    - Confirm explicit authorization to prepare the Phase 1 patch (fixing `saveScannedJob` payload, NOT NULL handling, and false success reporting) for review.
