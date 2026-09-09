# Codebase Analysis Report — workday-auto-apply

> **Purpose:** Full analysis of the existing `auto-apply` codebase before planning and documentation begins. This report is the source of truth for what currently exists.



## 1. Overall Architecture

The project is a **Node.js CLI automation tool** (ESM modules, `.mjs` extension) built on top of **Playwright**. It operates as a single-process terminal application with no server, no database, and no web UI. All state is persisted in local flat files (YAML, JSON, CSV).

```
CLI entry point (cli.mjs)
        │
        ├─► scanner.mjs     — Navigates to job URL, extracts form fields
        ├─► planner.mjs     — Maps scanned fields → profile values → plan JSON
        ├─► workdayDom.mjs  — Workday DOM + a11y discovery, MutationObserver, review check
        ├─► engine.mjs      — Fills form fields using the plan, handles Workday wizard
        ├─► workday.mjs     — Workday sign-in / sign-up / account creation
        ├─► discovery.mjs   — ATS detection + "Apply" button navigation
        ├─► fields.mjs      — Universal field finder + dropdown handler + fuzzy match
        ├─► otp.mjs         — OTP detection + terminal prompt for user input (V0/V1) + character-by-character entry
        ├─► learner.mjs     — Self-learning store: records past runs, applies corrections
        └─► reporter.mjs    — Screenshots + CSV logging + queue management
```

**Data flow:**
```
config/profile.yml + config/resumes.yml
        │
        ▼
[SCAN] → forms/{slug}-scan.json
        │
        ▼
[PLAN] → forms/{slug}-plan.json
        │
        ▼
[FILL + SUBMIT] → data/applied.csv + screenshots/ + data/learnings.json
```

---

## 2. Important Folders and Files

| Path | Purpose |
|---|---|
| `cli.mjs` | Entry point — parses all CLI commands and flags |
| `lib/scanner.mjs` | Scans job page form fields, outputs scan JSON |
| `lib/planner.mjs` | Maps scanned fields to profile values, generates plan JSON |
| `lib/engine.mjs` | Core fill engine: fills every field type, runs Workday 5-step wizard |
| `lib/workdayDom.mjs` | Workday DOM/a11y field discovery, MutationObserver, required-field gate, review parse |
| `lib/workday.mjs` | Workday-specific: sign-in, sign-up, account creation, email verification |
| `lib/discovery.mjs` | ATS detection + portal navigation (Greenhouse, Lever, Ashby, Workday, Gem, Generic) |
| `lib/fields.mjs` | Field finder (6 strategies), dropdown handler (4 strategies), fuzzy scoring |
| `lib/otp.mjs` | OTP detection from page; prompts user via terminal to enter code (V0/V1); character-by-character entry |
| `lib/learner.mjs` | Self-learning: records results/errors, corrects future fill values |
| `lib/reporter.mjs` | Screenshots, CSV append, queue CSV load/save/update |
| `config/profile.yml` | User profile: personal info, EEO, work auth, education, experience |
| `config/resumes.yml` | Resume file paths + keyword tags for auto-selection |
| `forms/` | Output: scan JSON + plan JSON per job URL |
| `data/applied.csv` | Application log (date, company, role, URL, status, ATS) |
| `data/queue.csv` | Job queue (pending, submitted, failed) |
| `data/learnings.json` | Self-learning store: corrections, option mappings, stats |
| `screenshots/` | Step-by-step screenshots per application |
| `.env` | Email + passwords for OTP and Workday auth |

---

## 3. Application Entry Points

The only entry point is **`cli.mjs`** via Node.js.

