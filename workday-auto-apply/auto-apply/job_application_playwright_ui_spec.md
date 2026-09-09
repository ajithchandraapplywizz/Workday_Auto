# job-application-ui-spec.md — Workday Application Wizard, Playwright Spec

This is the canonical UI/DOM contract for automating a Workday job application wizard. It's written as a **pattern spec**, not a fixed template for one job posting — Workday tenants vary the exact question set, page count, and even step order per requisition. Automation must detect state, never assume it.

**Automation principle:** do not rely on coordinates or screenshots for logic. Prefer semantic locators (`getByLabel`, `getByRole`, `getByText`) and Workday's own `[data-automation-id="..."]` attributes. Inspect the live DOM per-tenant — the exact attributes are not guaranteed identical across companies.

---

## 1. Canonical Wizard Structure (pattern, not fixed)

Most Workday application wizards follow this stage set, shown via a horizontal progress indicator:

```text
My Information → My Experience → Application Questions → Voluntary Disclosures → Review
```

- Completed steps: filled indicator (teal circle/checkmark + connecting line in Workday's default theme).
- Current step: highlighted.
- Future steps: greyed out.
- **Do not assume this exact 5-stage set for every tenant** — some skip stages, some add tenant-specific ones (e.g. a "Self-Identify" stage). Detect stages by heading text at runtime, not by a hardcoded index.

## Navigation Contract
- Fixed/sticky footer on every step: **Back / Save and Continue**, except the final step: **Back / Submit**.
- Wait for the loading indicator (`[data-automation-id="loading-spinner"]` or equivalent) to detach and for the next heading to render — never assume an immediate URL change after clicking Save and Continue.

---

## 2. Step Pattern: My Information

Typical required fields (confirm against live DOM per tenant — do not hardcode which fields a given tenant requires):

| Field | Control type | Source of value |
|---|---|---|
| How did you hear about us? | Cascading dropdown (parent → child) | Profile default (e.g. "Website" → tenant careers domain) — **never type free text into a combobox meant for selection** |
| Previously worked here? | Radio group | Profile default (`No` unless profile states otherwise) |
| Country / Territory Phone Code | Searchable dropdown | Profile `country_phone_code` |
| Phone Number | Text input | Profile `phone` |
| Phone Device Type | Dropdown | Profile default (`Mobile`) |
| Given Name(s) / Family Name | Text input | Profile — **only fill if not already prefilled** |
| Address Line 1 / City / Postal Code | Text input | Profile — only fill if not prefilled |
| Email Address | Often read-only display | Do not attempt to edit if not editable |

### Cascading dropdown handling
1. Click to open the parent control.
2. Select the parent option.
3. **Wait for the child options to populate** (network/render delay) before attempting the child selection.
4. Select the child option by exact or best-fuzzy-match text.

### Execution requirement
Automation must run end-to-end without stalling for manual input on fields where a profile value or cached answer exists — only stall (escalate) when no value can be sourced (see §7).

---

## 3. Step Pattern: My Experience

Sections typically present: Work Experience, Education, Languages, Skills, Resume/CV, Website.

| Section | Fields | Notes |
|---|---|---|
| Work Experience | Job Title*, Company*, Location, "I currently work here" checkbox, From*, To, Role Description | "Add Another" action available; date controls are typically month/year granularity — confirm in live DOM |
| Education | School*, Degree*, Field of Study, Grade, Start/End date | "Add Another" available |
| Languages | Language selector | "Add" action opens a selection control |
| Skills | Multi-value tag/autocomplete — **treat as combobox, never plain text input** | May require keyboard-driven selection |
| Resume/CV | File upload (drag-drop UI, but automation must not drive the OS picker) | Locate the actual `<input type="file">` (may be visually hidden) and use `setInputFiles()` directly. Wait for the uploaded filename/state indicator before continuing. |
| Website | Optional URL field | "Add" action |

---

## 4. Step Pattern: Application Questions

Typically a set of required Yes/No or dropdown questions, commonly including:
- Conflict of interest disclosure
- Legal eligibility to work in the applying country
- Current contractor status
- Prior employment with the company

**Do not use positional selectors** ("the first dropdown") — question order varies per tenant and per run. Locate each question by its exact visible label text, then locate its associated control.

For each question:
1. Fuzzy-match the label against the Q&A cache (local YAML in Local Phase, Supabase `qa_answers` in Production — see `docs/backend-schema.md`).
2. Hit → apply and verify.
3. Miss → escalate per §7 (never guess these — several are compliance-adjacent).

---

## 5. Step Pattern: Voluntary Disclosures

- Contains EEO-adjacent voluntary fields (e.g. gender, race, veteran status, disability status) — **only fill with an explicit, user-approved value already on file.** Never infer or invent sensitive personal data.
- Contains a required consent checkbox ("I have read and consent to the terms and conditions"). Click, then **verify checked state** before proceeding.

---

## 6. Step Pattern: Review

Displays a read-only summary of every prior section. Before clicking **Submit**, verify:
1. Current heading is "Review".
2. Each major section (Information, Experience, Application Questions, Disclosures) is present and populated where required.
3. Resume is attached if required.
4. Consent/terms checkbox reflects checked.
5. Application-question answers match what was intended.

Only then submit. After submit, wait for a confirmation state/text — do not close the browser before confirming success. Capture the confirmation text/URL and a post-submit screenshot for audit.

---

## 7. Escalation Contract (applies to every step above)

```
Question detected
  │
  ▼
Fuzzy-match Q&A cache ──Hit (≥ threshold)──▶ apply, verify
  │
  Miss
  ▼
Required + factual (name/edu/exp/contact)? ──Yes──▶ pull from resume/profile, verify
  │
  No / still miss
  ▼
Required? ──No──▶ skip
  │
  Yes
  ▼
Escalate to human:
  - Local Phase: pause, prompt in terminal, apply typed answer
  - Production Phase: send via Telegram, apply reply
  │
  ▼
Persist answer permanently to Q&A store for this user
  │
  ▼
Continue
```

Compliance-sensitive categories (work authorization, visa sponsorship, government employment, EEO/voluntary disclosure) **always** go through this escalation on first encounter per user, even if a fuzzy match exists at borderline confidence — see `docs/rd.md` FR-L5.3.

---

## 8. State Detection (resumability)

Never assume the run starts at "My Information" — detect the current step fresh:

```text
IF "My Information" heading visible        → handle My Information
ELIF "My Experience" heading visible        → handle My Experience
ELIF "Application Questions" heading visible → handle Application Questions
ELIF "Voluntary Disclosures" heading visible → handle Voluntary Disclosures
ELIF "Review" heading visible               → validate + submit
ELSE                                        → capture diagnostics, raise, stop
```

Use a combination of URL, heading text, and progress-indicator state — not URL pattern alone, since Workday tenants vary URL structure.

---

## 9. Locator Strategy — Priority Order

1. `page.getByRole(...)` with accessible name
2. `page.getByLabel(...)`
3. `[data-automation-id="..."]`
4. `page.getByText(...)` / `:has-text()`
5. **Avoid entirely:** absolute XPath, screen coordinates, pixel positions, auto-generated CSS class selectors

## 10. Reliability Requirements

- Resumable from any step, not just from the start.
- Detect the current page before acting on it.
- Never overwrite already-correct prefilled information unless it's demonstrably wrong.
- Wait for real UI state changes (heading/spinner/URL) after every navigation — never fixed sleeps as the sole gate.
- Verify dropdown selections and checkbox states after setting them, not just on click.
- Verify resume upload completion before advancing.
- Capture screenshots and diagnostics on any failure.
- Fail clearly (raise + log) if the current page/state cannot be identified — never guess and proceed.
- Confirm successful submission before reporting completion.

---

## 11. Prompt Context for a Code-Generating Agent

> Write Playwright automation for this Workday multi-step application wizard. Inspect the existing project structure and prior Workday automation patterns before writing new code. Implement robust page-state detection so automation can resume from any step. Use semantic Playwright locators and Workday's `data-automation-id` attributes — inspect the live DOM per tenant rather than assuming fixed selectors or coordinates. Handle cascading dropdowns, prefilled fields, file uploads, checkboxes, navigation waits, and final submission confirmation. Never invent personal, sensitive, or compliance-relevant values — source them from the Q&A cache, resume/profile facts, or a human-provided answer captured through the escalation contract in §7, and persist that answer permanently.
