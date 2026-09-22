import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { httpsJsonWithRetry } from './lib/httpClient.mjs';
import { loadSupabaseClientSnapshot, upsertSupabaseClient, loadLocalEnvOnce } from './lib/supabaseClient.mjs';
import { loadResumeText, DEFAULT_RESUME_PATH } from './lib/resumeParser.mjs';
import { ensureClientResumeFromApplyWizz } from './lib/applyWizzResume.mjs';
import { fetchApplyWizzClient, resolveCompanyEmail } from './lib/applyWizzClient.mjs';

function extractPhoneFromText(text) {
  if (!text) return null;
  const match = text.match(/\+?\d[\d\s().-]{8,}\d/);
  if (!match) return null;
  let d = match[0].replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : null;
}

function normalizeDegree(degree) {
  if (!degree) return '';
  const d = degree.toLowerCase();
  if (/master|ms\b|m\.?tech/i.test(d)) return 'Master / MS';
  if (/bachelor|bs\b|b\.?tech/i.test(d)) return 'Bachelor / BS';
  return degree;
}

function normalizeFieldOfStudy(field) {
  if (!field) return '';
  // Remove dates like "Feb 2025", "May 2025" from field of study
  let cleaned = field.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4}\b/gi, '');
  cleaned = cleaned.replace(/\b(?:19|20)\d{2}\b/g, ''); // replace standalone years
  cleaned = cleaned.replace(/[-–—]/g, '').trim();
  return cleaned;
}

async function repairClient(id) {
  console.log(`\n--- Repairing ID: ${id} ---`);
  const snapshot = await loadSupabaseClientSnapshot(id);
  if (!snapshot || !snapshot.client) {
    console.log(`⚠️ Client ${id} not found in Supabase. Skipping.`);
    return;
  }
  
  const client = snapshot.client;
  let mobileNumber = client.mobile_number || '';
  let degree = normalizeDegree(client.degree || client.education || '');
  let fieldOfStudy = normalizeFieldOfStudy(client.field_of_study || '');
  let updated = false;

  // 1. Phone number extraction
  if (!mobileNumber || mobileNumber.trim() === '') {
    console.log(`  Phone number missing. Attempting to extract from resume...`);
    // Try to get resume text
    try {
      process.env.APPLYWIZZ_ID = id;
      const apiData = await fetchApplyWizzClient(id);
      if (apiData) {
        const dummyProfile = {
          _applyWizzId: id,
          _resumeUrl: apiData.client?.resume_url || apiData.additional_information?.resume_url || '',
        };
        const resumePath = await ensureClientResumeFromApplyWizz(dummyProfile);
        if (resumePath) {
          const text = await loadResumeText(resumePath);
          const phone = extractPhoneFromText(text);
          if (phone) {
            mobileNumber = phone;
            updated = true;
            console.log(`  ✓ Extracted phone number: ${mobileNumber}`);
          } else {
            console.log(`  ⚠️ No phone number found in resume text.`);
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠️ Failed to fetch/parse resume for ${id}: ${e.message}`);
    }
  }

  // 2. Degree and Field of Study normalization
  if (client.degree !== degree || client.field_of_study !== fieldOfStudy) {
    console.log(`  ✓ Normalized Education:`);
    if (client.degree !== degree) console.log(`      Degree: "${client.degree}" -> "${degree}"`);
    if (client.field_of_study !== fieldOfStudy) console.log(`      Major: "${client.field_of_study}" -> "${fieldOfStudy}"`);
    updated = true;
  }

  // 3. Company email normalization
  let companyEmail = resolveCompanyEmail(client, client.client_name);
  if (companyEmail && client.company_email !== companyEmail) {
    console.log(`  ✓ Normalized Company Email: "${client.company_email}" -> "${companyEmail}"`);
    updated = true;
  }

  // 4. Update Supabase
  if (updated) {
    try {
      await upsertSupabaseClient({
        applywizzId: id,
        clientName: client.client_name,
        firstName: client.first_name,
        lastName: client.last_name,
        mobileNumber: mobileNumber,
        companyEmail: companyEmail || client.company_email,
        resumeUrl: client.resume_url,
        education: client.education, // keep original or update if needed
        universityOrSchool: client.university_or_school,
        degree: degree,
        fieldOfStudy: fieldOfStudy,
        graduationYear: client.graduation_year,
        gpa: client.gpa,
        skills: client.skills,
        latestCompany: client.latest_company,
        latestJobTitle: client.latest_job_title,
        latestJobLocation: client.latest_job_location,
        currentlyWorking: client.currently_working,
        workFrom: client.work_from,
        workTo: client.work_to
      });
      console.log(`  ✅ Successfully updated ${id} in Supabase.`);
    } catch (e) {
      console.log(`  ❌ Failed to update ${id} in Supabase: ${e.message}`);
    }
  } else {
    console.log(`  No updates required for ${id}.`);
  }
}

async function main() {
  loadLocalEnvOnce();
  const txtPath = resolve('./sync_ids.txt');
  if (!existsSync(txtPath)) {
    console.log('No sync_ids.txt found!');
    return;
  }
  
  const ids = readFileSync(txtPath, 'utf8')
    .split('\n')
    .map(i => i.trim())
    .filter(Boolean);
    
  const uniqueIds = [...new Set(ids)];
  console.log(`Starting repair for ${uniqueIds.length} clients...`);
  
  for (const id of uniqueIds) {
    try {
      await repairClient(id);
    } catch (e) {
      console.log(`\n❌ Unexpected error repairing ${id}: ${e.message}\nSkipping to next ID...`);
    }
  }
  console.log('\n✅ All repairs completed!');
}

main().catch(console.error);