| Command | Function | What it does |
|---|---|---|
| `node cli.mjs setup` | `cmdSetup()` | Creates `profile.yml`, `resumes.yml`, `.env`, directories |
| `node cli.mjs scan <url>` | `cmdScan()` | Scans form fields → `forms/{slug}-scan.json` |
| `node cli.mjs fill <url> [plan.json]` | `cmdFill()` | Fills form; auto-generates plan if not provided |
| `node cli.mjs apply <url>` | `cmdApply()` | **Full pipeline**: scan → plan → fill → submit → OTP |
| `node cli.mjs batch [file]` | `cmdBatch()` | Applies to multiple URLs from file or queue |
| `node cli.mjs queue add/list/remove/clear` | `cmdQueue()` | Manages the job queue CSV |
| `node cli.mjs list` | `cmdList()` | Shows applied/pending/unapplied jobs dashboard |
| `node cli.mjs status` | `cmdStatus()` | Shows stats and learnings summary |

**CLI flags:**

| Flag | Description |
|---|---|
| `--signup` | Use signup mode (create new Workday account) |
| `--signin` | Use signin mode (log in with existing account) — **default** |
| `--workday-email <email>` | Override Workday email |
| `--workday-password <pw>` | Override Workday password |
| `--otp-email <gmail>` | Gmail address for OTP fetching |
| `--otp-password <app-pw>` | Gmail App Password |

---

## 4. Automation Flow (Full Pipeline)

```
node cli.mjs apply <url> [--signin|--signup]
        │
        ▼
1. Load .env + config/profile.yml + config/resumes.yml
2. Resolve credentials (CLI flags → .env → profile.yml fallback)
3. detectATS(url) → greenhouse | lever | ashby | workday | gem | generic
        │
        ▼
4. Launch Chromium browser (headless: false, 1280×900 viewport)
        │
        ▼
5. SCAN: discoverApplicationForm(page, url)
   - Navigate to ATS-specific Apply button
   - For Workday: click Apply → "Apply Manually" → handle gateway
   - For Greenhouse: scroll to #app, click "Apply for this job"
   - For Lever: navigate to /apply path
        │
        ▼
6. If Workday: handleWorkday(page, { email, password, mode })
   - mode="signin": workdayLogin() → fill email+password → click Sign In
   - mode="signup": workdayCreateAccount() → fill form → handle email verification OTP → workdayLogin()
        │
        ▼
7. extractJDText(page) → JD text for resume selection
        │
        ▼
8. pickResume(jdText, resumes.yml) → select best PDF by keyword matching
        │
        ▼
9. PLAN: generatePlan(scan, profile)
   - For each scanned field, match label against FIELD_MAP (regex → profile key)
   - Resolve value from profile.yml nested path or _static.* literal
   - For file fields: assign resumePath
   - For yes-no-button fields: resolve from profile
   - For checkboxes: auto-check consent/agree fields
   - Output: { fills, skipped, unmapped, resume }
        │
        ▼
10. applyLearnings(plan, url) → apply past option corrections
        │
        ▼
11. FILL: fillForm(url, plan, credentials)
        │
        ├── Workday ATS:
        │   runWorkdayWizardLoop(page, profile, plan)
        │   Loop up to 10 iterations:
        │     a. detectWorkdayStep() → "My Information" | "My Experience" |
        │        "Application Questions" | "Voluntary Disclosures" | "Review"
        │     b. handleWorkdayAddButtons() → expand Work Experience/Education/Website
        │     c. handleWorkdayResumeUpload() → upload PDF, verify upload
        │     d. Fill special fields (phone type, country code, phone number, terms)
        │     e. Scan visible inputs → mapLabelToProfileValue() → fill each field
        │     f. advanceWorkdayStep() → click "Save and Continue"
        │     g. If errors detected → re-fill step → re-advance
        │     h. When "Review" step reached → click "Submit"
        │     i. Detect confirmation text or post-submit OTP
        │
        └── Other ATS (Greenhouse, Lever, Ashby, Generic):
            For each entry in plan.fills:
              - Resolve element via findField() (6 strategies)
              - Fill by field type:
                  text/email/tel: .fill()
                  file: .setInputFiles()
                  checkbox: .click() if needed
                  radio: click by value
                  select: handleDropdown() (4 strategies)
                  yes-no-button: DOM traversal → click correct button
                  typeahead: type + wait + pick suggestion
                  multi-select: sequential type + pick
              - Verification pass: check required fields still empty
              - clickSubmitButton() → wait for confirmation / OTP
        │
        ▼
12. handlePostSubmitOTP() if OTP prompt detected
    - Detect OTP/verification prompt in page DOM
    - Prompt user in terminal: "Enter OTP code:"
    - User types code → bot fills OTP input character by character
    - Click Verify/Confirm/Submit
        │
        ▼
13. takeScreenshot(page, 'post-submit')
14. logToCSV(url, company, role, status)
15. recordResult(url, plan, status, fieldResults) → learnings.json
16. Browser stays open 15s → close
```

