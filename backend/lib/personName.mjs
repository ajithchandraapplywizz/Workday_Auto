/**
 * personName.mjs — Given / family split for Workday legal name fields.
 *
 * Family name = last word only. Given name = all words before the last word.
 */

/**
 * @param {string} str
 * @returns {string} First letter capitalized, remaining letters lowercase
 */
export function toTitleCase(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      return word.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
    })
    .join(' ');
}

/**
 * Extracts candidate authentic legal name from their company email (e.g. raviteja.vadla@applywizard.ai -> Ravi Teja, Vadla).
 * @param {string} email
 * @returns {{ first_name: string, last_name: string, full_name: string } | null}
 */
export function deriveNameFromCompanyEmail(email = '') {
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  if (!local || local.length < 3 || /^(test|admin|info|contact|support|user|client)$/i.test(local)) return null;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const last = parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1);
    return { first_name: first, last_name: last, full_name: `${first} ${last}`.trim() };
  }
  return null;
}

/**
 * Extracts candidate authentic legal name from their resume URL or filename.
 * @param {string} urlOrFilename
 * @returns {{ first_name: string, last_name: string, full_name: string } | null}
 */
export function deriveNameFromResumeFilename(urlOrFilename = '') {
  const file = String(urlOrFilename || '').split('/').pop().replace(/\.[a-zA-Z0-9]+$/i, '');
  const m = file.match(/resume[_-]([a-z0-9_-]+)/i);
  if (m) {
    const tokens = m[1].split(/[-_]+/).filter(t => !/^(pm|da|se|de|aiml|wd|fa|ee|jfsd|\d+)$/i.test(t));
    if (tokens.length >= 2) {
      const first = tokens.slice(0, -1).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
      const last = tokens[tokens.length - 1].charAt(0).toUpperCase() + tokens[tokens.length - 1].slice(1);
      return { first_name: first, last_name: last, full_name: `${first} ${last}`.trim() };
    }
  }
  return null;
}

export function splitGivenFamilyName(fullName = '', context = {}) {
  const titleCased = toTitleCase(fullName);
  const parts = titleCased.trim().split(/\s+/).filter(Boolean);
  
  // Guard against dummy/abbreviated single-word names (e.g. 'TSY' or duplicate 'Tsy Tsy')
  const isSuspicious = parts.length <= 1 
    || (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase())
    || (parts.length === 1 && parts[0].length <= 3)
    || /^(test|user|client|applicant|candidate|tsy|admin)$/i.test(parts[0]);

  if (isSuspicious) {
    const fromEmail = deriveNameFromCompanyEmail(context.company_email || context.email);
    if (fromEmail) {
      return { first_name: fromEmail.first_name, last_name: fromEmail.last_name };
    }
    const fromResume = deriveNameFromResumeFilename(context.resume_url || context.resume_path);
    if (fromResume) {
      return { first_name: fromResume.first_name, last_name: fromResume.last_name };
    }
  }

  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: parts[0] };
  return {
    first_name: parts.slice(0, -1).join(' '),
    last_name: parts[parts.length - 1],
  };
}

/**
 * Reconcile personal.first_name / last_name / full_name from the longest full name available.
 * @param {object} personal
 * @param {object} [context]
 * @returns {object}
 */
export function normalizePersonalNames(personal = {}, context = {}) {
  if (!personal || typeof personal !== 'object') return personal;
  const ctx = {
    company_email: personal.company_email || context.company_email,
    email: personal.email || context.email,
    resume_url: personal.resume_url || context.resume_url,
    resume_path: personal.resume_path || context.resume_path,
  };
  const combined = String(
    personal.full_name
    || [personal.first_name, personal.last_name].filter(Boolean).join(' '),
  ).trim();

  const { first_name, last_name } = splitGivenFamilyName(combined, ctx);
  const reconciledFullName = [first_name, last_name].filter(Boolean).join(' ') || toTitleCase(combined);
  return {
    ...personal,
    full_name: toTitleCase(reconciledFullName),
    first_name,
    last_name,
  };
}

