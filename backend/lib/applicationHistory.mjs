/**
 * applicationHistory.mjs — Per Apply Wizz client + tenant job memory for "use previous application".
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { getWorkdayTenant, extractWorkdayCompanyName } from './discovery.mjs';
import { waitForDomSettled } from './workdayDom.mjs';
import { isSupabaseConfigured, upsertSupabaseApplication, hasClientAppliedToCompany } from './supabaseClient.mjs';

let inMemoryHistory = { clients: [] };

async function loadHistory() {
  return inMemoryHistory;
}

async function saveHistory(doc) {
  inMemoryHistory = doc;
}

function clientKey(profile = {}, tenant = '') {
  const id = String(
    profile._applyWizzId
    || profile.client_id
    || profile.applywizz_id
    || process.env.APPLYWIZZ_ID
    || profile.personal?.email
    || 'default',
  ).trim();
  return `${id}::${tenant || 'unknown'}`;
}

/**
 * Clean up Workday URLs: strip sub-paths like /apply/applyManually, /applicationSubmitted, and normalize comma encodings.
 */
export function normalizeJobUrl(rawUrl = '') {
  if (!rawUrl) return '';
  let url = String(rawUrl).trim();
  url = url.replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '');
  url = url.replace(/%2C/gi, ',');
  return url;
}

/**
 * Maps arbitrary run statuses to valid public.applications schema check constraints:
 * ('started', 'in_progress', 'submitted', 'failed', 'skipped')
 */
export function normalizeApplicationStatus(rawStatus = '', meta = {}) {
  const s = String(rawStatus || '').toLowerCase().trim();
  if (s === 'submitted') return 'submitted';
  if (s === 'skipped' || s === 'review_declined' || s === 'review-declined') return 'skipped';
  if (s === 'failed' || s === 'error' || s === 'incomplete') return 'failed';
  if (s === 'started') return 'started';
  if (
    s === 'in_progress'
    || s === 'ready_for_review'
    || s === 'review-pending-confirmation'
    || s === 'needs_manual_verification'
    || s === 'needs-manual-verification'
  ) {
    return 'in_progress';
  }
  if (meta.success === true) return 'in_progress';
  if (meta.tenantProgress === true) return 'in_progress';
  return 'started';
}

/**
 * Record or refresh client + company + URL after an apply attempt starts or completes.
 * @param {object} profile
 * @param {{ url?: string, company?: string, jobTitle?: string, success?: boolean, status?: string, failureReason?: string }} meta
 */
export async function recordClientApplication(profile = {}, meta = {}) {
  const canonicalSeed = profile._canonicalJobUrl || profile._jobUrl || meta.url || '';
  const url = normalizeJobUrl(canonicalSeed);
  if (url && !profile._canonicalJobUrl) profile._canonicalJobUrl = url;
  if (url && !profile._jobUrl) profile._jobUrl = url;

  const tenant = profile._tenant || (url ? getWorkdayTenant(url) : '');
  if (!tenant && !url) return null;
  const applywizzId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.client_id
    || process.env.APPLYWIZZ_ID
    || '',
  ).trim();

  const key = clientKey(profile, tenant);
  const doc = await loadHistory();
  const name = profile.personal?.full_name
    || [profile.personal?.first_name, profile.personal?.last_name].filter(Boolean).join(' ')
    || profile._clientName
    || '';

  const company = meta.company || profile._company || (url ? extractWorkdayCompanyName(url) : '') || tenant;
  const roleTitle = meta.jobTitle || meta.roleTitle || profile._jobTitle || profile._roleTitle || '';
  if (company && !profile._company) profile._company = company;
  if (roleTitle && !profile._jobTitle) profile._jobTitle = roleTitle;

  let row = doc.clients.find((c) => c.key === key);
  if (!row) {
    row = {
      key,
      applywizz_id: applywizzId,
      client_name: name,
      tenant,
      company,
      role_title: roleTitle,
      last_job_url: url,
      job_urls: url ? [url] : [],
      last_applied_at: new Date().toISOString(),
      prior_application_available: meta.success === true || meta.tenantProgress === true || meta.status === 'submitted',
    };
    doc.clients.push(row);
  } else {
    row.client_name = name || row.client_name;
    row.company = company || row.company;
    row.role_title = roleTitle || row.role_title;
    row.last_job_url = url || row.last_job_url;
    row.last_applied_at = new Date().toISOString();
    if (url && !row.job_urls.includes(url)) row.job_urls.push(url);
    if (meta.success === true || meta.tenantProgress === true || meta.status === 'submitted') {
      row.prior_application_available = true;
    }
  }

  await saveHistory(doc);
  if (isSupabaseConfigured() && applywizzId && url) {
    const status = normalizeApplicationStatus(meta.status, meta);
    await upsertSupabaseApplication({
      applywizzId,
      jobUrl: url,
      company,
      roleTitle,
      status,
      failureReason: meta.failureReason || '',
    }).then(() => console.log(`  ✓ Supabase application recorded: ${status} ← ${url} [Company: ${company || 'N/A'}, Role: ${roleTitle || 'N/A'}]`))
      .catch((err) => console.log(`  ⚠️  Supabase application save skipped: ${err.message?.slice(0, 120) || err}`));
  }
  return row;
}