---

## 5. Sign-In Flow (Workday — Corrected Flow)

Every Workday job application follows the same gateway sequence: JD page → Apply → Apply Manually → Create Account / Sign In gateway. Because this gateway always appears after clicking Apply Manually, upfront wizard/login checks are unnecessary. The correct flow when `--signup` is **not** set is:

```
node cli.mjs apply <url>   (default mode = 'signin')
        │
        ▼
1. discoverApplicationForm():
   - Click Apply button on the JD page
   - Click "Apply Manually" from the popup
   - Gateway page appears (Create Account | Sign In)
   - Click "Sign In" link/button on the gateway
   - Wait for Sign In form (email + password inputs visible)
        │
        ▼
2. workdayLogin(page, email, password):
   a. Fill email input (data-automation-id="email" | userName)
   b. Fill password input
   c. Click signInSubmitButton (force: true)
   d. Wait 4s + networkidle
   e. Check for password input still visible or error message
   → If still visible: return false (login failed)
   → Otherwise: return true (proceed to application form)
```

---

## 6. Sign-Up Flow (Workday — Corrected Flow)

Same gateway sequence as sign-in. When `--signup` is set, click "Create Account" instead of "Sign In" on the gateway.

```
node cli.mjs apply <url> --signup
        │
        ▼
1. discoverApplicationForm():
   - Click Apply → "Apply Manually" on Workday JD page
   - On gateway: click "Create Account" link/button
   - Wait for verifyPassword input to appear
        │
        ▼
2. workdayCreateAccount(page, email, givenPassword):
   a. Click "Create Account" button if not already on form
   b. Wait for create account form
   c. Fill email input
   d. Generate secure random password (12 chars + special + digit) if not provided
   e. Fill password + verifyPassword inputs
   f. Check terms/agree checkbox if present
   g. Click createAccountSubmitButton
   h. Wait 5s + networkidle
   i. Check page for "verif/confirm/code/check your email" text
      → If yes: prompt user in terminal to enter OTP → fill verification input → click Verify
      → If no: skip directly to step 3 (no email verification required)
   j. Return the generated password
        │
        ▼
3. isWorkdaySignInPage(page):
   → If redirected to sign-in form: workdayLogin(email, newPassword)
   → If already on application form: return true directly
```

---

## 7. Question Detection and Answering Flow

### Question Detection (scanner.mjs)

The scanner runs **three passes** over the DOM:

1. **Standard inputs/selects/textareas** — `querySelectorAll('input, textarea, select')` with label extraction via:
   - `label[for="id"]`
   - Closest `label` ancestor
   - `aria-label` attribute
   - `aria-labelledby` reference
   - `placeholder` attribute
   - Previous sibling text
   - `data-automation-id` converted to readable label

2. **Custom dropdowns** — `[data-field]`, `.field`, `.application-field` containers with `[role="listbox"]`, `[role="combobox"]`, `.custom-select` children

3. **Yes/No button questions** (Ashby pattern) — find `label` elements whose sibling container has buttons with text "Yes" and "No"

### Answer Planning (planner.mjs)

The `FIELD_MAP` is an **83-entry regex→profile-path lookup table** covering:

