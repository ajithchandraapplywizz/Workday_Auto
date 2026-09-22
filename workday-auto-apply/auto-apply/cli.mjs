#!/usr/bin/env node

/**
 * auto-apply — Autonomous job application engine
 *
 * Commands:
 *   setup                    Interactive onboarding (creates profile.yml)
 *   scan  <url>              Scan form fields → forms/{slug}-scan.json
 *   fill  <url> [plan.json]  Fill form (auto-generates plan if no plan given)
 *   apply <url>              Full pipeline: scan → plan → fill → submit
 *   batch [targets.txt]      Apply to all URLs in file (or process queue)
 *   queue add <url> [company] Add URL to application queue
 *   queue list               Show pending/applied/failed queue entries
 *   queue remove <url>       Remove URL from queue
 *   status                   Show application stats
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { scanForm, slugify } from './lib/scanner.mjs';
import { fillForm } from './lib/engine.mjs';
import { loadProfile, generatePlan, pickResume } from './lib/planner.mjs';
import { isApiOnlyAnswerMode } from './lib/apiOnlyProfile.mjs';
import { applyLearnings, getStats } from './lib/learner.mjs';
import { extractJDText, detectATS, validateWorkdayUrl, readJobLinksFile, extractWorkdayCompanyName, extractJobRoleFromDom, isWorkdayWizardVisible } from './lib/discovery.mjs';
import { loadQueue, saveQueue, addToQueue, getPendingFromQueue } from './lib/reporter.mjs';
import { 
  getTodayMMDDYYYY, 
  isCurrentDateQuestionLabel, 
  getDynamicDateValueForField 
} from './lib/date-utils.mjs';
import { chromium } from 'playwright';
import { runWd5BatchScan, showWd5CatalogPending } from './lib/wd5BatchScan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Dynamic Field Resolvers ────────────────────────────────────────────────

/**
 * Resolves date fields dynamically inside the plan using date-utils.mjs logic.
 */
function resolveDynamicFields(plan) {
  if (!plan) return plan;

  const defaultDate = getTodayMMDDYYYY('Asia/Kolkata');

  // 1. Resolve within plan.fills array
  if (Array.isArray(plan.fills)) {
    for (const item of plan.fills) {
      const label = item.label || item.id || '';
      
      // Check via regex rules in date-utils.mjs
      if (isCurrentDateQuestionLabel(label, item)) {
        item.value = getDynamicDateValueForField(label, item) || defaultDate;
        item.answer = item.value;
      }
      
      // Fallback: direct script string checks
      if (typeof item.value === 'string' && (item.value === 'date-utils.mjs' || item.value.endsWith('.mjs'))) {
        item.value = defaultDate;
      }
      if (typeof item.answer === 'string' && (item.answer === 'date-utils.mjs' || item.answer.endsWith('.mjs'))) {
        item.answer = defaultDate;
      }
    }
  }

  // 2. Resolve within qa_answers or unmapped dictionaries
  if (plan.qa_answers) {
    for (const [key, val] of Object.entries(plan.qa_answers)) {
      if (isCurrentDateQuestionLabel(key)) {
        plan.qa_answers[key] = defaultDate;
      } else if (typeof val === 'string' && (val === 'date-utils.mjs' || val.endsWith('.mjs'))) {
        plan.qa_answers[key] = defaultDate;
      } else if (val && typeof val === 'object' && val.answer && (val.answer === 'date-utils.mjs' || val.answer.endsWith('.mjs'))) {
        val.answer = defaultDate;
      }
    }
  }

  return plan;
}

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const [, , command, ...rawArgs] = process.argv;

let workdayEmail = process.env.WORKDAY_EMAIL || '';
let workdayPassword = process.env.WORKDAY_PASSWORD || '';
let isSignup = false;
let confirmSubmit = false;
let scanBatchOffset = 0;
let scanBatchLimit = 15;
let batchLimitExplicit = false;
let scanBatchSkipAuth = true;
let scanBatchInteractive = true;
let scanBatchWaitReview = true;
const positionalArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--workday-email' && rawArgs[i + 1]) workdayEmail = rawArgs[++i];
  else if (rawArgs[i] === '--workday-password' && rawArgs[i + 1]) workdayPassword = rawArgs[++i];
  else if (rawArgs[i] === '--signup') isSignup = true;
  else if (rawArgs[i] === '--signin') isSignup = false;
  else if (rawArgs[i] === '--confirm-submit') confirmSubmit = true;
  else if (rawArgs[i] === '--offset' && rawArgs[i + 1]) scanBatchOffset = Number(rawArgs[++i]) || 0;
  else if (rawArgs[i] === '--limit' && rawArgs[i + 1]) {
    scanBatchLimit = Number(rawArgs[++i]) || 15;
    batchLimitExplicit = true;
  }
  else if (rawArgs[i] === '--no-skip-auth') scanBatchSkipAuth = false;
  else if (rawArgs[i] === '--no-interactive') scanBatchInteractive = false;
  else if (rawArgs[i] === '--no-wait-review') scanBatchWaitReview = false;
  else if ((rawArgs[i] === '--client' || rawArgs[i] === '--applywizz-id') && rawArgs[i + 1]) {
    process.env.APPLYWIZZ_ID = rawArgs[++i];
  }
  else positionalArgs.push(rawArgs[i]);
}
const mode = isSignup ? 'signup' : 'signin';

