/**
 * fileNameUtils.mjs
 * Utilities for generating dynamic, professional resume/cover letter filenames.
 *
 * Format: Resume_FirstName_LastName_JobRole.pdf
 * Falls back gracefully if any component is missing.
 */

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
 * Extracts the job title/role from the current page's document.title (or a passed title string).
 * Uses the same parsing strategy as AnalyticsTracker.
 *
 * Examples of handled title formats:
 *   "Software Engineer at Google | Greenhouse"  → "Software Engineer"
 *   "Senior Product Manager - Stripe - LinkedIn" → "Senior Product Manager"
 *   "Apply | Software Engineer | Workday"        → "Software Engineer"
 */
export function extractJobRoleFromPage(titleInput = '') {
  try {
    let title = typeof titleInput === 'string' && titleInput ? titleInput : '';
    if (!title && typeof document !== 'undefined') {
      title = document.title || '';
    }
    if (!title) return '';

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

    // Return cleaned title if no clear delimiter/job role structure is found
    return cleanJobRole(title);
  } catch {
    return '';
  }
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
    .substring(0, maxLength)
    .replace(/^_|_$/g, ''); // Trim leading/trailing underscores
}

/**
 * Builds a professional, dynamic resume filename.
 *
 * Priority order for job role:
 *   1. Extracted from current page's document.title (or passed pageTitle)
 *   2. Falls back to explicit job requisition title from profile/plan (_roleTitle / roleTitle)
 *   3. Falls back to user's current/most recent job title from profile experience
 *   4. Falls back to nothing (omits role from filename)
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
 * @param {string} [pageTitleOrRole=''] - The current page title or explicit role
 * @returns {string}
 */
export function buildDocumentFileName(
  profile = {},
  storedFileName = '',
  isResume = true,
  pageTitleOrRole = ''
) {
  const prefix = isResume ? 'Resume' : 'CoverLetter';

  // Determine file extension from stored filename
  const ext = storedFileName?.endsWith('.docx') ? '.docx'
    : storedFileName?.endsWith('.doc') ? '.doc'
      : '.pdf';

  // Get name components (safely inspect various profile structures)
  const firstName = (
    profile?.personal?.firstName
    || profile?.firstName
    || profile?._dbClient?.client_name?.split(' ')[0]
    || profile?.name?.split(' ')[0]
    || ''
  ).trim();

  const lastName = (
    profile?.personal?.lastName
    || profile?.lastName
    || profile?._dbClient?.client_name?.split(' ').slice(1).join(' ')
    || profile?.name?.split(' ').slice(1).join(' ')
    || ''
  ).trim();

  // Get job role: first try page title / extracted role
  let jobRole = extractJobRoleFromPage(pageTitleOrRole);

  // Fallback to explicit role from profile or task
  if (!jobRole) {
    jobRole = cleanJobRole(
      profile?._roleTitle
      || profile?.roleTitle
      || profile?.role_title
      || profile?.jobTitle
      || ''
    );
  }

  // Fallback to user's most recent job title from experience
  if (!jobRole && Array.isArray(profile?.experience) && profile.experience.length > 0) {
    jobRole = cleanJobRole(profile.experience[0]?.title || '');
  }

  // Build name parts
  const parts = [prefix];

  if (firstName) parts.push(sanitizeForFileName(firstName, 20));
  if (lastName) parts.push(sanitizeForFileName(lastName, 20));
  if (jobRole) parts.push(sanitizeForFileName(jobRole, 30));

  // If both first and last name are missing, return simple default
  if (!firstName && !lastName && !jobRole) {
    return isResume ? `resume${ext}` : `cover_letter${ext}`;
  }

  return parts.join('_') + ext;
}

export default {
  extractJobRoleFromPage,
  cleanJobRole,
  sanitizeForFileName,
  buildDocumentFileName,
};