- Personal info (first name / **given name**, last name / **family name** / **surname**, email, phone, LinkedIn, address, location)
- Work authorization (sponsorship, US authorization, office willingness)
- EEO fields (gender, race, Hispanic/Latino, veteran status, disability)
- Education (degree, major, university, graduation year, GPA)
- Experience (years, company, title, description, salary, start date)
- Static answers (`_static.No`, `_static.Mobile`, `_static.LinkedIn`, `_static.true`)
- Consent/terms checkboxes

**Answer resolution priority** (Workday runtime):
1. `profile.yml` via FIELD_MAP (`mapLabelToProfileValue`)
2. `profile.qa_answers` (canonical Q&A store)
3. Plan fills / session `_runtimeAnswers`
4. Terminal prompt for unknown required questions (`saveAnswerToYaml`)
5. Unmapped (skipped if not required)

**Fuzzy matching** (`fuzzyScore()`) is used when a plan value doesn't exactly match a dropdown option — returns 0–1 score based on exact, inclusion, and word-overlap comparisons.

---

## 8. How Profile/Resume Data is Used

**`config/profile.yml`** has these sections:
- `personal`: name, email, phone, LinkedIn, location, city, state, postal_code, address, country, country_phone_code, source, consent_agreement
- `eeo`: gender, hispanic_latino, race, veteran_status, disability_status
- `work_auth`: authorized_us, sponsorship_needed, visa_status, office_willing, willing_to_relocate
- `education`: degree, major, university, graduation_year
- `experience`: years, current_company, current_title, salary_expectation, start_date

**`config/resumes.yml`** lists resume PDFs with `id`, `label`, `file` (path), `keywords` array. `pickResume()` scores each resume against JD text keyword matches, picks the highest-scoring one (≥2 matches). Falls back to the `default` resume.

---

## 9. Self-Learning System (learner.mjs)

`data/learnings.json` stores:
- `field_corrections` — fields that consistently fail (ATS + field name + error)
- `option_mappings` — dropdown value corrections (plan said X → actual option was Y)
- `ats_quirks` — ATS-specific notes
- `results` — last 200 application results with field errors
- `stats` — total/submitted/failed counts

On each application: `applyLearnings(plan, url)` checks `option_mappings` and updates plan values before filling. After completion: `recordResult()` logs the outcome and any field errors.

---

## 10. Existing Dependencies and Technologies

| Dependency | Version | Purpose |
|---|---|---|
| `playwright` | ^1.58.1 | Browser automation (Chromium) |
| `imapflow` | ^1.3.1 | Gmail IMAP — **superseded by terminal OTP prompt for V0/V1** |
| `js-yaml` | ^4.1.1 | YAML parsing for profile.yml + resumes.yml |
| Node.js | ≥18.0.0 | Runtime |

**No** framework, no database, no web server, no API. Pure CLI.

---

## 11. Supported ATS Platforms

| ATS | Detection | Form Discovery | Auth |
|---|---|---|---|
| Greenhouse | `greenhouse.io` in URL | Click Apply button → scroll to #app | None required |
| Lever | `lever.co` in URL | Navigate to /apply path | None required |
| Ashby | `ashbyhq.com` in URL | Click Apply button | None required |
| Workday | `workday` or `myworkday` in URL | Click Apply → Apply Manually → Sign In/Create Account | Sign in or Create Account |
| Gem | `jobs.gem.com` in URL | Click Apply button | None required |
| iCIMS | `icims` in URL | Generic strategy | None required |
| SmartRecruiters | `smartrecruiters` in URL | Generic strategy | None required |
| Generic | Fallback | Click any "Apply" button/link | None required |

---

## 12. What is Reusable for the Planned Product

