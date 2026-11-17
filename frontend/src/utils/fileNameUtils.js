/**
 * fileNameUtils.js
 * Utilities for generating dynamic, professional resume/cover letter filenames.
 *
 * Format: Resume_FirstName_LastName_JobRole.pdf
 * Falls back gracefully if any component is missing.
 */

export function cleanJobRole(raw = '') {
  return String(raw || '')
    .replace(/^(job\s+application\s+for|application\s+for|apply\s+for|apply\s+to|applying\s+for)\s+/i, '')
    .trim();
}

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
      const candidate = parts.find((p) => p.split(' ').length >= 2) || '';
      return cleanJobRole(candidate);
    }

    return cleanJobRole(title);
  } catch {
    return '';
  }
}

export function sanitizeForFileName(text = '', maxLength = 30) {
  return String(text || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[\s\-–—,;.()[\]{}!@#$%^&+=~`']+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, maxLength)
    .replace(/^_|_$/g, '');
}

export function buildDocumentFileName(
  profile = {},
  storedFileName = '',
  isResume = true,
  pageTitleOrRole = ''
) {
  const prefix = isResume ? 'Resume' : 'CoverLetter';

  const ext = storedFileName?.endsWith('.docx') ? '.docx'
    : storedFileName?.endsWith('.doc') ? '.doc'
      : '.pdf';

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

  let jobRole = extractJobRoleFromPage(pageTitleOrRole);

  if (!jobRole) {
    jobRole = cleanJobRole(
      profile?._roleTitle
      || profile?.roleTitle
      || profile?.role_title
      || profile?.jobTitle
      || ''
    );
  }

  if (!jobRole && Array.isArray(profile?.experience) && profile.experience.length > 0) {
    jobRole = cleanJobRole(profile.experience[0]?.title || '');
  }

  const parts = [prefix];

  if (firstName) parts.push(sanitizeForFileName(firstName, 20));
  if (lastName) parts.push(sanitizeForFileName(lastName, 20));
  if (jobRole) parts.push(sanitizeForFileName(jobRole, 30));

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
