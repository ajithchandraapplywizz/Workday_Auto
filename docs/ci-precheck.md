# Pre-Push Evaluation Gate: Architectural Guide & Operations Manual

The **Pre-Push Evaluation Gate** ensures that code pushed to remote repositories satisfies all security, structural, architectural, and test requirements. 

Every push is evaluated against the **entire branch** (the `merge-base` between `origin/main` and `HEAD`), not just the final commit.

---

## 1. Two-Layer Defense Architecture

The gate operates across two complementary layers:

| Layer | Environment | Purpose | Bypassable? |
|---|---|---|---|
| **Layer 1: Local Git Hook** | Local workstation (`.githooks/pre-push`) | Instant feedback before bits leave the developer machine. | Developer can bypass locally with `git push --no-verify`. |
| **Layer 2: GitHub Actions Gate** | GitHub CI runner (`.github/workflows/precheck.yml`) | Absolute enforcement on every PR and branch push. | **Cannot be bypassed** once marked as a required check. |

---

## 2. Installation (Once Per Clone)

To enable the local Git hooks in your workspace clone:

```powershell
node scripts/precheck/install-hooks.mjs
```

This configures Git to use `.githooks/` via:
```powershell
git config core.hooksPath .githooks
```

### GitHub Branch Protection Rule (Enforce in Cloud)
To make the gate un-bypassable:
1. Navigate to your repository on **GitHub** → **Settings** → **Branches**.
2. Under **Branch protection rules**, edit or create a rule for `main` (and `master`).
3. Check **"Require status checks to pass before merging"**.
4. In the search box, search for and select status check: `precheck`.
5. Check **"Require branches to be up to date before merging"**.
6. Save changes.

Now, even if someone runs `git push --no-verify`, GitHub will block the PR or merge until the `precheck` action passes.

---

## 3. Running Checks Manually

You can run the evaluation gate at any time via the command line:

| Command | Scope | Use Case |
|---|---|---|
| `node scripts/precheck/precheck.mjs` | Whole branch vs `merge-base` | What the pre-push hook runs. |
| `node scripts/precheck/precheck.mjs --mode=staged` | Staged files only | Fast static pre-commit verification. |
| `node scripts/precheck/precheck.mjs --mode=full` | Every tracked file in repo | Full repository deep audit. |
| `node scripts/precheck/precheck.mjs --only=imports,tests` | Specific checks | Focused evaluation. |
| `node scripts/precheck/precheck.mjs --skip=build` | Skip heavy checks | Speed up local evaluation. |
| `node scripts/precheck/precheck.mjs --bail` | Halt on first failure | Rapid feedback loop. |
| `node scripts/precheck/precheck.mjs --strict` | Warnings fail the build | Zero-tolerance release gate. |

---

## 4. What Each Check Blocks

| Check | Catches |
|---|---|
| **`git-state`** | Direct pushes to `main`/`master`, uncommitted changes in working tree, temporary `fixup!` / `squash!` / `wip:` commits. |
| **`paths-and-size`** | Committed `.env*` files, local `screenshots/` (violates Zero Local Screenshots Policy), `learnings.json`, private keys (`.pem`, `.key`), or files exceeding 5 MB. |
| **`secrets`** | Supabase JWT & `service_role` keys, Anthropic keys (`sk-ant-`), OpenRouter keys (`sk-or-`), OpenAI keys (`sk-proj-`), Groq keys (`gsk_`), Telegram bot tokens, RSA/SSH private keys. Scanned on added lines only; values are redacted in reports. |
| **`code-patterns`** | Local disk screenshot calls (`page.screenshot({ path })`), `service_role` leaked into `frontend/`, focused test statements (`.only()`), `debugger;` statements, Git conflict markers (`<<<<<<<`), hardcoded local machine paths (`C:\Users\`). Warns on empty catch blocks and unbounded loops. |
| **`syntax`** | Runs `node --check` on all changed `.mjs`, `.cjs`, and backend `.js` files; validates JSON with `JSON.parse`; validates YAML formatting. |
| **`imports`** | Unresolved relative imports, missing explicit `.mjs`/`.js` extensions (required by Node ESM), letter-case mismatches (prevents Windows-passing code from crashing on Linux/Railway), packages missing from `package.json`. |
| **`migrations`** | Modifying already applied migrations, duplicate migration numbering prefixes (e.g. two `024_...`), destructive SQL (`DROP TABLE`, `TRUNCATE`, unbounded `DELETE`). |
| **`dependencies`** | Modifications to `package.json` dependencies without corresponding updates to `package-lock.json`. |
| **`smoke-import`** | Evaluates changed `backend/lib/*.mjs` modules in an isolated process with dummy environment variables to detect top-level import crashes, unhandled rejections, or missing bindings. |
| **`lint`** | Runs workspace `npm run lint`. |
| **`tests`** | Runs the unit test suite (`npm test`). |
| **`build`** | Compiles the production frontend bundle (`npm run build`). |

---

## 5. Escape Hatches

### 1. Code Line Escape Hatch (`precheck:allow`)
If a specific line triggers a false positive on secrets or code patterns that has been peer-reviewed and approved, add the comment `precheck:allow` to that line:

```javascript
const testToken = "mock_token_for_offline_test"; // precheck:allow
```

### 2. Migration Escape Hatch (`-- precheck:allow-destructive`)
If an intentional migration requires a `DROP TABLE` or `TRUNCATE`, add `-- precheck:allow-destructive` in the SQL file:

```sql
-- precheck:allow-destructive
DROP TABLE IF EXISTS deprecated_legacy_cache;
```

---

## 6. Tuning (`scripts/precheck/precheck.config.json`)

The evaluation gate behavior can be customized in `scripts/precheck/precheck.config.json`:

```json
{
  "strictMissingScripts": false,
  "defaultBase": "origin/main",
  "maxFileSizeMB": 5,
  "workspaces": [
    {
      "name": "root",
      "dir": ".",
      "scripts": { "lint": "npm run lint", "test": "npm test" }
    },
    {
      "name": "frontend",
      "dir": "frontend",
      "scripts": { "build": "npm run build" }
    }
  ],
  "smokeImportPrefixes": ["backend/lib"],
  "smokeImportExclude": [
    "backend/lib/clusterBatchRunner.mjs",
    "backend/lib/workerPool.mjs",
    "backend/lib/submissionWorkerPool.mjs"
  ],
  "blockedBranches": ["main", "master"]
}
```

---

## 7. Audit Report Artifact (`.precheck/report.md`)

After every run, a complete evaluation report is written to `.precheck/report.md`. In GitHub Actions, this report is automatically appended to the Job Summary and saved as a downloadable build artifact.