| Component | Reusability | Notes |
|---|---|---|
| `lib/scanner.mjs` | ✅ High | Core scanning logic is solid; can be called programmatically |
| `lib/planner.mjs` | ✅ High | FIELD_MAP + generatePlan() are the core intelligence |
| `lib/engine.mjs` | ✅ High | Workday wizard loop is well-developed; non-Workday fill loop also solid |
| `lib/workday.mjs` | ✅ High | Sign-in + sign-up flows are production-level |
| `lib/discovery.mjs` | ✅ High | ATS detection + portal navigation covers major ATS platforms |
| `lib/fields.mjs` | ✅ High | 4-strategy dropdown handler + fuzzy matching are well-engineered |
| `lib/otp.mjs` | ✅ High | Gmail IMAP OTP fetch is working; can be wrapped/replaced |
| `lib/learner.mjs` | ✅ Medium | Needs to move from local JSON to Supabase |
| `lib/reporter.mjs` | 🔄 Partial | CSV logging → needs Supabase; screenshots still useful |
| Profile YAML schema | 🔄 Partial | Needs to become Supabase database schema |
| CLI architecture | ❌ Replace | Will be replaced by web dashboard + programmatic API |
| Queue CSV | ❌ Replace | Replace with Supabase jobs table + queue system |

---

## 13. Current Limitations, Gaps, and Areas Requiring Changes

### Critical Gaps

| Gap | Description |
|---|---|
| **No Telegram integration** | No messaging, confirmation, or notification system |
| **No web UI or dashboard** | Pure terminal output, no monitoring interface |
| **No database** | All state in local flat files; not multi-user capable |
| **Single user only** | Profile is a local YAML file; one user per machine |
| **No job discovery** | Only processes URLs provided manually; no scraping |
| **No deployment infrastructure** | Not containerized; requires local machine with browser |
| **No resume parsing** | Resume path is assigned but content is not extracted/used for answers |

### Reliability Gaps

| Gap | Description |
|---|---|
| **OTP via Gmail App Password** | Not scalable; users need to share Gmail App Password |
| **Browser stays open 15s** | Awkward UX; no clean session management |
| **No retry logic on failure** | If a step fails, pipeline stops; no automatic resume |
| **Hardcoded Mac user agent** | May cause issues on Windows/Linux servers |
| **No headless mode** | `headless: false` — requires a display; not server-compatible |

### Architecture Gaps

| Gap | Description |
|---|---|
| **Profile data from YAML only** | No dynamic data source; cannot be populated via UI |
| **Credentials in .env file** | Not encrypted; not suitable for multi-user |
| **No application status tracking** | Only CSV log; no queryable state |
| **Queue is CSV-based** | Not suitable for concurrent processing |
| **Learnings are local JSON** | Not shared across users or deployments |

---

## 14. Directory Structure Summary

```
workday-auto-apply/
└── auto-apply/
    ├── cli.mjs                    ← Entry point
    ├── package.json               ← Dependencies: playwright, imapflow, js-yaml
    ├── .env                       ← EMAIL, APP_PASSWORD, WORKDAY_EMAIL, WORKDAY_PASSWORD
    ├── config/
    │   ├── profile.yml            ← User profile data
    │   ├── profile.example.yml    ← Template
    │   ├── resumes.yml            ← Resume file paths + keywords
    │   └── resumes.example.yml    ← Template
    ├── lib/
    │   ├── scanner.mjs            ← Form field scanner
    │   ├── planner.mjs            ← Plan generator + FIELD_MAP
    │   ├── workdayDom.mjs         ← Workday DOM + accessibility discovery
    │   ├── engine.mjs             ← Fill engine + Workday wizard
    │   ├── workday.mjs            ← Workday auth (sign-in + sign-up)
    │   ├── discovery.mjs          ← ATS detection + portal navigation
    │   ├── fields.mjs             ← Field finder + dropdown handler
    │   ├── otp.mjs                ← Gmail IMAP OTP
    │   ├── learner.mjs            ← Self-learning store
    │   └── reporter.mjs           ← CSV + screenshots
    ├── forms/                     ← {slug}-scan.json + {slug}-plan.json
    ├── data/                      ← applied.csv + queue.csv + learnings.json
    ├── resumes/                   ← PDF resume files
    └── screenshots/               ← Step screenshots
```
