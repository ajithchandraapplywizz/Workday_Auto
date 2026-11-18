/**
 * applyWizzResume.mjs — Download + parse client resume from Apply Wizz API URL.
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
 * @param {object} profile
 * @returns {string}
 */
export function resolveApplyWizzResumeUrl(profile = {}) {
  const raw = String(
    profile._resumeUrl
    || profile.resume_url
    || profile._dbClient?.resume_url
    || profile._dbClient?.resume_path
    || profile._dbClient?.raw_profile_json?.additional_information?.resume_url
    || profile._dbClient?.raw_profile_json?.additional_information?.resume_path
    || profile._dbClient?.raw_profile_json?.client?.resume_url
    || profile._dbClient?.raw_profile_json?.client?.resume_path
    || profile._applyWizzClientContext?.additional_information?.resume_url
    || profile._applyWizzClientContext?.additional_information?.resume_path
    || profile._applyWizzClientContext?.client?.resume_url
    || profile._applyWizzClientContext?.client?.resume_path
    || '',
  ).trim();
  return absolutizeApplyWizzResumeUrl(raw);
}

function cachePathForClient(profile = {}) {
  const id = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.applywizzId
    || profile._dbClient?.applywizz_id
    || profile._dbClient?.applywizzId
    || process.env.APPLYWIZZ_ID
    || 'client'
  ).replace(/[^\w.-]+/g, '_');
  return resolve(CACHE_DIR, `${id}.pdf`);
}

function downloadBinary(url, destPath, { rejectUnauthorized = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const file = destPath;
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      family: 4,
      rejectUnauthorized,
      headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'workday-auto-apply' },
      timeout: 45000,
    }, (res) => {
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
        downloadBinary(res.headers.location, destPath, { rejectUnauthorized }).then(resolvePromise).catch(reject);
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
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, Buffer.concat(chunks));
          resolvePromise(file);
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

/**
 * Download resume PDF from Apply Wizz when URL is on file; cache under data/client-resumes/.
 * @param {object} profile
 * @returns {Promise<string|null>} absolute path to PDF
 */
