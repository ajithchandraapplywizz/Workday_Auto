/**
 * wd5BatchScan.mjs — Batch DOM question harvest from data/wd5.csv
 *
 * Visits Workday URLs in batches, walks wizard steps, records questions + options.
 * Merges into data/wd5-question-catalog.json for terminal / chat review.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { discoverApplicationForm, detectATS, detectWorkdayTenant, getWorkdayTenant, isWorkdayJobPageMissing } from './discovery.mjs';
import { handleWorkday } from './workday.mjs';
import { waitForDomSettled } from './workdayDom.mjs';
import { normalizeLabel, findBestMatch, loadSettings, createQAStore } from './qaStore.mjs';
import { loadProfile } from './planner.mjs';
import { slugify } from './scanner.mjs';
import { saveQuestionsToTenantYaml, getTenantYamlPath, listPendingTenantQuestions } from './tenantQuestionYaml.mjs';
import { runWorkdayQuestionScanLoop } from './engine.mjs';
import { formatStepQuestionSummary } from './workdayScanHarvest.mjs';

const DEFAULT_CSV = resolve(process.cwd(), 'data', 'wd5.csv');
const CATALOG_PATH = resolve(process.cwd(), 'data', 'wd5-question-catalog.json');
const SCAN_DIR = resolve(process.cwd(), 'data', 'wd5-scans');

function parseCsvLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * @param {string} csvPath
 * @returns {Promise<Array<{ domain: string, company: string, url: string }>>}
 */
export async function parseWd5Csv(csvPath = DEFAULT_CSV) {
  const raw = await readFile(csvPath, 'utf-8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [domain, company, url] = parseCsvLine(trimmed);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const parsedUrl = url.trim();
    rows.push({
      domain: (domain || detectWorkdayTenant(parsedUrl)?.platform || '').trim(),
      company: (company || '').trim(),
      url: parsedUrl,
    });
  }
  return rows;
}

/**
 * Walk wizard steps on one URL and collect questions (scan-only, no fill).
 */
export async function scanUrlQuestionHarvest(page, row, auth = {}, { interactive = true, waitAtReview = true } = {}) {
  const { company, url } = row;
  const result = {
    company,
    url,
    tenant: detectWorkdayTenant(url)?.tenant || getWorkdayTenant(url),
    platform: detectWorkdayTenant(url)?.platform || '',
    status: 'ok',
    error: null,
    steps: [],
    questions: [],
    scanned_at: new Date().toISOString(),
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(800);

    if (await isWorkdayJobPageMissing(page)) {
      result.status = 'job_not_found';
      result.error = 'Job page does not exist (dead/expired Workday URL)';
      return result;
    }

    const ats = detectATS(url);
    await discoverApplicationForm(page, url, { mode: auth.mode || 'signin' });

    if (ats === 'workday') {
      const authOk = await handleWorkday(page, {
        email: auth.workdayEmail,
        password: auth.workdayPassword,
        mode: auth.mode || 'signin',
      });
      if (!authOk) {
        result.status = 'auth_failed';
        result.error = 'Workday authentication not completed';
        return result;
      }
      await waitForDomSettled(page);
    }

    let profile = auth.profile;
    if (!profile) {
      try { profile = await loadProfile(); } catch { profile = {}; }
    }

    const scan = await runWorkdayQuestionScanLoop(page, profile, {}, {
      company,
      url,
      interactive,
      waitAtReview,
    });
    result.steps = scan.steps || [];
    result.questions = scan.questions || [];
    result.questions_by_step = scan.byStep || {};
    result.reached_review = Boolean(scan.reachedReview);
    result.review_decision = scan.reviewDecision || 'next';
    if (scan.reviewDecision === 'stop') {
      result.status = 'review_stopped';
    }

    const slug = slugify(url);
    await mkdir(SCAN_DIR, { recursive: true });
    const outPath = resolve(SCAN_DIR, `${company || 'unknown'}-${slug}.json`.replace(/[^a-z0-9._-]+/gi, '-'));
    await writeFile(outPath, JSON.stringify(result, null, 2));

    const tenantYaml = await saveQuestionsToTenantYaml({
      tenant: result.tenant,
      company,
      url,
      questions: result.questions,
      scanned_at: result.scanned_at,
    });
    if (tenantYaml) {
      result.tenant_yaml = tenantYaml.path;
      result.tenant_yaml_total = tenantYaml.total;
      result.tenant_yaml_added = tenantYaml.added;
    }

    return result;
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
    return result;
  }
}

