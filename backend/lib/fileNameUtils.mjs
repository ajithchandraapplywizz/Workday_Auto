/**
 * fileNameUtils.mjs
 * Utilities for generating dynamic, professional resume/cover letter filenames.
 *
 * Format: Resume_FirstName_LastName_JobRole.pdf
 * Falls back gracefully if any component is missing.
 */

import { basename } from 'path';

/**
 * Extracts the job title/role from the current page's document.title.
 * Uses the same parsing strategy as AnalyticsTracker.
 *
 * Examples of handled title formats:
 *   "Software Engineer at Google | Greenhouse"  → "Software Engineer"
 *   "Senior Product Manager - Stripe - LinkedIn" → "Senior Product Manager"
 *   "Apply | Software Engineer | Workday"        → "Software Engineer"
 */
export function extractJobRoleFromPage(customTitle = '') {
  try {
    let title = customTitle || (typeof document !== 'undefined' ? document.title : '') || '';

    // Remove common ATS suffixes like "| Greenhouse", "| Workday", "| Lever", etc.
    title = title.replace(/\|\s*(Greenhouse|Workday|Lever|Ashby|iCIMS|SmartRecruiters|BambooHR|Taleo|SuccessFactors)\s*$/i, '').trim();

    // Format: "Job Title at Company"
    if (title.includes(' at ')) {
      return cleanJobRole(title.split(' at ')[0].trim());
    }

    // Format: "Job Title - Company - Platform" or "Job Title - Company"
    if (title.includes(' - ')) {
      const parts = title.split(' - ');
      return cleanJobRole(parts[0].trim());
    }

    // Format: "Platform | Job Title | Company" or just "Job Title | Company"
    if (title.includes(' | ')) {
      const parts = title.split(' | ').map((p) => p.trim()).filter(Boolean);
      // Find the part that looks most like a job title (longer, not a single word like "Apply")
      const candidate = parts.find((p) => p.split(' ').length >= 2) || '';
      return cleanJobRole(candidate);
    }

    // Return empty string if no clear delimiter/job role structure is found
    return '';
  } catch {
    return '';
  }
}

/**
 * Strips common ATS boilerplate prefixes from an extracted candidate string
 * so only the actual job role remains.
 *
 * Examples:
 *   "Job Application for Retirement"  → "Retirement"
 *   "Apply for Software Engineer"     → "Software Engineer"
 *   "Application for Data Analyst"    → "Data Analyst"
 *   "Software Engineer"               → "Software Engineer"  (unchanged)
 */
export function cleanJobRole(raw = '') {
  return String(raw || '')
    .replace(/^(job\s+application\s+for|application\s+for|apply\s+for|apply\s+to|applying\s+for)\s+/i, '')
    .trim();
}

/**
 * Sanitizes a string for use in a file name:
 * - Removes characters that are invalid in filenames
 * - Replaces spaces/special chars with underscores
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 * - Limits length to avoid excessively long names
 */
