/**
 * personName.mjs — Given / family split for Workday legal name fields.
 *
 * Family name = last word only. Given name = all words before the last word.
 */

/**
 * @param {string} fullName
 * @returns {{ first_name: string, last_name: string }}
 */
function toTitleCase(str) {
  return String(str || '')
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function splitGivenFamilyName(fullName = '') {
  const titleCased = toTitleCase(fullName);
  const parts = titleCased.trim().split(/\s+/).filter(Boolean);
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
 * @returns {object}
 */
export function normalizePersonalNames(personal = {}) {
  if (!personal || typeof personal !== 'object') return personal;
  const combined = String(
    personal.full_name
    || [personal.first_name, personal.last_name].filter(Boolean).join(' '),
  ).trim();
  if (!combined) return personal;

  const { first_name, last_name } = splitGivenFamilyName(combined);
  return {
    ...personal,
    full_name: toTitleCase(combined),
    first_name,
    last_name,
  };
}