function mergeQuestionCatalog(existing = {}, scanResults = []) {
  const catalog = {
    updated_at: new Date().toISOString(),
    total_urls_scanned: existing.total_urls_scanned || 0,
    unique_questions: { ...(existing.unique_questions || {}) },
    scans: [...(existing.scans || [])],
  };

  for (const run of scanResults) {
    catalog.total_urls_scanned += 1;
    catalog.scans.push({
      company: run.company,
      url: run.url,
      tenant: run.tenant,
      status: run.status,
      error: run.error,
      steps: run.steps,
      question_count: run.questions?.length || 0,
      scanned_at: run.scanned_at,
    });

    for (const q of run.questions || []) {
      const key = q.normalized;
      if (!key) continue;
      const prev = catalog.unique_questions[key];
      if (!prev) {
        catalog.unique_questions[key] = {
          label: q.label,
          fieldType: q.fieldType,
          options: q.options || [],
          required: q.required,
          companies: [q.company],
          tenants: [q.tenant],
          steps: [q.step],
          seen_count: 1,
        };
        continue;
      }
      prev.seen_count = (prev.seen_count || 1) + 1;
      if (!prev.companies.includes(q.company)) prev.companies.push(q.company);
      if (!prev.tenants.includes(q.tenant)) prev.tenants.push(q.tenant);
      if (!prev.steps.includes(q.step)) prev.steps.push(q.step);
      for (const opt of q.options || []) {
        if (!prev.options.includes(opt)) prev.options.push(opt);
      }
    }
  }

  return catalog;
}