export function sanitizeForFileName(text = '', maxLength = 30) {
  return String(text || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Remove invalid filename chars
    .replace(/[\s\-–—,;.()[\]{}!@#$%^&+=~`']+/g, '_') // Replace spaces/specials with _
    .replace(/_+/g, '_')   // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .substring(0, maxLength);
}

/**
 * Resolves the EXACT resume file name as specified in the candidate's authentic
 * record / file source (CRM AWS S3 URL, profile resume_filename, or local file).
 * Strictly preserves the exact original filename for every application in Stage 3.
 *
 * @param {object} profile - Candidate profile
 * @param {string} [absPath=''] - Local disk path if available
 * @returns {string} The exact authentic resume file name
 */
export function getExactResumeFileName(profile = {}, absPath = '') {
  // 1. Explicit resume_filename / resume_name on profile or task
  if (profile?._resumeFileName && typeof profile._resumeFileName === 'string') {
    return profile._resumeFileName.trim();
  }
  if (profile?.resume_filename && typeof profile.resume_filename === 'string') {
    return profile.resume_filename.trim();
  }
  if (profile?.resume_name && typeof profile.resume_name === 'string') {
    return profile.resume_name.trim();
  }

  // Helper to extract clean filename from URL or path
  const extractName = (urlOrPath) => {
    if (!urlOrPath || typeof urlOrPath !== 'string') return '';
    try {
      let clean = urlOrPath.trim().split('?')[0].split('#')[0];
      try { clean = decodeURIComponent(clean); } catch {}
      const name = clean.split(/[\/\\]/).pop();
      if (name && /\.(pdf|docx?)$/i.test(name)) {
        return name;
      }
    } catch {}
    return '';
  };

  // 2. High priority: Authentic CRM S3 filename from raw_profile_json (Apply Wizz CRM)
  const crmUrls = [
    profile?._dbClient?.raw_profile_json?.additional_information?.resume_url,
    profile?._dbClient?.raw_profile_json?.additional_information?.resume_path,
    profile?._dbClient?.raw_profile_json?.client?.resume_url,
    profile?._dbClient?.raw_profile_json?.client?.resume_path,
    profile?._applyWizzClientContext?.additional_information?.resume_url,
    profile?._applyWizzClientContext?.additional_information?.resume_path,
    profile?._applyWizzClientContext?.client?.resume_url,
    profile?._applyWizzClientContext?.client?.resume_path,
  ].filter(Boolean);

  for (const raw of crmUrls) {
    const fn = extractName(raw);
    if (fn && !/^[a-f0-9-]{36}\.pdf$/i.test(fn)) {
      return fn;
    }
  }

  // 3. Direct client table resume_url / resume_path
  const directUrls = [
    profile?._dbClient?.resume_url,
    profile?._dbClient?.resume_path,
    profile?._resumeUrl,
    profile?.resume_url,
  ].filter(Boolean);

  // If a direct URL has a rich CRM filename (not just generic AWL-xxx.pdf), prioritize it
  for (const raw of directUrls) {
    const fn = extractName(raw);
    if (fn && !/^[a-f0-9-]{36}\.pdf$/i.test(fn)) {
      if (fn.includes('-resume_') || fn.includes('_resume') || !/^AWL-\d+\.pdf$/i.test(fn)) {
        return fn;
      }
    }
  }

  // 4. Any direct URL filename
  for (const raw of directUrls) {
    const fn = extractName(raw);
    if (fn) return fn;
  }

  // 5. Disk file basename
  if (absPath) {
    return basename(absPath);
  }

  return 'resume.pdf';
}

/**
 * Builds a professional, dynamic resume filename.
 *
 * Priority order for job role:
 *   1. Extracted from current page's document.title (or passed page title)
 *   2. Falls back to user's current/most recent job title from profile
 *   3. Falls back to nothing (omits role from filename)
 *
 * Examples:
 *   Resume_John_Smith_Software_Engineer.pdf
 *   Resume_Jane_Doe_Senior_Product_Manager.pdf
 *   Resume_John_Smith.pdf  (when no role is found)
 *   resume.pdf             (when no profile data at all)
 *
 * @param {object} profile - The user's canonical profile object
 * @param {string} [storedFileName] - The originally uploaded filename (used for extension detection)
 * @param {boolean} [isResume=true] - true = resume, false = cover letter
 * @param {string} [pageTitle=''] - Optional explicit page title override
 * @returns {string}
 */
export function buildDocumentFileName(
  profile,
  storedFileName = '',
  isResume = true,
  pageTitle = ''
) {
  const prefix = isResume ? 'Resume' : 'CoverLetter';

  // Determine file extension from stored filename
  const ext = storedFileName?.endsWith('.docx') ? '.docx'
    : storedFileName?.endsWith('.doc') ? '.doc'
      : '.pdf';

  // Get name components (support nested or flat personal fields)
  const firstName = profile?.personal?.firstName?.trim()
    || profile?.personal?.first_name?.trim()
    || profile?.firstName?.trim()
    || profile?.first_name?.trim()
    || '';

  const lastName = profile?.personal?.lastName?.trim()
    || profile?.personal?.last_name?.trim()
    || profile?.lastName?.trim()
    || profile?.last_name?.trim()
    || '';

  // Get job role: first try page title, then fallback to profile's current job title
  let jobRole = extractJobRoleFromPage(pageTitle);

  if (!jobRole && profile?.experience?.length > 0) {
    // Use the most recent job title from the profile as a fallback
    jobRole = profile.experience[0]?.title || profile.experience[0]?.role || '';
  }
  if (!jobRole && profile?.work_experience?.length > 0) {
    jobRole = profile.work_experience[0]?.job_title || profile.work_experience[0]?.title || '';
  }
  if (!jobRole && (profile?._roleTitle || profile?._jobTitle || profile?.roleTitle)) {
    jobRole = profile._roleTitle || profile._jobTitle || profile.roleTitle || '';
  }

  // Build name parts
  const parts = [prefix];

  if (firstName) parts.push(sanitizeForFileName(firstName, 20));
  if (lastName) parts.push(sanitizeForFileName(lastName, 20));
  if (jobRole) parts.push(sanitizeForFileName(jobRole, 30));

  // Graceful fallback: if no names or role, return lower-case default
  if (parts.length === 1) {
    return isResume ? `resume${ext}` : `cover_letter${ext}`;
  }

  return parts.join('_') + ext;
}
