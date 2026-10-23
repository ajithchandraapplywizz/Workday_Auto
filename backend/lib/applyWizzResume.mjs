/**
 * applyWizzResume.mjs — Download + parse client resume from Apply Wizz API URL or Supabase.
 */

import { mkdir, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import https from 'node:https';
import { URL, fileURLToPath } from 'node:url';
import { loadResumeText } from './resumeParser.mjs';
import { formatHttpError, isTlsCertError } from './httpClient.mjs';

const CACHE_DIR = resolve(process.cwd(), 'data', 'client-resumes');
const DEFAULT_ASSET_BASE = 'https://www.apply-wizz.me';

/**
 * Turn Apply Wizz resume_url / resume_path into an absolute HTTPS URL.
 * @param {string} raw
 * @returns {string}
 */
export function absolutizeApplyWizzResumeUrl(raw = '') {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  const base = String(process.env.APPLYWIZZ_ASSET_BASE || DEFAULT_ASSET_BASE).replace(/\/+$/, '');
  return t.startsWith('/') ? `${base}${t}` : `${base}/${t}`;
}

/**
 * Resolve client resume URL from profile object.
 * @param {object} profile
 * @returns {string}
 */
export function resolveApplyWizzResumeUrl(profile = {}) {
  const raw = String(
    profile._resumeUrl
    || profile.resume_url
    || profile.resumeUrl
    || profile._applyWizzClientContext?.additional_information?.resume_url
    || profile._applyWizzClientContext?.additional_information?.resume_path
    || profile._applyWizzClientContext?.client?.resume_url
    || profile._applyWizzClientContext?.client?.resume_path
    || '',
  ).trim();
  return absolutizeApplyWizzResumeUrl(raw);
}

/**
 * Fallback: Query Supabase clients table directly to fetch resume_url by AWL ID.
 * @param {string} applywizzId
 * @returns {Promise<string>}
 */
export async function fetchResumeUrlFromSupabase(applywizzId) {
  if (!applywizzId) return '';
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const { loadLocalEnvOnce } = await import('./supabaseClient.mjs');
    loadLocalEnvOnce();
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const supabase = createClient(url, key, { auth: { persistSession: false } });
      const { data } = await supabase
        .from('clients')
        .select('resume_url')
        .eq('applywizz_id', String(applywizzId).trim().toUpperCase())
        .limit(1);
      if (data?.[0]?.resume_url) {
        return absolutizeApplyWizzResumeUrl(data[0].resume_url);
      }
    }
  } catch (err) {
    console.warn(`[applyWizzResume] Supabase resume_url query notice: ${err.message}`);
  }
  return '';
}

function cachePathForClient(profile = {}) {
  const id = String(profile._applyWizzId || profile.applywizz_id || profile.applywizzId || process.env.APPLYWIZZ_ID || 'client').replace(/[^\w.-]+/g, '_');
  return resolve(CACHE_DIR, `${id}.pdf`);
}

async function downloadBinary(url, destPath) {
  // Use native fetch with redirect handling
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'workday-auto-apply' },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, Buffer.from(arrayBuffer));
    return destPath;
  } catch (fetchErr) {
    // Fallback: https request
    return new Promise((resolvePromise, reject) => {
      const target = new URL(url);
      const req = https.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        family: 4,
        rejectUnauthorized: false,
        headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'workday-auto-apply' },
        timeout: 45000,
      }, (res) => {
        if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
          downloadBinary(res.headers.location, destPath).then(resolvePromise).catch(reject);
          return;
        }
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`Resume download HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          try {
            await mkdir(dirname(destPath), { recursive: true });
            await writeFile(destPath, Buffer.concat(chunks));
            resolvePromise(destPath);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * Download resume PDF from URL or Supabase; cache under data/client-resumes/.
 * @param {object} profile
 * @returns {Promise<string|null>} absolute path to PDF
 */
export async function ensureClientResumeFromApplyWizz(profile = {}) {
  let url = resolveApplyWizzResumeUrl(profile);
  const candidateId = String(profile._applyWizzId || profile.applywizz_id || profile.applywizzId || '').trim();

  // If no URL on profile, query Supabase clients table directly
  if (!url && candidateId) {
    url = await fetchResumeUrlFromSupabase(candidateId);
  }

  const cached = cachePathForClient(profile);
  const applicationKey = String(profile._jobUrl || profile._currentJobUrl || '').trim();

  if (existsSync(cached)) {
    profile._resumePath = cached;
    if (url) profile._resumeUrl = url;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    return cached;
  }

  if (!url) {
    return profile._resumePath || null;
  }

  try {
    console.log(`  📥 Downloading resume for upload...`);
    console.log(`     URL: ${url.slice(0, 120)}${url.length > 120 ? '…' : ''}`);
    await downloadBinary(url, cached);
    profile._resumePath = cached;
    profile._resumeUrl = url;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    console.log(`  ✓ Resume cached: ${basename(cached)}`);
    return cached;
  } catch (err) {
    console.log(`  ⚠️  Resume download failed: ${formatHttpError(err)}`);
    return profile._resumePath || null;
  }
}

/**
 * Clean up client resume: unlink PDF from data/client-resumes/ when application succeeds or fails.
 */
export async function cleanupClientResume(profile = {}) {
  let p = String(profile._resumePath || '').trim();
  if (!p) {
    const id = String(profile._applyWizzId || profile.applywizz_id || profile.applywizzId || profile.client_id || '').replace(/[^\w.-]+/g, '_');
    if (id && id !== 'client') {
      p = resolve(CACHE_DIR, `${id}.pdf`);
    }
  }
  if (!p) return false;
  try {
    const { unlinkSync } = await import('fs');
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`  🗑️  Cleaned up local cached resume: ${basename(p)}`);
      profile._resumePath = null;
      return true;
    }
  } catch (err) {
    console.log(`  ⚠️ Resume file cleanup notice: ${err.message}`);
  }
  return false;
}

/**
 * Parse cached/downloaded resume text onto profile._resumeText.
 * @param {object} profile
 */
export async function parseClientResumeText(profile = {}) {
  const path = profile._resumePath || await ensureClientResumeFromApplyWizz(profile);
  if (!path) return null;
  const text = await loadResumeText(path);
  if (text) {
    profile._resumeText = text;
  }
  return text;
}