/**
 * Check if client has a prior application on file for a company (local memory + Supabase).
 * @param {string} applywizzId
 * @param {string} companyName
 * @param {object} [profile]
 * @param {string} [url]
 * @returns {Promise<boolean>}
 */
export async function hasPriorApplicationForCompany(applywizzId, companyName, profile = {}, url = '') {
  const cleanId = String(applywizzId || '').trim();
  const cleanComp = String(companyName || '').toLowerCase().trim();

  // 1. Check local file memory
  const doc = await loadHistory();
  const localMatch = doc.clients.find((c) => {
    const idMatch = !cleanId || c.applywizz_id === cleanId;
    const compMatch = String(c.company || '').toLowerCase().trim() === cleanComp || String(c.tenant || '').toLowerCase().trim() === cleanComp;
    return idMatch && compMatch && Boolean(c.prior_application_available);
  });
  if (localMatch) return true;

  // 2. Check Supabase applications table
  if (cleanId && cleanComp) {
    const fromSupabase = await hasClientAppliedToCompany(cleanId, cleanComp);
    if (fromSupabase) return true;
  }

  // 3. Fallback to tenant key check
  const tenant = profile._tenant || (url ? getWorkdayTenant(url) : '');
  if (tenant) {
    const key = clientKey(profile, tenant);
    const row = doc.clients.find((c) => c.key === key);
    if (row?.prior_application_available) return true;
  }

  return false;
}

/**
 * @param {object} profile
 * @param {string} [url]
 */
export async function hasPriorApplicationForTenant(profile = {}, url = '') {
  const applywizzId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.client_id
    || process.env.APPLYWIZZ_ID
    || '',
  ).trim();
  const company = profile._company || (url ? extractWorkdayCompanyName(url) : '') || profile._tenant || (url ? getWorkdayTenant(url) : '');
  return await hasPriorApplicationForCompany(applywizzId, company, profile, url);
}

/**
 * If Workday offers "use previous application", select it (Yes / checkbox / button).
 * @param {import('playwright').Page} page
 * @param {object} profile
 */
export async function tryUsePreviousApplication(page, profile = {}) {
  const url = page.url();
  const tenant = profile._tenant || getWorkdayTenant(url);
  const prior = await hasPriorApplicationForTenant(profile, url);
  if (!prior) {
    console.log('  ℹ️  No prior application on file for this client/tenant — skip autofill prompt');
    return false;
  }

  await waitForDomSettled(page, { timeout: 1200 }).catch(() => {});

  const picked = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const body = norm(document.body?.innerText || '').slice(0, 8000);
    if (!/previous application|use my (last|previous|most recent)|copy (from )?a previous|information from your previous|reuse (your )?application|existing application data/i.test(body)) {
      return { ok: false, reason: 'no_prompt' };
    }

    const clickEl = (el) => {
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    };

    const labels = Array.from(document.querySelectorAll('label, legend, span, p, h2, h3'));
    for (const el of labels) {
      const t = norm(el.textContent);
      if (!/previous application|use my (last|previous|most recent)|copy.*previous|reuse.*application/i.test(t)) continue;
      const field = el.closest('[data-automation-id*="formField"]') || el.parentElement;
      const yesRadio = field?.querySelector('input[type="radio"][value="true"], input[type="radio"][value="Yes"]');
      if (clickEl(yesRadio)) return { ok: true, method: 'yes_radio' };
      const cb = field?.querySelector('input[type="checkbox"]');
      if (cb && !cb.checked && clickEl(cb)) return { ok: true, method: 'checkbox' };
    }

    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const btn of buttons) {
      const t = norm(btn.textContent);
      if (/^yes$/i.test(t) || /use (my )?(previous|last|most recent)|use existing|copy previous|reuse/i.test(t)) {
        if (clickEl(btn)) return { ok: true, method: 'button', text: t.slice(0, 60) };
      }
    }

    const autoId = document.querySelector(
      '[data-automation-id*="previousApplication" i], [data-automation-id*="usePrevious" i]',
    );
    if (clickEl(autoId)) return { ok: true, method: 'automation-id' };

    return { ok: false, reason: 'prompt_but_no_control' };
  });

  if (picked.ok) {
    console.log(`  ✅ "Use previous application" selected (${picked.method}${picked.text ? `: ${picked.text}` : ''})`);
    await waitForDomSettled(page, { timeout: 1500 }).catch(() => {});
    const continueBtn = await page.$('button:has-text("Continue"), button:has-text("OK"), button:has-text("Next")');
    if (continueBtn && await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click({ force: true }).catch(() => {});
      await waitForDomSettled(page, { timeout: 1000 }).catch(() => {});
    }
    return true;
  }

  if (picked.reason === 'prompt_but_no_control') {
    console.log('  ⚠️  Previous-application prompt seen but control not found — continuing manual fill');
  }
  return false;
}
