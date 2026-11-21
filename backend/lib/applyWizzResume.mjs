/**
 * applyWizzResume.mjs — Download + parse client resume from Apply Wizz API URL.
 */

import { mkdir, writeFile, unlink } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import https from 'node:https';
import { URL, fileURLToPath } from 'node:url';
import { loadResumeText } from './resumeParser.mjs';
import { formatHttpError, isTlsCertError } from './httpClient.mjs';

const CACHE_DIR = resolve(process.cwd(), 'data', 'client-resumes');
const DEFAULT_ASSET_BASE = 'https://applywizz-prod-v2.s3.us-east-2.amazonaws.com';

/**
 * Turn Apply Wizz resume_url / resume_path into an absolute HTTPS URL.
 * Automatically resolves and migrates legacy/relative CRM paths to the
 * authentic production AWS S3 CRM bucket:
 * https://applywizz-prod-v2.s3.us-east-2.amazonaws.com/CRM/{AWL_ID}...
 * @param {string} raw
 * @returns {string}
 */
export function absolutizeApplyWizzResumeUrl(raw = '') {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/apply-wizz\.me\/CRM\//i.test(t)) {
    return t.replace(/https?:\/\/(?:www\.)?apply-wizz\.me\/CRM\//i, 'https://applywizz-prod-v2.s3.us-east-2.amazonaws.com/CRM/');
  }
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  if (/^(\/)?CRM\//i.test(t)) {
    return `https://applywizz-prod-v2.s3.us-east-2.amazonaws.com/${t.replace(/^\/+/, '')}`;
  }
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
      autoSelectFamily: true,
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

  // 1. Instant check: Already on disk in data/client-resumes/ (must be authentic resume, > 2KB)
  if (existsSync(cached)) {
    try {
      if (statSync(cached).size > 2048) {
        // Verify authenticity against candidate's name to avoid stale cross-contamination
        const candLastName = String(profile.personal?.last_name || profile.lastName || profile.client_name?.split(' ').pop() || '').trim().toLowerCase();
        let valid = true;
        if (candLastName && candLastName.length > 2) {
          try {
            const { loadResumeText } = await import('./resumeParser.mjs');
            const txt = (await loadResumeText(cached)) || '';
            if (txt && !txt.toLowerCase().includes(candLastName)) {
              console.warn(`  ⚠️ Cached resume at ${basename(cached)} did NOT contain candidate name "${candLastName}" — purging corrupted cache.`);
              const { unlink } = await import('fs/promises');
              await unlink(cached).catch(() => {});
              valid = false;
            }
          } catch {}
        }
        if (valid && existsSync(cached)) {
          profile._resumePath = cached;
          profile._resumeDownloadedForApplication = true;
          profile._resumeApplicationKey = applicationKey;
          return cached;
        }
      }
    } catch {}
  }
  if (altCached && existsSync(altCached)) {
    try {
      if (statSync(altCached).size > 2048) {
        profile._resumePath = altCached;
        profile._resumeDownloadedForApplication = true;
        profile._resumeApplicationKey = applicationKey;
        return altCached;
      }
    } catch {}
  }

  // 2. Cloud Check & Authentic AWS S3 CRM Fallback with Auto-Cache to Supabase Storage
  if (clientAwlId && clientAwlId !== 'CLIENT') {
    try {
      const { supabase } = await import('./supabaseClient.mjs');
      if (supabase?.storage) {
        const { data: publicData } = supabase.storage.from('client-resumes').getPublicUrl(`${clientAwlId}.pdf`);
        const sbUrl = publicData?.publicUrl;
        if (sbUrl) {
          try {
            await downloadBinary(sbUrl, cached, { rejectUnauthorized: true });
            if (existsSync(cached) && statSync(cached).size > 2048) {
              profile._resumePath = cached;
              profile._resumeUrl = sbUrl;
              profile._resumeDownloadedForApplication = true;
              profile._resumeApplicationKey = applicationKey;
              console.log(`  ✅ Resume cached from Supabase Storage: ${basename(cached)}`);
              return cached;
            }
          } catch (dlErr) {
            // File not in Supabase Storage yet — immediately query clients table for authentic AWS S3 URL
          }
        }

        // Direct S3 Fallback: Query clients table for authentic AWS S3 URL from ApplyWizz CRM
        try {
          const { data: clientRow } = await supabase
            .from('clients')
            .select('resume_url, raw_profile_json')
            .eq('applywizz_id', clientAwlId)
            .maybeSingle();

          const rawS3 = clientRow?.raw_profile_json?.additional_information?.resume_url
            || clientRow?.raw_profile_json?.additional_information?.resume_path
            || clientRow?.raw_profile_json?.client?.resume_url
            || clientRow?.raw_profile_json?.client?.resume_path
            || clientRow?.resume_url;
          let s3ResumeUrl = absolutizeApplyWizzResumeUrl(rawS3);

          if (s3ResumeUrl) {
            console.log(`  📥 [AWS S3 CRM Fallback] Fetching authentic resume from ApplyWizz S3: ${clientAwlId}...`);
            await downloadBinary(s3ResumeUrl, cached, { rejectUnauthorized: true });
            if (existsSync(cached) && statSync(cached).size > 2048) {
              profile._resumePath = cached;
              profile._resumeUrl = s3ResumeUrl;
              profile._resumeDownloadedForApplication = true;
              profile._resumeApplicationKey = applicationKey;
              console.log(`  ✅ Resume cached from AWS S3: ${basename(cached)}`);

              // Auto-cache back to Supabase Storage bucket 'client-resumes'
              try {
                const { readFile } = await import('fs/promises');
                const buf = await readFile(cached);
                const { error: upErr } = await supabase.storage.from('client-resumes').upload(`${clientAwlId}.pdf`, buf, {
                  contentType: 'application/pdf',
                  upsert: true,
                });
                if (!upErr) {
                  const { data: pubData } = supabase.storage.from('client-resumes').getPublicUrl(`${clientAwlId}.pdf`);
                  if (pubData?.publicUrl) {
                    await supabase.from('clients').update({ resume_url: pubData.publicUrl }).eq('applywizz_id', clientAwlId);
                    profile._resumeUrl = pubData.publicUrl;
                    console.log(`  ☁️ Auto-synced authentic resume to Supabase Storage: client-resumes/${clientAwlId}.pdf`);
                  }
                }
              } catch (upSyncErr) {
                console.warn(`  ⚠️ Note on auto-syncing resume to Supabase: ${upSyncErr.message}`);
              }

              return cached;
            }
          }
        } catch (s3FetchErr) {
          console.warn(`  ⚠️ S3 CRM resume fallback lookup error: ${s3FetchErr.message}`);
        }
      }
    } catch (sbErr) {
      console.log(`  ⚠️ Supabase Storage resume lookup notice: ${sbErr.message}`);
    }
  }

  // 3. Fallback: External URL from Apply Wizz CRM
  const url = resolveApplyWizzResumeUrl(profile);
  if (!url) return profile._resumePath || null;

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
    const clientAwlId = String(
      profile._applyWizzId
      || profile.applywizz_id
      || profile.applywizzId
      || profile._dbClient?.applywizz_id
      || profile._dbClient?.applywizzId
      || process.env.APPLYWIZZ_ID
      || ''
    ).replace(/["'\[\]\\]/g, '').trim().toUpperCase();

    if (clientAwlId && clientAwlId !== 'CLIENT') {
      try {
        const { supabase } = await import('./supabaseClient.mjs');
        if (supabase?.storage) {
          const { data: publicData } = supabase.storage.from('client-resumes').getPublicUrl(`${clientAwlId}.pdf`);
          const sbUrl = publicData?.publicUrl;
          if (sbUrl) {
            console.log(`  📥 [Cloud Fallback] Fetching authentic resume from Supabase Storage: ${clientAwlId}.pdf...`);
            await downloadBinary(sbUrl, cached, { rejectUnauthorized: true });
            if (existsSync(cached)) {
              profile._resumePath = cached;
              profile._resumeUrl = sbUrl;
              profile._resumeDownloadedForApplication = true;
              profile._resumeApplicationKey = applicationKey;
              console.log(`  ✅ Resume cached from Supabase Storage: ${basename(cached)}`);
              return cached;
            }
          }
        }
      } catch (sbErr) {
        console.log(`  ⚠️ Supabase Storage resume fallback failed: ${sbErr.message}`);
      }
    }

    return profile._resumePath || null;
  }
}

/** Clean up cached client resume in data/client-resumes/ after submission if requested. */
export async function cleanupClientResume(profile = {}, { force = false } = {}) {
  const path = String(profile._resumePath || '');
  if (!path) return false;
  try {
    if (force && existsSync(path) && path.includes('client-resumes')) {
      const { unlink } = await import('fs/promises');
      await unlink(path);
      console.log(`  🧹 Cleaned up cached candidate resume: ${basename(path)}`);
      profile._resumePath = null;
      return true;
    }
  } catch (err) {
    console.warn(`  ⚠️ Could not clean up resume ${path}: ${err.message}`);
  }
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
    console.log(`  ✓ Resume parsed (${text.length} chars) from Apply Wizz file`);
  }
  return text;
}
