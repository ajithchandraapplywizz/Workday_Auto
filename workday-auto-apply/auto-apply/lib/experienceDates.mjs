/**
 * experienceDates.mjs — From/To dates for Workday My Experience.
 *
 * The dates come from the profile (Apply Wizz → profile.yml → tenant override).
 * This module never invents a date: it parses the configured value, puts the
 * range in the right order, rejects impossible values, and formats what Workday
 * expects (MM/YYYY for work, YYYY for education).
 */

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function buildMonthYear(month, year) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  return { month, year, text: `${String(month).padStart(2, '0')}/${year}` };
}

/**
 * Parse a configured work date into month + year.
 * Accepts MM/YYYY, M-YYYY, YYYY-MM, MM/DD/YYYY, YYYY-MM-DD and "March 2025".
 * @param {string|number} value
 * @returns {{month: number, year: number, text: string}|null}
 */
export function parseMonthYear(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  if (m) return buildMonthYear(Number(m[1]), Number(m[3]));

  m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return buildMonthYear(Number(m[2]), Number(m[1]));

  m = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  if (m) return buildMonthYear(Number(m[1]), Number(m[2]));

  m = raw.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})$/);
  if (m) return buildMonthYear(Number(m[2]), Number(m[1]));

  m = raw.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m) {
    const month = MONTH_NAMES[m[1].toLowerCase()];
    return month ? buildMonthYear(month, Number(m[2])) : null;
  }

  return null;
}

/**
 * Parse a configured education year.
 * @param {string|number} value
 * @returns {number|null}
 */
export function parseYear(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const monthYear = parseMonthYear(raw);
  if (monthYear) return monthYear.year;

  const m = raw.match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  if (!m) return null;
  const year = Number(m[0]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

/**
 * @param {{month: number, year: number}} a
 * @param {{month: number, year: number}} b
 * @returns {number} negative when a is earlier than b
 */
export function compareMonthYear(a, b) {
  return (a.year - b.year) || (a.month - b.month);
}

function currentMonthYear(now) {
  return buildMonthYear(now.getMonth() + 1, now.getFullYear());
}

/**
 * Resolve the work From/To pair Workday should receive.
 * @param {object} experience profile.experience (or a tenant-merged copy)
 * @param {{now?: Date}} [opts]
 * @returns {{from: string|null, to: string|null, notes: string[]}}
 */
export function resolveWorkDateRange(experience = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const today = currentMonthYear(now);
  const notes = [];

  const rawFrom = experience.from_date ?? experience.start_date ?? '';
  const rawTo = experience.to_date ?? experience.end_date ?? '';

  let from = parseMonthYear(rawFrom);
  let to = parseMonthYear(rawTo);

  if (String(rawFrom).trim() && !from) notes.push(`From "${rawFrom}" is not a valid MM/YYYY date — ignored`);
  if (String(rawTo).trim() && !to) notes.push(`To "${rawTo}" is not a valid MM/YYYY date — ignored`);

  if (from && to && compareMonthYear(from, to) > 0) {
    [from, to] = [to, from];
    notes.push(`From was later than To — swapped to ${from.text} → ${to.text}`);
  }

  if (from && compareMonthYear(from, today) > 0) {
    notes.push(`From ${from.text} is in the future — using ${today.text}`);
    from = today;
  }

  // Workday rejects a future end date on a role that is not marked current, and
  // this filler always leaves "I currently work here" unchecked.
  if (to && compareMonthYear(to, today) > 0) {
    notes.push(`To ${to.text} is in the future — using ${today.text}`);
    to = today;
  }

  if (!to && experience.currently_working === true) {
    to = today;
    notes.push(`Role marked current with no To date — using ${today.text}`);
  }

  if (from && to && compareMonthYear(from, to) > 0) {
    from = to;
    notes.push(`From adjusted to ${from.text} so it is not after To`);
  }

  return { from: from?.text || null, to: to?.text || null, notes };
}

/**
 * Resolve the education From/To years Workday should receive.
 * An expected graduation year in the future is valid and is left alone.
 * @param {object} education profile.education (or a tenant-merged copy)
 * @param {{now?: Date}} [opts]
 * @returns {{from: string|null, to: string|null, notes: string[]}}
 */
export function resolveEducationYearRange(education = {}, opts = {}) {
  const notes = [];

  const rawFrom = education.from_year ?? education.start_year ?? '';
  const rawTo = education.to_year ?? education.graduation_year ?? education.end_year ?? '';

  let from = parseYear(rawFrom);
  let to = parseYear(rawTo);

  if (String(rawFrom).trim() && !from) notes.push(`From "${rawFrom}" is not a valid year — ignored`);
  if (String(rawTo).trim() && !to) notes.push(`To "${rawTo}" is not a valid year — ignored`);

  if (from && to && from > to) {
    [from, to] = [to, from];
    notes.push(`From was later than To — swapped to ${from} → ${to}`);
  }

  return {
    from: from ? String(from) : null,
    to: to ? String(to) : null,
    notes,
  };
}