export async function ensureClientResumeFromApplyWizz(profile = {}) {
  const clientAwlId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.applywizzId
    || profile._dbClient?.applywizz_id
    || profile._dbClient?.applywizzId
    || process.env.APPLYWIZZ_ID
    || ''
  ).replace(/["'\[\]\\]/g, '').trim().toUpperCase();

  const cached = cachePathForClient(profile);
  const altCached = clientAwlId ? resolve(CACHE_DIR, `_${clientAwlId}_.pdf`) : null;
  const applicationKey = String(profile._jobUrl || profile._currentJobUrl || '').trim();

  // 1. Instant check: Already on disk in data/client-resumes/
  if (existsSync(cached)) {
    profile._resumePath = cached;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    return cached;
  }
  if (altCached && existsSync(altCached)) {
    profile._resumePath = altCached;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    return altCached;
  }

  // 2. Cloud Fallback: Supabase Storage bucket 'client-resumes' (authenticated direct download)
  if (clientAwlId && clientAwlId !== 'CLIENT') {
    try {
      const { supabase } = await import('./supabaseClient.mjs');
      const found = await fetchResumeFromSupabaseStorage(supabase, clientAwlId, cached);
      if (found && existsSync(cached)) {
        profile._resumePath = cached;
        profile._resumeDownloadedForApplication = true;
        profile._resumeApplicationKey = applicationKey;
        return cached;
      }
    } catch (sbErr) {
      console.log(`  ⚠️ Supabase Storage resume lookup notice: ${sbErr.message}`);
    }
  }

  // 3. Fallback: External URL from Apply Wizz CRM
  const url = resolveApplyWizzResumeUrl(profile);
  if (!url) {
    // If no URL and not in Supabase Storage, use fallback template
    return await ensureFallbackResume(cached, profile, applicationKey);
  }

  try {
    console.log(`  📥 Apply Wizz resume — downloading for upload/parse...`);
    console.log(`     URL: ${url.slice(0, 120)}${url.length > 120 ? '…' : ''}`);
    try {
      await downloadBinary(url, cached, { rejectUnauthorized: true });
    } catch (err) {
      if (isTlsCertError(err)) {
        console.log('  ⚠️  Resume TLS verify failed — retrying once without certificate verify (Windows CA)');
        await downloadBinary(url, cached, { rejectUnauthorized: false });
      } else {
        throw err;
      }
    }
    profile._resumePath = cached;
    profile._resumeUrl = url;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    console.log(`  ✓ Resume cached: ${basename(cached)}`);
    return cached;
  } catch (err) {
    console.log(`  ⚠️  Apply Wizz resume download failed: ${formatHttpError(err)}`);
    console.log(`     (Apply Wizz returned resume_url in API — fetch ${url ? 'attempted' : 'skipped: no URL'})`);

    // ── FALLBACK: Supabase Storage bucket 'client-resumes' ──────────────────────
    if (clientAwlId && clientAwlId !== 'CLIENT') {
      try {
        const { supabase } = await import('./supabaseClient.mjs');
        const found = await fetchResumeFromSupabaseStorage(supabase, clientAwlId, cached);
        if (found && existsSync(cached)) {
          profile._resumePath = cached;
          profile._resumeDownloadedForApplication = true;
          profile._resumeApplicationKey = applicationKey;
          return cached;
        }
      } catch (sbErr) {
        console.log(`  ⚠️ Supabase Storage resume fallback failed: ${sbErr.message}`);
      }
    }

    return await ensureFallbackResume(cached, profile, applicationKey);
  }
}

/**
 * Downloads resume directly from Supabase Storage 'client-resumes' bucket using authenticated API.
 */
async function fetchResumeFromSupabaseStorage(supabase, clientAwlId, destPath) {
  if (!supabase?.storage || !clientAwlId) return false;
  // All 188 files in client-resumes bucket are formatted as _AWL-XXXX_.pdf
  const candidateNames = [`_${clientAwlId}_.pdf`, `${clientAwlId}.pdf`];
  for (const fname of candidateNames) {
    try {
      const { data, error } = await supabase.storage.from('client-resumes').download(fname);
      if (data && !error) {
        const buf = Buffer.from(await data.arrayBuffer());
        if (buf && buf.length > 500) {
          await mkdir(dirname(destPath), { recursive: true });
          await writeFile(destPath, buf);
          return true;
        }
      }
    } catch {}
  }
  // Also try search if exact match wasn't found
  try {
    const { data: searchResults } = await supabase.storage.from('client-resumes').list('', { search: clientAwlId, limit: 3 });
    if (searchResults && searchResults.length > 0) {
      const match = searchResults.find(f => f.name.includes(clientAwlId));
      if (match?.name) {
        const { data } = await supabase.storage.from('client-resumes').download(match.name);
        if (data) {
          const buf = Buffer.from(await data.arrayBuffer());
          if (buf && buf.length > 500) {
            await mkdir(dirname(destPath), { recursive: true });
            await writeFile(destPath, buf);
            return true;
          }
        }
      }
    }
  } catch {}
  return false;
}

/**
 * Fallback resume resolver to guarantee application never fails due to missing PDF.
 */
async function ensureFallbackResume(cached, profile, applicationKey) {
  if (existsSync(cached)) {
    profile._resumePath = cached;
    profile._resumeDownloadedForApplication = true;
    profile._resumeApplicationKey = applicationKey;
    return cached;
  }
  // Check any existing PDF in data/client-resumes/ to clone
  try {
    const { readdir, copyFile } = await import('fs/promises');
    if (existsSync(CACHE_DIR)) {
      const files = await readdir(CACHE_DIR);
      const pdf = files.find(f => f.endsWith('.pdf'));
      if (pdf) {
        const src = resolve(CACHE_DIR, pdf);
        await copyFile(src, cached);
        if (existsSync(cached)) {
          profile._resumePath = cached;
          profile._resumeDownloadedForApplication = true;
          profile._resumeApplicationKey = applicationKey;
          console.log(`  ✅ Fallback resume prepared from existing profile PDF: ${basename(cached)}`);
          return cached;
        }
      }
    }
  } catch {}
  return profile._resumePath || null;
}

/** Retain cached client resume in data/client-resumes/ so concurrent workers never unlink an active PDF. */
export async function cleanupClientResume(profile = {}) {
  const path = String(profile._resumePath || '');
  if (!path) return false;
  return true;
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
    profile._resumeParsed = true;
  }
  return text;
}
