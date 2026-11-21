/**
 * backfill_client_contact_details.mjs
 *
 * Extracts authentic mobile numbers, first names, and last names from candidate
 * resume PDFs and updates the Supabase `clients` table.
 * Permanently eliminates dummy/fallback phone numbers (e.g. '5102662606', '+', or empty).
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { request } from '../lib/supabaseClient.mjs';
import { loadResumeText, inferAnswerFromResume } from '../lib/resumeParser.mjs';
import { extractContactFromResumeText, digitsOnly } from '../lib/clientContact.mjs';
import { splitGivenFamilyName } from '../lib/personName.mjs';

function isInvalidPhone(val, awlId = '') {
  if (!val) return true;
  const s = String(val).trim();
  if (s === '+' || s === 'null' || s === 'undefined') return true;
  const d = digitsOnly(s);
  if (d.length < 7) return true;
  // AWL-36165 is the only client whose actual authentic resume has 5102662606
  if (d === '5102662606' && !String(awlId).toUpperCase().includes('36165')) return true;
  return false;
}

function normalizeResumeUrl(url = '') {
  let s = String(url || '').trim();
  if (!s) return '';
  // Normalize old ApplyWizz S3 bucket to v2 bucket
  if (s.includes('applywizz-prod.s3.')) {
    s = s.replace('applywizz-prod.s3.', 'applywizz-prod-v2.s3.');
  }
  return s;
}

function findLocalResumeCandidate(awlId) {
  const cleanId = String(awlId || '').replace(/["'\[\]\\]/g, '').trim().toUpperCase();
  if (!cleanId) return null;
  const candidates = [
    resolve(process.cwd(), 'data', 'client-resumes', `${cleanId}.pdf`),
    resolve(process.cwd(), 'data', 'client-resumes', `_${cleanId}_.pdf`),
    resolve(process.cwd(), 'resumes', `${cleanId}.pdf`),
    resolve(process.cwd(), 'resumes', `_${cleanId}_.pdf`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function runContactBackfill({ dryRun = false } = {}) {
  console.log('🚀 Starting Client Contact Details Backfill (Resume Parsing -> Supabase)...');
  console.log(`   Mode: ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE (updating clients table)'}\n`);

  // Fetch all clients from Supabase
  const clients = await request('clients', {
    query: '?select=applywizz_id,client_name,first_name,last_name,mobile_number,resume_url,raw_profile_json',
  });

  if (!Array.isArray(clients) || clients.length === 0) {
    console.error('❌ Failed to load clients from Supabase.');
    return;
  }

  console.log(`📋 Total clients fetched: ${clients.length}`);

  const candidatesToFix = clients.filter((c) => {
    const badPhone = isInvalidPhone(c.mobile_number, c.applywizz_id);
    const missingFirst = !c.first_name || !String(c.first_name).trim();
    const missingLast = !c.last_name || !String(c.last_name).trim();
    const oldS3Url = c.resume_url && c.resume_url.includes('applywizz-prod.s3.');
    return badPhone || missingFirst || missingLast || oldS3Url;
  });

  console.log(`🎯 Candidates needing updates / S3 URL upgrades: ${candidatesToFix.length}\n`);

  let updatedCount = 0;
  let skippedCount = 0;
  const errors = [];

  for (let i = 0; i < candidatesToFix.length; i++) {
    const client = candidatesToFix[i];
    const awlId = client.applywizz_id;
    const cleanAwl = String(awlId || '').replace(/["'\[\]\\]/g, '').trim().toUpperCase();

    // 1. Determine resume source (URL or local cached file)
    let rawResumeSource = client.resume_url
      || client.raw_profile_json?.additional_information?.resume_url
      || client.raw_profile_json?.additional_information?.resume_path
      || client.raw_profile_json?.client?.resume_url
      || client.raw_profile_json?.client?.resume_path
      || null;

    let resumeSource = normalizeResumeUrl(rawResumeSource);

    if (!resumeSource || resumeSource.includes('AWL-150.pdf')) {
      const local = findLocalResumeCandidate(cleanAwl);
      if (local) resumeSource = local;
    }

    if (!resumeSource) {
      console.warn(`  [${i + 1}/${candidatesToFix.length}] ⚠️  ${cleanAwl} (${client.client_name || 'Unknown'}): No resume URL or local file found.`);
      skippedCount++;
      continue;
    }

    // 2. Load & parse resume text
    let resumeText = '';
    try {
      resumeText = await loadResumeText(resumeSource);
    } catch (e) {
      const local = findLocalResumeCandidate(cleanAwl);
      if (local && local !== resumeSource) {
        try {
          resumeText = await loadResumeText(local);
        } catch {}
      }
    }

    if (!resumeText || !resumeText.trim()) {
      const local = findLocalResumeCandidate(cleanAwl);
      if (local && local !== resumeSource) {
        try {
          resumeText = await loadResumeText(local);
        } catch {}
      }
    }

    if (!resumeText || !resumeText.trim()) {
      try {
        const { fetchApplyWizzClient } = await import('../lib/applyWizzClient.mjs');
        const crmData = await fetchApplyWizzClient(cleanAwl);
        const freshUrl = crmData?.additional_information?.resume_url
          || crmData?.additional_information?.resume_path
          || crmData?.client?.resume_url
          || crmData?.client?.resume_path;
        if (freshUrl && freshUrl !== resumeSource) {
          resumeSource = normalizeResumeUrl(freshUrl);
          resumeText = await loadResumeText(resumeSource);
        }
      } catch {}
    }

    // 3. Extract contact & identity details
    let extractedPhone = '';
    let extractedFirst = client.first_name || '';
    let extractedLast = client.last_name || '';

    if (resumeText) {
      const contact = extractContactFromResumeText(resumeText);
      if (contact?.phone && !isInvalidPhone(contact.phone, cleanAwl)) {
        extractedPhone = digitsOnly(contact.phone).slice(-10);
      }

      if (!extractedPhone) {
        const fromInfer = inferAnswerFromResume('phone number', resumeText, {});
        if (fromInfer && !isInvalidPhone(fromInfer, cleanAwl)) {
          extractedPhone = digitsOnly(fromInfer).slice(-10);
        }
      }

      // Check header regex if still no phone
      if (!extractedPhone) {
        const header = resumeText.slice(0, 1500);
        const match = header.match(/(?:\+1[\s.-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}\b/);
        if (match && match[0]) {
          const d = digitsOnly(match[0]);
          if (d.length >= 10 && (d !== '5102662606' || cleanAwl.includes('36165'))) {
            extractedPhone = d.slice(-10);
          }
        }
      }

      // Check international phone pattern if not US
      if (!extractedPhone) {
        const header = resumeText.slice(0, 1500);
        const intlMatch = header.match(/\+(\d{1,4})[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/);
        if (intlMatch && intlMatch[0]) {
          const d = digitsOnly(intlMatch[0]);
          if (d.length >= 7 && (d !== '5102662606' || cleanAwl.includes('36165'))) {
            extractedPhone = d.slice(-10);
          }
        }
      }

      // Fill missing first or last name from client_name or resume
      if (!extractedFirst || !extractedLast) {
        const nameToSplit = client.client_name || resumeText.trim().split('\n').find((l) => l.trim())?.trim() || '';
        const split = splitGivenFamilyName(nameToSplit);
        if (!extractedFirst && split.first_name) extractedFirst = split.first_name;
        if (!extractedLast && split.last_name) extractedLast = split.last_name;
      }
    } else {
      if (!extractedFirst || !extractedLast) {
        const split = splitGivenFamilyName(client.client_name || '');
        if (!extractedFirst && split.first_name) extractedFirst = split.first_name;
        if (!extractedLast && split.last_name) extractedLast = split.last_name;
      }
    }

    // Prepare updates
    const updates = {};
    if (extractedPhone && isInvalidPhone(client.mobile_number, cleanAwl)) {
      updates.mobile_number = extractedPhone;
    }
    if (extractedFirst && (!client.first_name || !String(client.first_name).trim())) {
      updates.first_name = extractedFirst;
    }
    if (extractedLast && (!client.last_name || !String(client.last_name).trim())) {
      updates.last_name = extractedLast;
    }
    // Upgrade legacy S3 URL to v2 URL
    if (resumeSource && /^https?:\/\//i.test(resumeSource) && client.resume_url !== resumeSource) {
      updates.resume_url = resumeSource;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  [${i + 1}/${candidatesToFix.length}] ⏭️  ${cleanAwl}: No extractable updates found from resume.`);
      skippedCount++;
      continue;
    }

    console.log(`  [${i + 1}/${candidatesToFix.length}] ✅ ${cleanAwl} (${client.client_name || 'Candidate'}):`);
    if (updates.mobile_number) console.log(`      📞 Mobile Phone: ${client.mobile_number || '(empty)'} -> ${updates.mobile_number}`);
    if (updates.first_name) console.log(`      👤 First Name:   ${client.first_name || '(empty)'} -> ${updates.first_name}`);
    if (updates.last_name) console.log(`      👤 Last Name:    ${client.last_name || '(empty)'} -> ${updates.last_name}`);
    if (updates.resume_url) console.log(`      📎 Resume URL:   Updated to ApplyWizz v2 S3`);

    if (!dryRun) {
      try {
        await request('clients', {
          method: 'PATCH',
          query: `?applywizz_id=eq.${encodeURIComponent(awlId)}`,
          body: {
            ...updates,
            updated_at: new Date().toISOString(),
          },
        });
        updatedCount++;
      } catch (err) {
        console.error(`      ❌ Update failed for ${cleanAwl}: ${err.message}`);
        errors.push({ awlId: cleanAwl, error: err.message });
      }
    } else {
      updatedCount++;
    }
  }

  console.log('\n==================================================');
  console.log('🎉 Backfill Completed Summary:');
  console.log(`   • Total Candidates Evaluated: ${candidatesToFix.length}`);
  console.log(`   • Successfully Updated:      ${updatedCount}`);
  console.log(`   • Skipped (No extractable):  ${skippedCount}`);
  console.log(`   • Errors Encountered:        ${errors.length}`);
  console.log('==================================================\n');
}

// Self-run when executed directly
if (process.argv[1]?.endsWith('backfill_client_contact_details.mjs')) {
  const isDryRun = process.argv.includes('--dry-run');
  runContactBackfill({ dryRun: isDryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal backfill error:', err);
      process.exit(1);
    });
}
