/**
 * scanFieldFilter.mjs — Skip optional / unimportant fields.
 * Default: only mandatory fields (*, aria-required, required flag) are filled or prompted.
 * Script-only policy: Playwright never fills or clicks non-required junk.
 */

import { isMinimumAgeQuestion } from './minimumAge.mjs';

const SKIP_LABEL_PATTERNS = [
  /\boptional\b/i,
  /\bnot required\b/i,
  /if you would like/i,
  /employee\s*id.*if applicable/i,
  /cover letter/i,
  /additional attachment/i,
  /upload a file|drop files here|select files/i,
  /facebook|twitter|x\.com|instagram|social media|social profile|social link/i,
  /would you like to receive/i,
  /\bsms\b|text message/i,
  /pronouns?/i,
  /preferred name/i,
  /nickname/i,
  /middle name/i,
  /name suffix|name prefix|\bsuffix\b|\bprefix\b/i,
  /address line 2/i,
  /phone extension|\bextension\b/i,
  /add another/i,
  /recruitment privacy statement.*vibe|vibe philosophy/i,
  /linkedin url|portfolio url|website url/i,
  /websites?\s*\(/i,
  /type to add skills|enter a skill below|add skills/i,
  /overall result|gpa|grade point/i,
  /highest level of education completed/i,
  /role description|job description/i,
  /notice period/i,
  /^(willing to relocate|relocation preference)$/i,
  /linkedin profile|portfolio|github|website url/i,
  /^password\b/i,
  /verify password|confirm password|re-?enter password/i,
  /indicates a required field/i,
  /application questions\s*\d+\s*of/i,
  // My Experience optional sections — never fill (even if Workday pre-renders empty rows)
  /^certificat/i,
  /certification\s*name|license\s*(number|name)|issuing\s*organization/i,
  /\blicens(e|ure|ing)\b/i,
  /^languages?$/i,
  /language\s*proficiency|native\s*language/i,
  /^(awards?|honors?|achievements?)$/i,
  /^(publications?|patents?)$/i,
  /^affiliations?$/i,
  /^references?$/i,
  /^volunteer(\s+(experience|work|name|organization|hours|activities?))?$/i,
  /social\s*networks?/i,
  // Extra optional chrome — script-only skips these
  /additional information|anything else we should know|^comments?\s*$/i,
  /upload (another|additional)|add another file/i,
  /preferred (first|last)?\s*name/i,
  /other name|former name|maiden name/i,
  /twitter|facebook|instagram|tiktok/i,
  /dateSection(Month|Year|Day)/i,
  /^dateSection/i,
];

function isOptionalIfApplicableLabel(label = '') {
  const lower = String(label || '').toLowerCase();
  if (/employee\s*id.*if applicable/i.test(lower)) return true;
  if (/enter\s*n\/?a\s*if\s*not\s*applicable/i.test(lower)) return false;
  if (/or\s+n\/?a\b/i.test(lower)) return false;
  if (/if applicable/i.test(lower) && !/\*/.test(label) && !/\brequired\b/i.test(lower)) return true;
  return false;
}

/**
 * Workday required signal. Skip lists must never override this.
 */
export function hasRequiredSignal(label = '', field = {}) {
  const text = String(label || '').trim();
  if (field?.required === true || field?.ariaRequired === true) return true;
  if (field?.hasRequiredMarker === true) return true;
  if (/\*/.test(text)) return true;
  if (/\b(required|mandatory)\b/i.test(text) && !/indicates a required field/i.test(text)) return true;

  const container = String(field?.containerText || '');
  const plain = text.replace(/\*+$/, '').trim();
  const anchor = plain.slice(0, Math.min(plain.length, 48));
  if (anchor && container) {
    const idx = container.indexOf(anchor);
    if (idx >= 0) {
      const near = container.slice(Math.max(0, idx - 6), idx + anchor.length + 10);
      if (/\*/.test(near)) return true;
    }
  }
  return false;
}

export function isSkippableUnimportantLabel(label = '', field = {}) {
  const text = String(label || '').trim();
  if (!text) return true;
  if (hasRequiredSignal(text, field)) return false;
  if (isMinimumAgeQuestion(text)) return false;
  const lower = text.toLowerCase();
  const looksLikeQuestion = /\?/.test(text)
    || /^(are you|have you|do you|will you|please (select|indicate|confirm|choose))/i.test(text);
  if (SKIP_LABEL_PATTERNS.some((re) => re.test(lower))) return true;
  // Skip instructional "voluntary" chrome — never skip a real question on that page
  if (/\bvoluntary\b/i.test(lower)) {
    if (
      looksLikeQuestion
      || /gender|sex|race|ethnic|veteran|hispanic|latino|disability|terms and conditions|consent|certify|years old|age of/i.test(lower)
    ) {
      return false;
    }
    return true;
  }
  if (isOptionalIfApplicableLabel(text)) return true;
  return false;
}

/**
 * True when Workday marks the field mandatory (red *, aria-required, or DOM required flag).
 * Does not treat instructional "required field" page text as mandatory by itself.
 */
export function isMandatoryField(label = '', field = {}) {
  const text = String(label || '').trim();
  if (!text) return false;
  if (isMinimumAgeQuestion(text)) return true;
  return hasRequiredSignal(text, field);
}

/**
 * Include in scan harvest / terminal prompt / scan fill.
 */
export function shouldIncludeInScan(label = '', field = {}) {
  const text = String(label || '').trim();
  if (!text) return false;
  if (isMinimumAgeQuestion(text)) return true;
  if (isMandatoryField(text, field)) return true;
  // Allow short EEO labels (Race, Sex) that are otherwise under the length floor
  const plain = text.replace(/\*+$/, '').trim();
  const shortEeo = /^(race|ethnicity|gender|sex|hispanic|veteran(\s*status)?)$/i.test(plain);
  if (!shortEeo && text.length < 4) return false;
  if (isSkippableUnimportantLabel(text, field)) return false;

  // Never catalog unknown optional fields
  return false;
}

/** Skip fill/prompt for optional fields (default). Set profile._fillOptionalFields = true to fill everything. */
export function shouldSkipOptionalFill(label = '', field = {}, profile = {}, stepName = '') {
  if (profile?._fillOptionalFields === true) return false;
  return !shouldIncludeInScan(label, field);
}

/** @deprecated Use shouldSkipOptionalFill */
export function shouldSkipScanFill(label = '', field = {}, profile = {}) {
  return shouldSkipOptionalFill(label, field, profile);
}
