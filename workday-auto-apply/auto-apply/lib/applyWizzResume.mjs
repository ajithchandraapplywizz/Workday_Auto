/**
 * applyWizzResume.mjs — Download + parse client resume from Apply Wizz API URL.
 */

import { mkdir, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import https from 'node:https';
import { URL } from 'node:url';
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
    || profile._applyWizzClientContext?.additional_information?.resume_url
    || profile._applyWizzClientContext?.additional_information?.resume_path
    || profile._applyWizzClientContext?.client?.resume_url
    || profile._applyWizzClientContext?.client?.resume_path
    || '',
  ).trim();
  return absolutizeApplyWizzResumeUrl(raw);
}

function cachePathForClient(profile = {}) {
  const id = String(profile._applyWizzId || process.env.APPLYWIZZ_ID || 'client').replace(/[^\w.-]+/g, '_');
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
  const url = resolveApplyWizzResumeUrl(profile);
  if (!url) return profile._resumePath || null;

  const cached = cachePathForClient(profile);
  const applicationKey = String(profile._jobUrl || profile._currentJobUrl || '').trim();
  if (profile._resumeDownloadedForApplication
    && profile._resumeApplicationKey === applicationKey
    && existsSync(cached)) {
    profile._resumePath = cached;
    profile._resumeUrl = url;
    return cached;
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
    return profile._resumePath || null;
  }
}

/** Delete only the temporary Apply Wizz copy after a confirmed submission. */
export async function cleanupClientResume(profile = {}) {
  const path = String(profile._resumePath || '');
  const cached = cachePathForClient(profile);
  if (!path || resolve(path) !== cached) return false;
  try {
    await unlink(path);
    profile._resumePath = '';
    profile._resumeDownloadedForApplication = false;
    console.log(`  🧹 Temporary resume removed after submission: ${basename(path)}`);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    console.log(`  ⚠️  Temporary resume cleanup failed: ${err.message?.slice(0, 100) || err}`);
    return false;
  }
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
    console.log(`  ✓ Resume parsed (${text.length} chars) from Apply Wizz file`);
  }
  return text;
}