async function createScanSession(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function closeScanSession(session) {
  if (!session) return;
  try { if (session.page && !session.page.isClosed()) await session.page.close(); } catch {}
  try { if (session.context) await session.context.close(); } catch {}
}

function isClosedBrowserError(message = '') {
  return /target page.*closed|browser has been closed|context.*closed|execution context was destroyed/i.test(String(message));
}

/**
 * @param {object} opts
 * @param {string} [opts.csvPath]
 * @param {number} [opts.offset]
 * @param {number} [opts.limit]
 * @param {object} [opts.auth]
 * @param {boolean} [opts.skipOnAuthFail] — skip URL and continue when login fails (default true)
 */
export async function runWd5BatchScan({
  csvPath = DEFAULT_CSV,
  offset = 0,
  limit = 15,
  auth = {},
  skipOnAuthFail = true,
  interactive = true,
  waitAtReview = true,
} = {}) {
  const rows = await parseWd5Csv(csvPath);
  const slice = rows.slice(offset, offset + limit);
  if (slice.length === 0) {
    console.log(`No rows in batch (offset=${offset}, limit=${limit}, total=${rows.length})`);
    return null;
  }

  console.log(`\n📦 WD5 batch scan: ${slice.length} URL(s) [${offset + 1}-${offset + slice.length} of ${rows.length}]`);
  console.log(`   CSV: ${csvPath}`);
  console.log(`   Catalog: ${CATALOG_PATH}`);
  console.log(`   Per-company YAML: config/tenant-overrides/{tenant}.yml`);
  console.log(`   On login failure: ${skipOnAuthFail ? 'skip URL and continue' : 'stop batch'}`);
  console.log(`   Mode: ${interactive ? 'interactive (yaml/mjs fill + terminal for unknowns)' : 'silent (no terminal prompts)'}`);
  console.log(`   Review step: ${waitAtReview ? 'pause for your approval before next URL' : 'auto-continue'}\n`);

  const browser = await chromium.launch({ headless: false });
  let session = await createScanSession(browser);

  const scanResults = [];
  let skippedAuth = 0;
  let skippedDead = 0;
  let skippedError = 0;

  try {
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`[${offset + i + 1}/${rows.length}] ${row.company} — ${row.url}`);

      if (session.page.isClosed()) {
        console.log('   ↻ Browser page was closed — opening a fresh session...');
        await closeScanSession(session);
        session = await createScanSession(browser);
      }

      let run;
      try {
        run = await scanUrlQuestionHarvest(session.page, row, auth, { interactive, waitAtReview });
      } catch (err) {
        run = {
          company: row.company,
          url: row.url,
          tenant: detectWorkdayTenant(row.url)?.tenant || getWorkdayTenant(row.url),
          platform: detectWorkdayTenant(row.url)?.platform || '',
          status: 'error',
          error: err.message,
          steps: [],
          questions: [],
          scanned_at: new Date().toISOString(),
        };
      }

      scanResults.push(run);
      const stepSummary = formatStepQuestionSummary(run.questions_by_step || {});
      console.log(`   Status: ${run.status} | steps: [${(run.steps || []).join(' → ')}] | questions: ${(run.questions || []).length}`);
      if (stepSummary !== 'none') console.log(`   Per-step: ${stepSummary}`);
      if (run.tenant) {
        const yamlPath = run.tenant_yaml || getTenantYamlPath(run.tenant);
        if (yamlPath && run.status === 'ok') {
          console.log(`   Company: ${run.company} → tenant: ${run.tenant}`);
          console.log(`   YAML: ${yamlPath} (${run.tenant_yaml_total ?? 0} question(s) stored)`);
        }
      }
      if (run.error) console.log(`   Error: ${run.error}`);
      if (run.reached_review) {
        console.log(`   Review: reached — decision: ${run.review_decision || 'next'}`);
      }

      if (run.status === 'review_stopped') {
        console.log('   🛑 Batch stopped — you chose Quit at Review step');
        break;
      }

      if (run.status === 'ok' && !run.reached_review) {
        run.status = 'incomplete';
        console.log('   🛑 Application did not reach Review — batch paused (will NOT open next URL)');
        console.log('      Fix required fields in browser / terminal, then re-run scan from this offset.');
        break;
      }

      if (run.status === 'job_not_found') {
        skippedDead++;
        console.log('   ⏭️  Skipping — job page does not exist (dead URL), moving to next');
        continue;
      }

      if (run.status === 'auth_failed') {
        skippedAuth++;
        if (skipOnAuthFail) {
          console.log('   ⏭️  Skipping — login failed, moving to next URL');
          await closeScanSession(session);
          session = await createScanSession(browser);
          continue;
        }
        console.log('   ❌ Stopping batch (--no-skip-auth or login failure without skip)');
        break;
      }

      if (run.status === 'error') {
        if (isClosedBrowserError(run.error)) {
          skippedError++;
          console.log('   ⏭️  Skipping — browser closed/crashed, recovering for next URL');
          await closeScanSession(session);
          session = await createScanSession(browser);
          continue;
        }
        console.log('   🛑 Scan error — batch paused (will NOT open next URL)');
        console.log('      Fix the issue in browser / terminal, then re-run scan from this offset.');
        break;
      }
    }
  } finally {
    await closeScanSession(session);
    await browser.close().catch(() => {});
  }

  if (skippedAuth > 0 || skippedDead > 0 || skippedError > 0) {
    console.log(`\n   Summary: skipped ${skippedDead} dead URL(s), ${skippedAuth} login failure(s), recovered ${skippedError} browser error(s)`);
  }

  let existing = {};
  if (existsSync(CATALOG_PATH)) {
    try {
      existing = JSON.parse(await readFile(CATALOG_PATH, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  const catalog = mergeQuestionCatalog(existing, scanResults);
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));

  const uniqueCount = Object.keys(catalog.unique_questions).length;
  console.log(`\n✅ Catalog updated: ${uniqueCount} unique question(s) across ${catalog.total_urls_scanned} scan(s)`);
  console.log(`   File: ${CATALOG_PATH}`);

  return catalog;
}

/**
 * Print unanswered catalog questions for chat / terminal review.
 */
export async function showWd5CatalogPending(profile = null) {
  const prof = profile || await loadProfile().catch(() => ({}));
  const tenantPending = await listPendingTenantQuestions(prof);

  console.log(`\n📋 Per-company YAML questions — ${tenantPending.length} unanswered\n`);
  console.log('Each company file: config/tenant-overrides/{tenant}.yml → scanned_questions\n');
  console.log('Copy this list to chat and reply with answers (question → answer).\n');

  tenantPending.forEach((q, idx) => {
    console.log(`${idx + 1}. [${q.company}] ${q.label}`);
    console.log(`   Tenant: ${q.tenant} | Field: ${q.fieldType || 'unknown'} | step: ${q.step || 'n/a'}`);
    if (q.options?.length) {
      console.log(`   Options: ${q.options.slice(0, 12).join(' | ')}${q.options.length > 12 ? ' | ...' : ''}`);
    } else {
      console.log('   Input: type your answer');
    }
    console.log('');
  });

  if (tenantPending.length === 0) {
    console.log('All scanned_questions in tenant YAML files have answers (or profile/qa-store matches).');
  }

  if (!existsSync(CATALOG_PATH)) return;

  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf-8'));
  const store = createQAStore();
  const settings = await loadSettings();

  const catalogPending = [];
  for (const [norm, q] of Object.entries(catalog.unique_questions || {})) {
    const match = await findBestMatch(q.label, prof, store, settings.fuzzy_threshold);
    if (match?.answer) continue;
    catalogPending.push({ norm, ...q });
  }

  if (catalogPending.length === 0) return;

  catalogPending.sort((a, b) => (b.seen_count || 0) - (a.seen_count || 0));
  console.log(`\n📋 Global catalog (wd5-question-catalog.json) — ${catalogPending.length} more unanswered\n`);
  catalogPending.slice(0, 30).forEach((q, idx) => {
    console.log(`${idx + 1}. ${q.label}`);
    console.log(`   Field: ${q.fieldType || 'unknown'} | companies: ${(q.companies || []).slice(0, 4).join(', ')}`);
    console.log('');
  });
}
