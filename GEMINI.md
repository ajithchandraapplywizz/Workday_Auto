# Project Rules & Guardrails

## 1. Zero Local Screenshots Policy
- **Never Store Screenshots Locally**: NEVER save, write, or download screenshots to the local disk, workspace directories, or local folders (such as `screenshots/`, `data/`, or `tmp/`).
- **In-Memory Buffer Only**: All browser screenshots captured via Playwright must be held strictly as in-memory buffers (`const buf = await page.screenshot()`) and streamed directly to cloud storage (e.g. Supabase Storage buckets `submitted-applications` or `failed-applications`).
- **Preserve Existing Screenshots**: Do NOT touch, delete, rename, or disturb any existing screenshots already present on local disk. Leave existing files as they are.

## 2. Git Workflow Policy
- **No Git Staging or Committing**: Never run `git add`, `git commit`, `git push`, or any automated commit commands.
- **Manual Control**: All Git staging, commits, and pushes must be handled manually by the developer. Read-only commands (`git status`, `git diff`, `git log`) are permitted for inspection.
