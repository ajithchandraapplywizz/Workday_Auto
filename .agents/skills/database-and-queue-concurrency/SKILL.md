---
name: database-and-queue-concurrency
description: >-
  Supabase PostgreSQL database patterns, queue concurrency, and state invariants for Workday Auto.
  Governs atomic Compare-And-Swap (CAS) task claiming, lease expiration reaping, multi-replica webhook
  synchronization, on_conflict deduplication (e.g. qa_bank tenant/question unique keys), and the strict
  immutability guarantee of submitted applications and cloud proof screenshots. Activate when writing database
  queries, updating queue daemon logic, running migrations, or diagnosing task race conditions.
---

# Database & Queue Concurrency Mastery

This skill defines the data integrity invariants and queue concurrency controls governing Workday Auto's interaction with Supabase PostgreSQL and background queue daemons.

---

## 1. Permanent Immutability of Submitted Applications

### Non-Negotiable Law
Once a job distribution row in `job_distributions` reaches `status = 'submitted'` or possesses a verified proof screenshot in `application_submitted_screenshot_url`:
- **It can NEVER be downgraded** to `ready_for_review`, `applying`, or `failed`.
- Any automated re-scan, batch re-ingestion, or retry daemon MUST check the existing row and refuse to overwrite submitted rows.

### Implementation Standard
```javascript
// backend/lib/submissionWorkerPool.mjs
export async function updateJobDistributionWithCheck(supabase, id, patch) {
  // 1. Fetch current status and proof screenshot
  const { data: existing } = await supabase
    .from('job_distributions')
    .select('status, application_submitted_screenshot_url')
    .eq('id', id)
    .single();

  if (existing?.status === 'submitted' || existing?.application_submitted_screenshot_url) {
    logger.warn(`Refusing to overwrite submitted application ${id}`);
    return;
  }

  // 2. Strip null screenshot overwrites
  const safePatch = { ...patch };
  if (safePatch.application_submitted_screenshot_url === null) {
    delete safePatch.application_submitted_screenshot_url;
  }

  // 3. Execute update with status guard
  await supabase
    .from('job_distributions')
    .update(safePatch)
    .eq('id', id)
    .neq('status', 'submitted');
}
```

---

## 2. Atomic Compare-And-Swap (CAS) Task Claiming

To prevent double-claims and race conditions when multiple worker replicas poll the queue concurrently:

```javascript
// Step 1: Candidate query with status guard
const { data: candidates } = await supabase
  .from('job_distributions')
  .select('id, applywizz_id, job_url, attempts')
  .eq('status', 'ready_for_review')
  .is('application_submitted_screenshot_url', null)
  .order('created_at', { ascending: true })
  .limit(10);

// Step 2: Atomic lease claim via CAS
for (const cand of candidates) {
  const { data: claimed, error } = await supabase
    .from('job_distributions')
    .update({
      status: 'applying',
      worker_id: workerId,
      lease_expires_at: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    })
    .eq('id', cand.id)
    .eq('status', 'ready_for_review') // CAS constraint
    .select()
    .single();

  if (claimed && !error) {
    return claimed; // Successfully locked task
  }
}
```

---

## 3. Conflict Deduplication on `(tenant, normalized_question)`

In `qa_bank`:
- Use migration `051_align_qa_bank_unique_constraint.sql` ensuring `qa_bank_tenant_question_unique` is active.
- When upserting answers in `masterYamlManager.mjs` or `supabaseClient.mjs`:
  ```javascript
  const { error } = await supabase
    .from('qa_bank')
    .upsert(records, {
      onConflict: 'tenant,normalized_question',
      ignoreDuplicates: false,
    });
  ```
- If batch upsert throws HTTP 409 or conflict error, fall back to sequential row-by-row upsert with in-memory deduplication.

---

## 4. Multi-Service Daemon Webhook Synchronization

When running distinct microservices (e.g. `ScannerResolver` and `Submitting`):
- `ScannerResolver` must never reset `bot_control.is_running = false` or `stage = 'idle'` when `submit_status === 'running'`.
- Webhooks from the frontend (`/api/bot/scan/*`, `/api/bot/submit/*`) must broadcast to all service base URLs concurrently via `Promise.allSettled`.
