/**
 * fileNameUtils.ts
 * Utilities for generating dynamic, professional resume/cover letter filenames.
 *
 * Format: Resume_FirstName_LastName_JobRole.pdf
 * Falls back gracefully if any component is missing.
 */

/**
 * Extracts the job title/role from the current page's document.title.
 * Uses the same parsing strategy as AnalyticsTracker.
 *
 * Examples of handled title formats:
 *   "Software Engineer at Google | Greenhouse"  → "Software Engineer"
 *   "Senior Product Manager - Stripe - LinkedIn" → "Senior Product Manager"
 *   "Apply | Software Engineer | Workday"        → "Software Engineer"
 */
export function extractJobRoleFromPage(customTitle = ''): string {
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
            const parts = title.split(' | ').map(p => p.trim()).filter(Boolean);
            // Find the part that looks most like a job title (longer, not a single word like "Apply")
            const candidate = parts.find(p => p.split(' ').length >= 2) || '';
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
export function cleanJobRole(raw: string): string {
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
export function sanitizeForFileName(text: string, maxLength = 30): string {
    return String(text || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Remove invalid filename chars
        .replace(/[\s\-–—,;.()[\]{}!@#$%^&+=~`']+/g, '_') // Replace spaces/specials with _
        .replace(/_+/g, '_')   // Collapse multiple underscores
        .replace(/^_|_$/g, '') // Trim leading/trailing underscores
        .substring(0, maxLength);
}

/**
 * Builds a professional, dynamic resume filename.
 *
 * Priority order for job role:
 *   1. Extracted from current page's document.title
 *   2. Falls back to user's current/most recent job title from profile
 *   3. Falls back to nothing (omits role from filename)
 *
 * Examples:
 *   Resume_John_Smith_Software_Engineer.pdf
 *   Resume_Jane_Doe_Senior_Product_Manager.pdf
 *   Resume_John_Smith.pdf  (when no role is found)
 *   resume.pdf             (when no profile data at all)
 *
 * @param profile - The user's canonical profile object
 * @param storedFileName - The originally uploaded filename (used for extension detection)
 * @param isResume - true = resume, false = cover letter
 * @param pageTitle - Optional explicit page title override
 */
export function buildDocumentFileName(
    profile: any,
    storedFileName?: string,
    isResume = true,
    pageTitle = ''
): string {
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
    const parts: string[] = [prefix];

    if (firstName) parts.push(sanitizeForFileName(firstName, 20));
    if (lastName) parts.push(sanitizeForFileName(lastName, 20));
    if (jobRole) parts.push(sanitizeForFileName(jobRole, 30));

    // Graceful fallback: if no names or role, return lower-case default
    if (parts.length === 1) {
        return isResume ? `resume${ext}` : `cover_letter${ext}`;
    }

    return parts.join('_') + ext;
}
