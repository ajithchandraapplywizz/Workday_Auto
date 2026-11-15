---
name: react-dashboard-ops
description: >-
  Frontend operations, React state management, and real-time dashboard monitoring for Workday Auto.
  Governs DeveloperDashboard.jsx, Vite build bundling, dynamic KPI metric calculations (Submitted,
  Ready for Review, Failed, Total Applications), Runs view date bounds, and multi-replica webhook
  broadcasting to Scanner and Submitter backend services. Activate when modifying frontend components,
  debugging KPI metrics, updating API services, or building frontend bundles.
---

# React Dashboard Operations & State Management

This skill governs the architecture, state synchronization, and operational rules for the Workday Auto React + Vite dashboard (`frontend/src/`).

---

## 1. Dynamic KPI Metrics & Real-Time Counters

### The Rules
- **Submitted KPI**: Strictly reflects authentic applications with `status = 'submitted'` or `status = 'completed'` possessing authentic confirmation proof screenshots. Never include `already_applied` or pending records in the Submitted counter.
- **Date Bounds Inclusion**: When calculating dynamic KPIs across date ranges, authentic `submitted` records must NEVER be excluded due to date filtering discrepancies. Always include `.or('status.eq.submitted,...')` in PostgREST queries.
- **Zero Fallback**: Dashboard counts must never drop or reset on page reload or re-scanning.

---

## 2. Multi-Service Webhook Broadcasting

When triggering or stopping background daemon pools from the dashboard:
- **Never broadcast to only one service URL**.
- In `frontend/src/services/api.js`, always iterate over all configured backend replica endpoints:
  ```javascript
  export async function triggerAllParallelStage() {
    const urls = getBackendBaseUrls(); // [ScannerResolver, Submitting]
    return Promise.allSettled(
      urls.map((base) =>
        fetch(`${base}/api/bot/all/start`, { method: 'POST' })
      )
    );
  }
  ```

---

## 3. UI State Invariants & Anti-Patterns

| Component / Area | Anti-Pattern | Correct Pattern |
|---|---|---|
| **Runs Filter** | Showing `already_applied` in the dropdown | Filter strictly on `all`, `ready_for_review`, `submitted`, `failed` |
| **Proof Screenshot Viewer** | Local file paths (`file://...`) | Cloud Supabase Storage signed URLs from `submitted-applications` bucket |
| **Worker Control** | Allowing manual edits during active submission | Disable control buttons and display active worker spinners |
| **Build Hygiene** | Leaving JSX syntax or React hook rule violations | Verify with `cmd /c "cd frontend && npm run build"` (code 0) |

---

## 4. Frontend Verification Gate

Before completing any task touching `frontend/`:
```powershell
cmd /c "cd frontend && npm run build"
```
Must compile with exit code 0 and zero TypeScript/Rollup errors.
