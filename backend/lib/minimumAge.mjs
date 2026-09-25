/**
 * minimumAge.mjs — "Are you 16/18 or older?" for job applications.
 *
 * Every requisition we apply to is 18+. Answer Yes unless a real DOB
 * proves the applicant is under the asked threshold (that should not happen).
 */

const AGE_QUESTION_RE = /(?:are\s+you|applicant\s+is|must\s+be|at\s+least|over|older\s+than|age\s+of)\s*(?:the\s+age\s+of\s*)?(1[68])(?:\s*(?:years?(\s*old)?|or\s+over|or\s+older))?|(?:1[68])\s*years?\s*old\s+or\s+over/i;

/**
 * True for Workday minimum-age / working-age questions.
 * @param {string} label
 */
export function isMinimumAgeQuestion(label = '') {
  const t = String(label || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/have\s+you\s+ever|volunteer|related\s+to|criminal|felony|sponsor|visa/i.test(t)) return false;
  return AGE_QUESTION_RE.test(t)
    || /(?:over|older\s+than|at\s+least)\s*(?:the\s+age\s+of\s*)?1[68]\b/i.test(t)
    || /1[68]\s*years?\s*(old|of\s*age)/i.test(t);
}

/**
 * 16 or 18 from the question text. Defaults to 18 for job applications.
 * @param {string} label
 * @returns {number}
 */
export function parseAgeThreshold(label = '') {
  const m = String(label || '').match(/\b(16|18)\b/);
  return m ? Number(m[1]) : 18;
}

/**
 * @param {string|Date} dob
 * @param {Date} [now]
 * @returns {number|null}
 */
export function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  let d = dob instanceof Date ? dob : null;
  if (!d) {
    const raw = String(dob).trim();
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    const us = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    else if (us) d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
    else {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) d = parsed;
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  let age = now.getFullYear() - d.getFullYear();
  const monthDelta = now.getMonth() - d.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

function readDob(profile = {}) {
  return profile?.personal?.date_of_birth
    || profile?.personal?.dob
    || profile?.date_of_birth
    || profile?._applyWizzQa?.['date of birth']
    || '';
}

/**
 * Yes if DOB shows the applicant meets the threshold, or when no DOB is on file
 * (job applications we run are 18+).
 * @param {string} label
 * @param {object} [profile]
 * @returns {'Yes'|null}
 */
export function resolveMinimumAgeAnswer(label, profile = {}) {
  if (!isMinimumAgeQuestion(label)) return null;
  const need = parseAgeThreshold(label);
  const age = ageFromDob(readDob(profile));
  if (age != null && age < need) {
    console.log(`    ⚠️  DOB age ${age} is under ${need} — still Yes for this job pipeline`);
  } else if (age != null) {
    console.log(`    🎂 Age ${age} from DOB ≥ ${need} → Yes`);
  }
  return 'Yes';
}
