---
name: verification-gate-runner
description: >-
  Executes comprehensive multi-layer verification gates for Workday Auto.
  Implements Andrej Karpathy's Principle 4 (Goal-Driven Execution) and enforces the mandatory End-of-Session
  protocol: running unit test suites (node --test backend/tests/*.test.mjs), syntax validation (node --check),
  TypeScript typechecking (npm run typecheck), frontend build compilation (npm run build), and 12-check pre-push
  evaluations. Activate before concluding any task, reviewing code diffs, or verifying production readiness.
---

# Verification Gate Runner & Testing Discipline

This skill defines the mandatory verification protocol that every engineer and AI agent must execute before declaring any task complete in Workday Auto.

---

## The 4-Gate Verification Sequence

Run each gate sequentially. Every gate must exit with code 0:

```text
[Gate 1: Syntax & Imports]  ──> node --check <modified_files>
           │
           ▼
[Gate 2: Unit Test Suite]   ──> node --test backend/tests/*.test.mjs
           │
           ▼
[Gate 3: Typecheck]         ──> npm run typecheck
           │
           ▼
[Gate 4: Frontend Build]    ──> cmd /c "cd frontend && npm run build" (if frontend touched)
```

---

## 1. Syntax & Integrity Gate
Verify that modified ES modules have zero parsing errors:
```powershell
node --check backend/lib/engine.mjs
node --check backend/scripts/queue_daemon.mjs
```

---

## 2. Unit Test Suite Execution
Execute the automated test suites covering all core modules:
```powershell
node --test backend/tests/strictPhoneMandatory.test.mjs
node --test backend/tests/preresolvedAndStepDetection.test.mjs
node --test backend/tests/universalTriggerAndStage3ClaimE2E.test.mjs
node --test backend/tests/clientQaRecord.test.mjs
node --test backend/tests/alreadyAppliedHardening.test.mjs
node --test backend/tests/csvJobParser.test.mjs
node --test backend/tests/jobFormCache.test.mjs
```

Or run the full test suite:
```powershell
npm test
```

---

## 3. TypeScript Typecheck Gate
Ensure no type definition drift or invalid property lookups:
```powershell
npm run typecheck
```

---

## 4. Frontend Build Gate
When modifying anything inside `frontend/` (or shared package dependencies):
```powershell
cmd /c "cd frontend && npm run build"
```

---

## 5. Comprehensive 12-Check Precheck Gate
For comprehensive pre-release verification:
```powershell
node scripts/precheck/precheck.mjs
```
Validates:
1. Git state & clean staging
2. File paths and sizes (no large binary dumps)
3. Secret scanning (zero leaked tokens or private keys)
4. Code patterns (zero local screenshot writes, zero auto-commits)
5. Syntax checks across all `.mjs` and `.js` files
6. Import resolution integrity
7. Database migration sequence
8. Dependency lockfile consistency
9. Smoke imports of core libraries
10. Linter rules
11. Test suite execution
12. Frontend compilation

---

## Enforcement Checklist

- [ ] All modified files verified with `node --check`
- [ ] Automated unit test suites passing (100% green)
- [ ] `npm run typecheck` passes with 0 errors
- [ ] If frontend touched, `npm run build` completed cleanly
- [ ] Zero local screenshots created or committed
- [ ] No `git add` or `git commit` commands executed (manual git control preserved)