// ─── Find file across candidate paths (cwd, auto-apply, __dirname) ──────────
function findFilePath(relPath) {
  const candidates = [
    resolve(process.cwd(), relPath),
    resolve(__dirname, relPath),
    resolve(process.cwd(), 'auto-apply', relPath),
    resolve(__dirname, '..', relPath),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

// ─── Load .env if present ───────────────────────────────────────────────────
async function loadEnv() {
  const envCandidates = [
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '.env'),
    resolve(process.cwd(), 'auto-apply', '.env'),
    resolve(__dirname, '..', '.env'),
  ];

  for (const envPath of envCandidates) {
    if (existsSync(envPath)) {
      const content = await readFile(envPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (match) {
          const [, key, rawVal] = match;
          const val = rawVal.trim().replace(/^['"](.*)['"]$/, '$1');
          if (val) {
            process.env[key] = val;
            if (key === 'WORKDAY_EMAIL' && !workdayEmail) workdayEmail = val;
            if (key === 'WORKDAY_PASSWORD' && !workdayPassword) workdayPassword = val;
          }
        }
      }
      break;
    }
  }
}

// ─── Resolve credentials from CLI flags, .env, and config/profile.yml ───────
async function resolveAuthCredentials() {
  await loadEnv();

  let profile = null;
  try {
    const profilePath = findFilePath('config/profile.yml');
    profile = await loadProfile(existsSync(profilePath) ? profilePath : null);
  } catch (err) {
    console.warn(`  ⚠️ Profile load warning: ${err.message}`);
  }

  // Prioritize explicit WORKDAY_EMAIL (env or CLI flag) when provided (e.g. for testing); otherwise default to candidate's profile email.
  const applyWizzEmail = String(profile?.personal?.email || profile?.personal?.company_email || '').trim();
  let resolvedWorkdayEmail = workdayEmail || process.env.WORKDAY_EMAIL || applyWizzEmail || '';
  let resolvedWorkdayPassword = workdayPassword || process.env.WORKDAY_PASSWORD || '';

  if (mode === 'signin') {
    if (!resolvedWorkdayEmail || !resolvedWorkdayPassword) {
      console.error('\n❌ Error: Missing credentials. Either:');
      console.error('   1. Set APPLYWIZZ_ID in .env (client profile provides email) and WORKDAY_PASSWORD in .env');
      console.error('   2. Or set WORKDAY_EMAIL and WORKDAY_PASSWORD in .env\n');
      process.exit(1);
    }
  } else if (mode === 'signup') {
    resolvedWorkdayEmail = resolvedWorkdayEmail || profile?.workday?.email || profile?.personal?.email || profile?.personal?.company_email || '';
    resolvedWorkdayPassword = resolvedWorkdayPassword || profile?.workday?.password || '';
  }

  return {
    profile,
    workdayEmail: resolvedWorkdayEmail,
    workdayPassword: resolvedWorkdayPassword,
    mode,
  };
}

// ─── SETUP ──────────────────────────────────────────────────────────────────
async function cmdSetup() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║          auto-apply — Setup Wizard                     ║
╚════════════════════════════════════════════════════════╝

This wizard creates your config/profile.yml.
You can also create it manually — see config/profile.example.yml.
`);

  const profilePath = resolve(process.cwd(), 'config', 'profile.yml');
  if (existsSync(profilePath)) {
    console.log('✅ config/profile.yml already exists.');
    console.log('   Edit it directly or delete it to re-run setup.');
    return;
  }

  console.log('Create config/profile.yml with your details.');
  console.log('Use config/profile.example.yml as a template.\n');

  const examplePath = resolve(process.cwd(), 'config', 'profile.example.yml');
  const pkgExamplePath = resolve(__dirname, 'config', 'profile.example.yml');
  const foundExample = existsSync(examplePath) ? examplePath : existsSync(pkgExamplePath) ? pkgExamplePath : null;

  if (foundExample) {
    const example = await readFile(foundExample, 'utf-8');
    await mkdir(resolve(process.cwd(), 'config'), { recursive: true });
    await writeFile(profilePath, example);
    console.log('📄 Copied profile.example.yml → profile.yml');
    console.log('   Edit config/profile.yml with your details, then run:');
    console.log('   auto-apply apply <job-url>\n');
  } else {
    console.log('No profile.example.yml found. Creating a blank profile...');
    const blank = `# Auto-apply profile
personal:
  first_name: ""
  last_name: ""
  email: ""
  phone: ""
  linkedin: ""
  location: ""
  country: "United States of America +1"

eeo:
  gender: ""
  hispanic_latino: "No"
  race: ""
  veteran_status: "I am not a protected veteran"
  disability_status: "I do not want to answer"

work_auth:
  authorized_us: "Yes"
  sponsorship_needed: "No"
  office_willing: "Yes"

education:
  degree: ""
  major: ""
  university: ""
  graduation_year: ""

experience:
  current_title: "Full stack intern"
  current_company: "Student Spot"
  location: "Hybrid"
  from_date: "11/2022"
  to_date: "05/2026"
  description: ""
  currently_working: false

education:
  university: "AVNIET"
  degree: "Bachelor's Degree"
  major: "Computer Engineering"
  field_of_study_hierarchy:
    - "Engineering"
    - "Computer Engineering"
  graduation_year: "2026"
`;
    await mkdir(resolve(process.cwd(), 'config'), { recursive: true });
    await writeFile(profilePath, blank);
    console.log('📄 Created blank config/profile.yml — fill in your details.');
  }

  const resumesPath = resolve(process.cwd(), 'config', 'resumes.yml');
  if (!existsSync(resumesPath)) {
    const resumeExample = resolve(__dirname, 'config', 'resumes.example.yml');
    const resumeLocal = resolve(process.cwd(), 'config', 'resumes.example.yml');
    const src = existsSync(resumeLocal) ? resumeLocal : existsSync(resumeExample) ? resumeExample : null;
    if (src) {
      await writeFile(resumesPath, await readFile(src, 'utf-8'));
      console.log('📄 Copied resumes.example.yml → resumes.yml');
    }
  }

  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    const envExample = resolve(__dirname, '.env.example');
    const envLocal = resolve(process.cwd(), '.env.example');
    const src = existsSync(envLocal) ? envLocal : existsSync(envExample) ? envExample : null;
    if (src) {
      await writeFile(envPath, await readFile(src, 'utf-8'));
      console.log('📄 Copied .env.example → .env (edit WORKDAY_EMAIL and WORKDAY_PASSWORD)');
    }
  }

  await mkdir(resolve(process.cwd(), 'resumes'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'forms'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'screenshots'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });

  console.log(`
✅ Setup complete! Next steps:

  1. Edit config/profile.yml with your details
  2. Edit config/resumes.yml and add your PDF to resumes/
  3. Edit .env with WORKDAY_EMAIL and WORKDAY_PASSWORD (one-time login; no mailbox OTP)
  4. Run: auto-apply apply <job-url>

Or add URLs to queue:
  auto-apply queue add <url> <company>
  auto-apply batch
`);
}

// ─── Workday URL guard ──────────────────────────────────────────────────────
function assertWorkdayUrl(url) {
  const check = validateWorkdayUrl(url);
  if (!check.valid) {
    console.error(`❌ ${check.reason}`);
    console.error('   This build supports Workday career URLs only (myworkdayjobs.com).');
    process.exit(1);
  }
}

// ─── SCAN ───────────────────────────────────────────────────────────────────
async function cmdScan(url) {
  if (!url) {
    console.log('Usage: node cli.mjs scan <url>');
    process.exit(1);
  }
  assertWorkdayUrl(url);
  const creds = await resolveAuthCredentials();
  const profile = creds.profile || await loadProfile().catch(() => ({}));
  if (url) {
    profile._canonicalJobUrl = url;
    profile._jobUrl = url;
    profile._company = extractWorkdayCompanyName(url);
  }
  await scanForm(url, {
    workdayEmail: creds.workdayEmail,
    workdayPassword: creds.workdayPassword,
    mode: creds.mode,
    profile,
  });
}

// ─── FILL ───────────────────────────────────────────────────────────────────
async function cmdFill(url, planPath) {
  if (!url) {
    console.log('Usage: node cli.mjs fill <url> [plan.json]');
    process.exit(1);
  }
  assertWorkdayUrl(url);

  const creds = await resolveAuthCredentials();
  let plan;
  if (planPath) {
    const raw = await readFile(planPath, 'utf-8');
    plan = JSON.parse(raw);
    console.log(`📋 Plan: ${planPath}`);
  } else {
    console.log('📋 Auto-generating fill plan from profile...');
    const profile = creds.profile || await loadProfile();
    const scan = await scanForm(url, {
      workdayEmail: creds.workdayEmail,
      workdayPassword: creds.workdayPassword,
      mode: creds.mode,
      profile,
    });

    if (scan.authFailed || (scan.field_count === 0 && !await isWorkdayWizardVisible(page))) {
      console.log('\n❌ Workday authentication could not be completed.');
      return 'auth-failed';
    }

    const resumesYml = findFilePath('config/resumes.yml');
    let resumePath = null;
    if (existsSync(resumesYml)) {
      resumePath = await pickResume('', resumesYml);
    }
    if (resumePath) profile._resumePath = resumePath;

    plan = await generatePlan(scan, profile, { resumePath, url });

    const slug = slugify(url);
    const planOutPath = resolve(process.cwd(), 'forms', `${slug}-plan.json`);
    await writeFile(planOutPath, JSON.stringify(plan, null, 2));
    console.log(`📄 Auto-plan saved: ${planOutPath}`);

    if (plan.unmapped?.length > 0) {
      console.log(`\n⚠️  ${plan.unmapped.length} unmapped field(s) — may need manual values:`);
      plan.unmapped.forEach(f => console.log(`    - ${f.label} [${f.type}]`));
    }
  }

  plan = await applyLearnings(plan, url);
  plan = resolveDynamicFields(plan);

  try {
    await fillForm(url, plan, {
      workdayEmail: creds.workdayEmail,
      workdayPassword: creds.workdayPassword,
      mode: creds.mode,
      confirmSubmit,
    });
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`\n❌ [${timestamp}] Form fill error: ${err.message}`);
    console.log('   Stopping pipeline. Exiting cleanly without reopening job link.\n');
  }
}

// ─── APPLY (full pipeline) ──────────────────────────────────────────────────
async function cmdApply(url) {
  if (!url) {
    console.log('Usage: node cli.mjs apply <url> [--client <id>] [--signup|--signin] [--confirm-submit]');
    process.exit(1);
  }
  assertWorkdayUrl(url);

  const profilePath = findFilePath('config/profile.yml');
  if (!isApiOnlyAnswerMode() && !existsSync(profilePath)) {
    console.log('❌ No config/profile.yml found. Run: node cli.mjs setup');
    process.exit(1);
  }

  const creds = await resolveAuthCredentials();
  const profile = creds.profile || await loadProfile(profilePath);

  const company = extractWorkdayCompanyName(url);
  profile._canonicalJobUrl = url;
  profile._jobUrl = url;
  if (company) profile._company = company;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 AUTO-APPLY: ${url} (Mode: ${creds.mode})`);
  if (company) console.log(`🏢 Company: ${company}`);
  console.log(`${'═'.repeat(60)}\n`);

  const ats = detectATS(url);
  console.log(`🔍 ATS: ${ats}`);
  if (ats !== 'workday') {
    console.error('❌ Only Workday career URLs are supported in this build.');
    process.exit(1);
  }

  const isHeadless = process.argv.includes('--headless') || process.env.HEADLESS === 'true' || process.env.HEADLESS === '1';
  const browser = await chromium.launch({ headless: isHeadless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('\n── Step 1: Scan form ──');
    const scan = await scanForm(url, {
      browser,
      context,
      page,
      keepOpen: true,
      workdayEmail: creds.workdayEmail,
      workdayPassword: creds.workdayPassword,
      mode: creds.mode,
      profile,
    });

    const roleTitle = await extractJobRoleFromDom(page, url);
    if (roleTitle) {
      profile._jobTitle = roleTitle;
      profile._roleTitle = roleTitle;
      console.log(`💼 Role: ${roleTitle}`);
    }

    if (scan.authFailed || (scan.field_count === 0 && !await isWorkdayWizardVisible(page))) {
      // Check if wizard is reachable via Continue Application or reload before failing
      const wizardNow = await isWorkdayWizardVisible(page).catch(() => false);
      if (!wizardNow) {
        console.log('\n❌ Workday authentication could not be completed (account requires email verification or credentials invalid).');
        console.log('   Stopping pipeline cleanly.\n');
        try { await browser.close(); } catch {}
        return 'auth-failed';
      }
    }

    console.log('\n── Step 2: Load profile & pick resume ──');
    let jdText = '';
    try {
      jdText = await extractJDText(page);
    } catch { /* couldn't extract JD */ }

    const resumesYml = findFilePath('config/resumes.yml');
    let resumePath = null;
    if (existsSync(resumesYml)) {
      resumePath = await pickResume(jdText, resumesYml);
    }
    if (resumePath) profile._resumePath = resumePath;

    console.log('\n── Step 3: Generate fill plan ──');
    let plan = await generatePlan(scan, profile, { resumePath, jdText, url });
    if (profile._company) plan.company = profile._company;
    if (profile._jobTitle) {
      plan.jobTitle = profile._jobTitle;
      plan.role = profile._jobTitle;
    }

    const slug = slugify(url);
    const planPath = resolve(process.cwd(), 'forms', `${slug}-plan.json`);
    await writeFile(planPath, JSON.stringify(plan, null, 2));
    console.log(`📄 Plan: ${planPath}`);
    console.log(`📋 ${plan.fills.length} fills, ${plan.skipped.length} skipped, ${plan.unmapped?.length || 0} unmapped`);

    if (plan.unmapped?.length > 0) {
      console.log(`\n⚠️  Unmapped fields (will be skipped):`);
      plan.unmapped.forEach(f => console.log(`    - ${f.label} [${f.type}]`));
    }

    plan = await applyLearnings(plan, url);
    plan = resolveDynamicFields(plan);

    console.log('\n── Step 4: Fill & Submit ──');
    const status = await fillForm(url, plan, {
      browser,
      context,
      page,
      profile,
      workdayEmail: creds.workdayEmail,
      workdayPassword: creds.workdayPassword,
      mode: creds.mode,
      confirmSubmit,
    });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ Pipeline complete: ${status}`);
    console.log(`${'═'.repeat(60)}\n`);
    return status;
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`\n❌ [${timestamp}] Form fill error for ${url}: ${err.message}`);
    console.log('   Stopping pipeline. Exiting cleanly without reopening job link.\n');
    try { await browser.close(); } catch { }
    return 'error';
  }
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────
async function cmdQueue(subcommand, ...args) {
  switch (subcommand) {
    case 'add': {
      const url = args[0];
      if (!url) { console.log('Usage: node cli.mjs queue add <url> [company]'); process.exit(1); }
      assertWorkdayUrl(url);
      const company = args.slice(1).join(' ') || '';
      await addToQueue(url, company);
      break;
    }
    case 'list': {
      const entries = await loadQueue();
      if (entries.length === 0) {
        console.log('📋 Queue is empty. Add URLs with: node cli.mjs queue add <url>');
        return;
      }
      console.log(`\n📋 Application Queue (${entries.length} entries)\n`);
      console.log('  Status     │ Company              │ URL');
      console.log('  ───────────┼──────────────────────┼─────────────────────────────────');
      for (const e of entries) {
        const icon = e.status === 'pending' ? '⏳' : e.status === 'submitted' ? '✅' : e.status === 'failed' ? '❌' : '🔄';
        const status = `${icon} ${e.status}`.padEnd(12);
        const company = (e.company || '—').substring(0, 20).padEnd(20);
        const url = e.url.length > 50 ? e.url.substring(0, 47) + '...' : e.url;
        console.log(`  ${status}│ ${company} │ ${url}`);
      }
      const pending = entries.filter(e => e.status === 'pending').length;
      const done = entries.filter(e => ['submitted', 'applied'].includes(e.status)).length;
      const failed = entries.filter(e => e.status === 'failed').length;
      console.log(`\n  Pending: ${pending}  Applied: ${done}  Failed: ${failed}\n`);
      break;
    }
    case 'remove': {
      const url = args[0];
      if (!url) { console.log('Usage: node cli.mjs queue remove <url>'); process.exit(1); }
      const entries = await loadQueue();
      const filtered = entries.filter(e => e.url !== url);
      if (filtered.length === entries.length) {
        console.log(`  ⚠️  URL not found in queue: ${url}`);
      } else {
        await saveQueue(filtered);
        console.log(`  ✅ Removed from queue: ${url}`);
      }
      break;
    }
    case 'clear': {
      const entries = await loadQueue();
      const kept = entries.filter(e => e.status === 'pending');
      const removed = entries.length - kept.length;
      await saveQueue(kept);
      console.log(`  ✅ Cleared ${removed} completed/failed entries. ${kept.length} pending remain.`);
      break;
    }
    default:
      console.log(`Usage:
  node cli.mjs queue add <url> [company]    Add URL to queue
  node cli.mjs queue list                   Show queue
  node cli.mjs queue remove <url>           Remove URL
  node cli.mjs queue clear                  Clear completed/failed entries`);
  }
}

// ─── WD5 BATCH SCAN (DOM catalog, no apply) ─────────────────────────────────
async function cmdScanBatch(file) {
  const csvPath = file || resolve(process.cwd(), 'data', 'wd5.csv');
  if (!existsSync(csvPath)) {
    console.error(`❌ CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const creds = await resolveAuthCredentials();
  await runWd5BatchScan({
    csvPath,
    offset: scanBatchOffset,
    limit: scanBatchLimit,
    skipOnAuthFail: scanBatchSkipAuth,
    interactive: scanBatchInteractive,
    waitAtReview: scanBatchWaitReview,
    auth: {
      workdayEmail: creds.workdayEmail,
      workdayPassword: creds.workdayPassword,
      mode: creds.mode,
    },
  });
}

async function cmdCatalogShow() {
  const creds = await resolveAuthCredentials();
  await showWd5CatalogPending(creds.profile);
}

// ─── BATCH ──────────────────────────────────────────────────────────────────
async function cmdBatch(file) {
  let targets = [];
  let source = '';

  const todayCsv = resolve(process.cwd(), 'data', 'today.csv');
  const jobsCsv = resolve(process.cwd(), 'data', 'jobs.csv');
  const filePath = file
    ? (existsSync(file) ? file : resolve(process.cwd(), file))
    : (existsSync(todayCsv) ? todayCsv : existsSync(jobsCsv) ? jobsCsv : '');

  if (file || filePath) {
    const csvPath = filePath || file;
    if (!existsSync(csvPath)) {
      console.error(`❌ File not found: ${csvPath}`);
      process.exit(1);
    }
    targets = await readJobLinksFile(csvPath);
    source = csvPath;
  } else {
    const pending = await getPendingFromQueue();
    targets = pending.map((e) => ({ url: e.url, company: e.company }));
    source = 'queue';
  }

  if (targets.length === 0) {
    console.log('📋 No Workday URLs found.');
    console.log('   Drop today\'s 24h dump at data/today.csv (or pass the path):');
    console.log('   node cli.mjs batch data/today.csv --limit 15');
    return;
  }

  const offset = scanBatchOffset;
  const limit = batchLimitExplicit && scanBatchLimit > 0 ? scanBatchLimit : targets.length;
  const slice = targets.slice(offset, offset + limit);

  console.log(`📦 Batch apply: ${slice.length} of ${targets.length} URL(s) from ${source}`);
  if (offset || limit < targets.length) {
    console.log(`   Window: offset=${offset} limit=${limit} (next: --offset ${offset + slice.length})`);
  }
  console.log('   At Review: [Y] submit  [N] stop batch  [S] skip to next URL\n');

  const results = [];
  let stopped = false;
  for (let i = 0; i < slice.length; i++) {
    const url = slice[i].url;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[${offset + i + 1}/${targets.length}] ${slice[i].company || ''} ${url}`);
    console.log(`${'═'.repeat(60)}`);

    try {
      let status = 'incomplete';
      for (let attempt = 1; attempt <= 3; attempt++) {
        status = await cmdApply(url);
        if (status === 'submitted' || status === 'skipped' || status === 'review-declined') break;
        if (status === 'auth-failed' || status === 'job_not_found') break;
        if (status === 'incomplete' || status === 'error' || !status) {
          console.log(`\n  ↻ This job is not at Review yet (attempt ${attempt}/3). Staying on this URL — not opening the next link.`);
          if (attempt < 3) continue;
        }
        break;
      }
      results.push({ url, status: status || 'done' });
      if (status === 'review-declined') {
        console.log('\n🛑 N — batch stopped. Remaining URLs were not opened.');
        stopped = true;
        break;
      }
      if (status === 'incomplete' || status === 'error') {
        console.log('\n🛑 Form on this URL is not complete through Review. Next link will not be opened.');
        console.log('   Re-run the same URL after the remaining required fields are filled.');
        stopped = true;
        break;
      }
    } catch (err) {
      console.error(`❌ Failed: ${err.message}`);
      results.push({ url, status: 'error', error: err.message });
      console.log('\n🛑 Staying on this URL after a crash — next link will not be opened.');
      stopped = true;
      break;
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Batch Summary');
  console.log(`${'═'.repeat(60)}`);
  const submitted = results.filter((r) => r.status === 'submitted').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const declined = results.filter((r) => r.status === 'review-declined').length;
  const fail = results.filter((r) => r.status === 'error' || r.status === 'auth-failed' || r.status === 'job_not_found').length;
  console.log(`  ✅ Submitted: ${submitted}`);
  console.log(`  ⏭️  Skipped:   ${skipped}`);
  console.log(`  ✋ Stopped:   ${declined}${stopped ? ' (N at Review)' : ''}`);
  console.log(`  ❌ Failed:    ${fail}`);
  console.log(`  Total this window: ${results.length}`);
  if (!stopped && offset + slice.length < targets.length) {
    console.log(`\n  Next batch:\n  node cli.mjs batch "${source}" --offset ${offset + slice.length} --limit ${limit}`);
  }
}

// ─── STATUS ─────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const stats = await getStats();

  console.log(`
╔════════════════════════════════════════════════════════╗
║          auto-apply — Status                          ║
╚════════════════════════════════════════════════════════╝

Overall:
  Total applications: ${stats.overall.total}
  Submitted: ${stats.overall.submitted}
  Failed: ${stats.overall.failed}
  Success rate: ${stats.overall.total > 0 ? Math.round(stats.overall.submitted / stats.overall.total * 100) : 0}%

By ATS:`);

  for (const [ats, s] of Object.entries(stats.byATS)) {
    const rate = s.total > 0 ? Math.round(s.submitted / s.total * 100) : 0;
    console.log(`  ${ats}: ${s.submitted}/${s.total} (${rate}%)`);
  }

  console.log(`
Learnings:
  Field corrections: ${stats.corrections}
  Option mappings: ${stats.optionMappings}
  Last run: ${stats.lastRun || 'never'}
`);

  const csvPath = resolve(process.cwd(), 'data', 'applied.csv');
  if (existsSync(csvPath)) {
    const csv = await readFile(csvPath, 'utf-8');
    const lines = csv.trim().split('\n');
    console.log(`Recent applications (${lines.length - 1} total):`);
    lines.slice(-6).forEach(l => console.log(`  ${l}`));
  }

  const queue = await loadQueue();
  if (queue.length > 0) {
    const pending = queue.filter(e => e.status === 'pending').length;
    const applied = queue.filter(e => ['submitted', 'applied'].includes(e.status)).length;
    const failed = queue.filter(e => e.status === 'failed').length;
    console.log(`\nQueue: ${pending} pending, ${applied} applied, ${failed} failed (${queue.length} total)`);
    if (pending > 0) console.log(`  Run 'node cli.mjs batch' to process pending queue entries.`);
  }
}

// ─── LIST ──────────────────────────────────────────────────────────────────
async function cmdList() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║          auto-apply — Application Dashboard           ║
╚════════════════════════════════════════════════════════╝
`);

  const csvPath = resolve(process.cwd(), 'data', 'applied.csv');
  let applied = [];
  if (existsSync(csvPath)) {
    const raw = await readFile(csvPath, 'utf-8');
    const lines = raw.trim().split('\n');
    const header = lines[0] || '';
    const isNewFormat = header.startsWith('date,company,role,url');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const parts = parseCSVLine(line);
      if (isNewFormat) {
        applied.push({ date: parts[0], company: parts[1], role: parts[2], url: parts[3], status: parts[4], ats: parts[5] || '' });
      } else {
        applied.push({ date: parts[0], url: parts[1], company: parts[2], role: parts[3], status: parts[4], ats: '' });
      }
    }
  }

  const queue = await loadQueue();

  const targetsPath = resolve(process.cwd(), 'targets.txt');
  let targets = [];
  if (existsSync(targetsPath)) {
    const raw = await readFile(targetsPath, 'utf-8');
    targets = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }

  const submitted = applied.filter(a => a.status === 'submitted');
  const attempted = applied.filter(a => a.status !== 'submitted');

  if (submitted.length > 0) {
    console.log(`✅ SUBMITTED (${submitted.length})\n`);
    console.log('  Date        │ Company              │ Role                              │ ATS');
    console.log('  ───────────┼──────────────────────┼───────────────────────────────────┼──────────');
    for (const a of submitted) {
      const company = (a.company || '—').substring(0, 20).padEnd(20);
      const role = (a.role || '—').substring(0, 33).padEnd(33);
      const ats = (a.ats || '—').padEnd(8);
      console.log(`  ${a.date} │ ${company} │ ${role} │ ${ats}`);
    }
    console.log();
  }

  if (attempted.length > 0) {
    console.log(`⚠️  ATTEMPTED but not submitted (${attempted.length})\n`);
    for (const a of attempted) {
      const company = a.company || '—';
      const role = a.role || '—';
      console.log(`  ${a.date}  ${a.status.padEnd(22)} ${company} — ${role}`);
    }
    console.log();
  }

  const pending = queue.filter(e => e.status === 'pending');
  if (pending.length > 0) {
    console.log(`⏳ PENDING in queue (${pending.length})\n`);
    for (const e of pending) {
      const company = e.company || '—';
      const url = e.url.length > 55 ? e.url.substring(0, 52) + '...' : e.url;
      console.log(`  ${company.padEnd(20)} ${url}`);
    }
    console.log(`\n  Run 'auto-apply batch' to process these.\n`);
  }

  const appliedUrls = new Set([...applied.map(a => a.url), ...queue.map(e => e.url)]);
  const unapplied = targets.filter(t => !appliedUrls.has(t));
  if (unapplied.length > 0) {
    console.log(`📋 NOT YET APPLIED from targets.txt (${unapplied.length})\n`);
    for (const url of unapplied.slice(0, 20)) {
      try {
        const host = new URL(url).hostname.replace(/^(www|careers|jobs|job-boards)\./i, '').replace(/\..+$/, '');
        console.log(`  ${host.padEnd(20)} ${url}`);
      } catch {
        console.log(`  ${'—'.padEnd(20)} ${url}`);
      }
    }
    if (unapplied.length > 20) console.log(`  ... and ${unapplied.length - 20} more`);
    console.log(`\n  Add to queue: auto-apply queue add <url> [company]`);
    console.log();
  }

  if (applied.length === 0 && pending.length === 0 && unapplied.length === 0) {
    console.log('📋 No applications yet. Run: auto-apply apply <url>\n');
  }

  console.log('═'.repeat(80));
  console.log(`  Total: ${submitted.length} submitted, ${attempted.length} attempted, ${pending.length} pending, ${unapplied.length} remaining`);
  console.log('═'.repeat(80));
}

function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current); current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// ─── HELP ───────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
auto-apply — Workday Auto-Apply Bot (Node.js + Playwright)

Usage:
  node cli.mjs setup                     Set up your profile
  node cli.mjs scan <url>                  Scan Workday form fields → JSON
  node cli.mjs fill <url> [plan.json]      Fill form (auto-plan if no plan given)
  node cli.mjs apply <url>                 Full pipeline: scan → plan → fill → submit (asks Y/N/S)
  node cli.mjs batch [data/today.csv]      Apply every Workday URL in today's CSV (or queue)
  node cli.mjs scan-batch [data/wd5.csv]   Scan DOM questions from wd5.csv (batch)
  node cli.mjs catalog-show                List unanswered questions per company YAML
  node cli.mjs queue add <url> [company]   Add Workday URL to application queue
  node cli.mjs queue list                  Show queue entries
  node cli.mjs queue remove <url>          Remove URL from queue
  node cli.mjs queue clear                 Clear completed/failed entries
  node cli.mjs list                        Show all applied jobs + what's left
  node cli.mjs status                      Show stats & learnings

Options:
  --signin / --signup          Workday auth mode (default: signin — tries login, then Create Account if no account exists on that tenant)
  --confirm-submit             Auto-submit at Review (skips Y/N/S prompt)
  --offset <n>                 Batch start index (default 0)
  --limit <n>                  Batch window size (apply: all unless set; scan-batch: 15)
  --workday-email <email>      Workday account email (or WORKDAY_EMAIL in .env)
  --workday-password <password> Workday password (or WORKDAY_PASSWORD in .env)

Env (Apply Wizz client — optional, one fetch per run):
  APPLYWIZZ_ID=AWL-34133
  or APPLYWIZZ_API_URL=https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-34133

Scope: Workday career sites only (myworkdayjobs.com). Headed browser always.

Examples:
  node cli.mjs apply https://company.wd5.myworkdayjobs.com/en-US/company/job/123
  node cli.mjs batch data/today.csv
  node cli.mjs batch data/today.csv --offset 0 --limit 15
  At Review: [Y] submit  [N] do not submit / stop batch  [S] skip to next URL
  node cli.mjs scan-batch data/wd5.csv --offset 0 --limit 15
  (dead job URLs + login fail + browser crash: skipped automatically; --no-skip-auth to stop on login fail)
  (scan-batch interactive by default; --no-interactive to disable)
  (questions + answers saved to config/tenant-overrides/{tenant}.yml per company)
  node cli.mjs catalog-show
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  await loadEnv();

  switch (command) {
    case 'setup': await cmdSetup(); break;
    case 'scan': await cmdScan(positionalArgs[0]); break;
    case 'fill': await cmdFill(positionalArgs[0], positionalArgs[1]); break;
    case 'apply': await cmdApply(positionalArgs[0]); break;
    case 'batch': await cmdBatch(positionalArgs[0]); break;
    case 'scan-batch': await cmdScanBatch(positionalArgs[0]); break;
    case 'catalog-show': await cmdCatalogShow(); break;
    case 'queue': await cmdQueue(positionalArgs[0], ...positionalArgs.slice(1)); break;
    case 'list': await cmdList(); break;
    case 'status': await cmdStatus(); break;
    default: showHelp();
  }
}

main().catch(err => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});