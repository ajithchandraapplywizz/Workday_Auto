/**
 * applyWizzClient.mjs — Fetch client details from Apply Wizz CRM API.
 *
 * .env (any one of these):
 *   APPLYWIZZ_ID=AWL-34133
 *   APPLYWIZZ_API_URL=https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-34133
 *   APPLYWIZZ_CLIENT_URL=…same full URL…
 *
 * Fetched once per process (cached). Merged in loadProfile + profileBootstrap.
 */

import { normalizeLabel } from './qaStore.mjs';
import { fuzzyScore } from './fields.mjs';
import { getTodayMMDDYYYY } from './date-utils.mjs';
import { matchAnswerConcept, lookupConceptInQaMap, resolveByConcept } from './answerConcepts.mjs';
import { formatHttpError, httpsJsonWithRetry } from './httpClient.mjs';
import { mergeNonEmpty, workdayPhoneCodeForCountry } from './clientContact.mjs';
import { splitGivenFamilyName } from './personName.mjs';
import {
  isSupabaseConfigured,
  loadLocalEnvOnce,
  loadSupabaseAnswers,
  loadSupabaseClientSnapshot,
  hydrateSupabaseAnswers,
  recordSupabaseAnswerInMemory,
  upsertSupabaseAnswer,
  upsertSupabaseAnswers,
  upsertSupabaseClient,
} from './supabaseClient.mjs';

const DEFAULT_API_BASE = 'https://www.apply-wizz.me/api/get-client-details';

/**
 * Check whether an email belongs to the official ApplyWizz / ApplyWizard company domains.
 * Personal email domains (e.g. gmail, yahoo, outlook, hotmail, icloud, etc.) return false.
 */
export function isCompanyEmail(email = '') {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return false;
  return /^[a-z0-9._%+-]+@(applywizard|applywizz)\.ai$/i.test(clean);
}

/**
 * Resolve or derive the official company email for an ApplyWizz client.
 * Strictly guarantees company_email is on @applywizard.ai / @applywizz.ai and never a personal email.
 */
export function resolveCompanyEmail(client = {}, fullName = '') {
  let email = String(client.company_email || client.companyEmail || '').trim().toLowerCase();
  if (email.endsWith('@applywzard.ai')) {
    email = email.replace('@applywzard.ai', '@applywizard.ai');
  }
  if (isCompanyEmail(email)) {
    return email;
  }

  const rawFirst = String(client.first_name || '').trim();
  const rawLast = String(client.last_name || '').trim();
  const name = String(fullName || client.full_name || client.client_name || '').trim();

  let first = rawFirst.toLowerCase().replace(/[^a-z0-9]/g, '');
  let last = rawLast.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!first || !last) {
    const parts = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      first = parts[0];
      last = parts[parts.length - 1];
    } else if (parts.length === 1) {
      first = parts[0];
      last = '';
    }
  }

  if (first && last) {
    return `${first}.${last}@applywizard.ai`;
  }
  if (first) {
    return `${first}@applywizard.ai`;
  }
  return '';
}

let cache = null;
/** @type {Promise<void>|null} */
let hydrateInFlight = null;

async function fetchJsonWithRetry(url) {
  const res = await httpsJsonWithRetry(
    { url, method: 'GET', timeoutMs: 20000 },
    { attempts: 3, label: 'Apply Wizz' },
  );
  if (!res.ok) throw new Error(`Apply Wizz API ${res.status}`);
  try {
    return res.json();
  } catch {
    throw new Error('Apply Wizz API: invalid JSON');
  }
}

function sanitizedClientContext(client = {}, info = {}) {
  const blockedKey = /password|secret|token|api.?key|credential|cookie|session/i;
  const clean = (value, depth = 0) => {
    if (depth > 5) return undefined;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
    if (typeof value === 'string') return value.slice(0, 4000);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blockedKey.test(key))
        .map(([key, item]) => [key, clean(item, depth + 1)])
        .filter(([, item]) => item !== undefined),
    );
  };
  return clean({ client, additional_information: info });
}

function envApiUrlRaw() {
  return String(
    process.env.APPLYWIZZ_CLIENT_URL
    || process.env.APPLYWIZZ_API_URL
    || '',
  ).trim();
}

/** Parse applywizz_id from a full get-client-details URL. */
function parseIdFromUrl(urlString = '') {
  const raw = String(urlString || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.searchParams.get('applywizz_id') || u.searchParams.get('applywizzId') || '';
  } catch {
    const m = raw.match(/applywizz_id=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

/** @returns {{ id: string, fetchUrl: string, configured: boolean }} */
export function resolveApplyWizzConfig() {
  loadLocalEnvOnce();
  const fromEnvId = String(process.env.APPLYWIZZ_ID || process.env.APPLYWIZZ_CLIENT_ID || '').trim();
  const rawUrl = envApiUrlRaw();
  const idFromUrl = parseIdFromUrl(rawUrl);
  const id = fromEnvId || idFromUrl;

  if (rawUrl && idFromUrl) {
    return { id: idFromUrl || id, fetchUrl: rawUrl, configured: Boolean(idFromUrl || id) };
  }

  const base = rawUrl && !rawUrl.includes('applywizz_id')
    ? rawUrl.replace(/\?+$/, '')
    : DEFAULT_API_BASE;

  if (!id) {
    return { id: '', fetchUrl: '', configured: false };
  }

  const fetchUrl = base.includes('?')
    ? `${base}&applywizz_id=${encodeURIComponent(id)}`
    : `${base}?applywizz_id=${encodeURIComponent(id)}`;

  return { id, fetchUrl, configured: true };
}

export function isApplyWizzConfigured() {
  return resolveApplyWizzConfig().configured;
}

function getApplyWizzId() {
  return resolveApplyWizzConfig().id;
}

function isoToMMDDYYYY(iso) {
  const m = String(iso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function parseSalaryMid(range = '') {
  const text = String(range || '');
  const kMatch = text.match(/(\d+)\s*k\s*[-–]\s*(\d+)\s*k/i);
  if (kMatch) {
    const mid = Math.round((Number(kMatch[1]) + Number(kMatch[2])) / 2);
    return String(mid * 1000);
  }
  const num = text.match(/\b(\d{5,7})\b/);
  if (num) return num[1];
  return '90000';
}

function parseHourlyMid(range = '') {
  const text = String(range || '');
  const hourly = text.match(/hourly[^0-9]{0,12}(\d+)\s*[-–]\s*(\d+)/i);
  if (hourly) return String(Math.round((Number(hourly[1]) + Number(hourly[2])) / 2));
  const one = text.match(/hourly[^0-9]{0,12}(\d{2,3})\b/i);
  if (one) return one[1];
  return '';
}

function parseAddress(fullAddress = '') {
  const parts = String(fullAddress || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    return {
      address_line1: '',
      city: '',
      state: '',
      postal_code: '',
      country: '',
    };
  }

  let country = '';
  let postal_code = '';
  let state = '';
  let city = '';
  let address_line1 = '';

  const list = [...parts];

  if (list.length > 1 && !/\d/.test(list[list.length - 1]) && list[list.length - 1].length > 2) {
    country = list.pop();
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const zipMatch = list[i].match(/\b\d{5}(?:-\d{4})?\b/);
    if (zipMatch) {
      postal_code = zipMatch[0];
      const cleaned = list[i].replace(zipMatch[0], '').trim();
      if (cleaned) {
        list[i] = cleaned;
      } else {
        list.splice(i, 1);
      }
      break;
    }
  }

  if (list.length > 0) {
    const possibleState = list[list.length - 1];
    if (possibleState.length <= 25 || /^[A-Z]{2}$/i.test(possibleState)) {
      state = possibleState.replace(/\d.*/, '').trim();
      list.pop();
    }
  }

  if (list.length > 0) {
    city = list.pop();
  }

  if (list.length >= 2 && /^\d+[a-zA-Z0-9\-\/]*$/.test(list[0])) {
    address_line1 = `${list[0]} ${list[1]}`;
  } else if (list.length > 0) {
    address_line1 = list[0];
  }

  return {
    address_line1,
    city,
    state,
    postal_code,
    country,
  };
}

function boolYesNo(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 'Yes';
  if (value === false || value === 'false' || value === 0 || value === '0') return 'No';
  return null;
}

/**
 * Normalize a raw degree string to a canonical storage label for the Supabase
 * `clients.degree` column. Returns a slash-separated display string so that
 * any reasonable alias can be matched later, or the original value when no
 * canonical bucket is detected.
 *
 * Examples:
 *   "Master of Science in Data Analytics" → "Master of Science/Masters/MS"
 *   "Bachelor of Technology in CSE"       → "Bachelor of Technology/Bachelors/BTech"
 *   "Master of Biotechnology"              → "Master of Biotechnology/M.Biotech"
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeDegreeForStorage(raw = '') {
  const d = String(raw || '').trim();
  if (!d) return d;

  // Masters of Science / MS / M.S.
  if (/master[^a-z]*of[^a-z]*science|\bm\.?s\.?(?:\b|\s|$)|\bms\b/i.test(d)) {
    return 'Master of Science/Masters/MS';
  }
  // Master of Biotechnology
  if (/master[^a-z]*of[^a-z]*biotech|\bm\.?biotech\b|\bms\s*biotech\b/i.test(d)) {
    return 'Master of Biotechnology/M.Biotech';
  }
  // Masters (generic — must come after the more specific checks above)
  if (/\bmaster|\bm\.?tech\b/i.test(d)) {
    return 'Masters/Master/MS';
  }
  // Bachelor of Technology / B.Tech
  if (/bachelor[^a-z]*of[^a-z]*tech|\bb\.?tech\b/i.test(d)) {
    return 'Bachelor of Technology/Bachelors/BTech';
  }
  // Bachelor of Science / BS
  if (/bachelor[^a-z]*of[^a-z]*science|\bb\.?s\.?(?:\b|\s|$)/i.test(d)) {
    return 'Bachelor of Science/Bachelors/BS';
  }
  // Bachelor (generic)
  if (/\bbachelor/i.test(d)) {
    return 'Bachelors/Bachelor Degree/Bachelor';
  }
  // Associate
  if (/\bassociate/i.test(d)) {
    return 'Associate Degree/Associates';
  }
  // PhD / Doctorate
  if (/\bph\.?d\b|\bdoctor(?:ate|al)?/i.test(d)) {
    return 'Doctorate/PhD';
  }

  return d;
}

function firstApiValue(keys, ...sources) {
  const wanted = new Set(keys.map((key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (wanted.has(normalized) && value != null && String(value).trim() !== '') return value;
    }
  }
  return '';
}

/** Strip Workday boilerplate so long DOM labels match short API keys. */
export function stripWorkdayQuestionLabel(label = '') {
  return String(label || '')
    .replace(/\*+/g, ' ')
    .replace(/^\s*(please\s+select|select\s+one|choose)\s+/i, '')
    .replace(/\s*\(required\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a raw API answer onto live DOM options (dropdown / radio / checkbox).
 * @returns {string|null} null only when options exist but nothing matches
 */
export function alignAnswerToWorkdayOptions(answer, options = [], fieldType = '') {
  const raw = String(answer ?? '').trim();
  if (!raw) return null;
  const opts = (options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!opts.length) return raw;

  const lower = raw.toLowerCase();
  const exact = opts.find((o) => o.toLowerCase() === lower);
  if (exact) return exact;

  const degreeAnswer = /master|bachelor|associate|doctor|phd|science|arts|postgraduate|undergraduate|diploma|degree|\bms\b|\bbs\b|\bb\.?tech\b|\bb\.?e\b|\bmba\b|\bm\.s\b|\bb\.s\b/i.test(raw)
    || /degree|education/i.test(fieldType);
  if (degreeAnswer) {
    const isMaster = /master|\bms\b|\bm\.s\b|\bmba\b|\bpostgrad/i.test(raw);
    const isBachelor = /bachelor|\bbs\b|\bb\.s\b|\bb\.?tech\b|\bb\.?e\b|\bundegrad/i.test(raw);
    const isDoctorate = /doctor|\bph\.?d\b/i.test(raw);
    const isAssociate = /associate|\baa\b|\bas\b/i.test(raw);
    const isHighSchool = /high\s*school|secondary|ged/i.test(raw);

    if (isMaster) {
      const match = opts.find((o) => /master\s*of\s*science/i.test(o))
        || opts.find((o) => /^ms(?:\b|\s)/i.test(o))
        || opts.find((o) => /\bmaster/i.test(o))
        || opts.find((o) => /\b(postgraduate|graduate)\s*(degree)?/i.test(o));
      if (match) return match;
    }
    if (isBachelor) {
      const match = opts.find((o) => /bachelor\s*of\s*science/i.test(o))
        || opts.find((o) => /^bs(?:\b|\s)/i.test(o))
        || opts.find((o) => /\bbachelor/i.test(o))
        || opts.find((o) => /\bundergraduate\s*(degree)?/i.test(o));
      if (match) return match;
    }
    if (isDoctorate) {
      const match = opts.find((o) => /\b(doctor|ph\.?d)/i.test(o));
      if (match) return match;
    }
    if (isAssociate) {
      const match = opts.find((o) => /\bassociate/i.test(o));
      if (match) return match;
    }
    if (isHighSchool) {
      const match = opts.find((o) => /\b(high\s*school|secondary|ged)\b/i.test(o));
      if (match) return match;
    }
  }

  if (/^yes$/i.test(raw)) {
    const yesOpt = opts.find((o) => /^yes\b/i.test(o));
    if (yesOpt) return yesOpt;
  }
  if (/^no$/i.test(raw)) {
    const noOpt = opts.find((o) => /^no\b/i.test(o));
    if (noOpt) return noOpt;
  }

  let best = null;
  let bestScore = 0;
  for (const opt of opts) {
    const score = fuzzyScore(raw, opt);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  if (best && bestScore >= 0.45) return best;

  // Veteran / disability long-form answers often contain the option text as substring
  const sub = opts.find((o) => {
    const ol = o.toLowerCase();
    return ol.includes(lower) || lower.includes(ol.slice(0, Math.min(ol.length, 24)));
  });
  return sub || raw;
}

function indexBoolAnswers(put, labels, value) {
  const yn = boolYesNo(value);
  if (yn == null) return;
  for (const label of labels) put(label, yn);
}

/** Build flat Q&A index from API payload for fuzzy cross-label lookup. */
export function buildApplyWizzQaIndex(client = {}, info = {}) {
  const qa = {};
  const addrFromFull = info.full_address ? parseAddress(info.full_address) : null;
  const put = (key, val) => {
    if (val == null || val === '') return;
    qa[normalizeLabel(key)] = String(val);
  };

  const startDate = isoToMMDDYYYY(info.desired_start_date) || getTodayMMDDYYYY('Asia/Kolkata');
  const salary = parseSalaryMid(client.salary_range);
  const sponsorship = info.require_future_sponsorship ?? client.sponsorship;

  put('when are you available to start', startDate);
  put('available to start', startDate);
  put('desired start date', startDate);
  put('when can you start', startDate);
  const hourly = parseHourlyMid(client.salary_range);
  put('what is your desired compensation', salary);
  put('minimum hourly wage', hourly);
  put('hourly wage', hourly);
  put('hourly rate', hourly);
  put('minimum hourly wage requirement', hourly);
  put('desired salary', salary);
  put('salary expectation', salary);
  put('compensation', salary);

  if (info.gender) {
    put('gender', info.gender);
    put('sex', info.gender);
    put('please select your gender', info.gender);
  }
  if (info.is_hispanic_latino != null && info.is_hispanic_latino !== '') {
    const hispanic = boolYesNo(info.is_hispanic_latino) || String(info.is_hispanic_latino).trim();
    put('hispanic or latino', hispanic);
    put('are you hispanic latino', hispanic);
    put('are you hispanic/latino', hispanic);
  }
  if (info.race_ethnicity) {
    put('race ethnicity', info.race_ethnicity);
    put('race', info.race_ethnicity);
    put('ethnicity', info.race_ethnicity);
    put('please select the ethnicity which most accurately describes how you identify yourself', info.race_ethnicity);
    put('please select the race which most accurately describes how you identify yourself', info.race_ethnicity);
  }
  const veteranStatus = firstApiValue([
    'veteran_status', 'veteranStatus', 'protected_veteran_status', 'protectedVeteranStatus',
  ], info, client);
  if (veteranStatus) {
    put('veteran status', veteranStatus);
    put('please select the veteran status which most accurately describes how you identify yourself', veteranStatus);
  }
  if (info.disability_status) put('disability', info.disability_status);

  if (info.eligible_to_work_in_us != null) {
    put('authorized to work', info.eligible_to_work_in_us ? 'Yes' : 'No');
    put('legally authorized to work', info.eligible_to_work_in_us ? 'Yes' : 'No');
  }
  if (sponsorship != null && sponsorship !== '') {
    put('require sponsorship', sponsorship ? 'Yes' : 'No');
    put('visa sponsorship', sponsorship ? 'Yes' : 'No');
    put('sponsorship', sponsorship ? 'Yes' : 'No');
  }

  indexBoolAnswers(put, [
    'willing to relocate', 'are you willing to relocate',
  ], info.willing_to_relocate);
  indexBoolAnswers(put, [
    'background check', 'submit to a background check', 'criminal background',
  ], info.willing_background_check);
  indexBoolAnswers(put, [
    'drug screen', 'drug test', 'substance test',
  ], info.willing_drug_screen);
  indexBoolAnswers(put, [
    'felony', 'convicted of a felony', 'criminal conviction',
  ], info.convicted_of_felony);
  // Job applications we run are 18+. Index 16+ and 18+ as Yes even if API omits the flag.
  indexBoolAnswers(put, [
    'over 18', 'at least 18', '18 years of age', 'over the age of 18',
    'over 16', '16 years of age', '16 years old or over', '16 years of age or older',
  ], info.is_over_18 !== false);
  indexBoolAnswers(put, [
    'perform essential functions', 'essential job functions',
  ], info.can_perform_essential_functions);
  indexBoolAnswers(put, [
    'work 3 days in office', 'three days in office', 'hybrid office',
  ], info.can_work_3_days_in_office);
  indexBoolAnswers(put, ['pending investigation', 'under investigation'], info.pending_investigation);
  indexBoolAnswers(put, [
    'failed drug test', 'refused drug test',
  ], info.failed_or_refused_drug_test);
  indexBoolAnswers(put, [
    'substances affecting duties', 'impair job performance',
  ], info.uses_substances_affecting_duties);
  indexBoolAnswers(put, [
    'provide legal documentation', 'legal work documents', 'i 9 documents',
  ], info.can_provide_legal_docs);
  indexBoolAnswers(put, [
    'referred by agency', 'staffing agency',
  ], info.referred_by_agency);
  indexBoolAnswers(put, [
    'discharged for policy violation', 'terminated for policy',
  ], info.discharged_for_policy_violation);
  if (info.worked_for_company_before != null) {
    indexBoolAnswers(put, [
      'worked for this company before', 'previously employed', 'former employee',
    ], info.worked_for_company_before);
  }
  if (info.has_relatives_in_company != null) {
    indexBoolAnswers(put, [
      'relatives employed', 'family member employed', 'relative working',
    ], info.has_relatives_in_company);
  }
  if (info.authorized_without_visa != null) {
    indexBoolAnswers(put, [
      'authorized without visa', 'work without sponsorship now',
    ], info.authorized_without_visa);
  }

  const degree = info.highest_education || '';
  const fieldOfStudy = info.main_subject || '';
  const gradYear = info.graduation_year || '';
  const schoolName = (info.university_name || '').trim() || 'Other';
  put('highest level of education', degree);
  put('highest education', degree);
  put('educational level', degree);
  put('gpa', info.cumulative_gpa || '');
  put('cumulative gpa', info.cumulative_gpa || '');
  put('school or university', schoolName);
  put('university', schoolName);
  put('school', schoolName);
  put('college', schoolName);
  put('name of institution', schoolName);
  put('degree', degree);
  put('field of study', fieldOfStudy);
  put('major', fieldOfStudy);
  put('area of study', fieldOfStudy);
  put('main subject', fieldOfStudy);
  put('graduation year', gradYear);
  put('year of graduation', gradYear);
  put('expected graduation', gradYear);
  put('education to', gradYear);
  put('to year', gradYear);
  put('years of experience', info.experience || '');
  put('experience years', info.experience || '');
  put('total years of experience', info.experience || '');
  put('company', info.latest_company || client.company || '');
  put('latest company', info.latest_company || client.company || '');
  put('current company', info.latest_company || client.company || '');
  put('employer', info.latest_company || client.company || '');
  if (info.from_date) {
    put('work from', info.from_date);
    put('experience from', info.from_date);
  }
  if (info.to_date) {
    put('work to', info.to_date);
    put('experience to', info.to_date);
  }
  put('visa type', client.visa_type || '');
  put('linkedin', info.linked_in_url || '');
  put('github', info.github_url || '');
  put('role', info.role || (client.job_role_preferences || [])[0] || '');
  put('job title', info.role || (client.job_role_preferences || [])[0] || '');
  put('current title', info.role || (client.job_role_preferences || [])[0] || '');
  put('phone', info.primary_phone && info.primary_phone !== '+' ? info.primary_phone : '');

  const companyEmail = resolveCompanyEmail(client, client.full_name);
  const personalEmail = String(
    (!isCompanyEmail(client.personal_email) ? client.personal_email : '') ||
    (!isCompanyEmail(info.email) ? info.email : '') ||
    (!isCompanyEmail(client.company_email) ? client.company_email : '')
  ).trim();
  put('email', companyEmail || personalEmail || '');
  if (companyEmail) put('company email', companyEmail);
  if (personalEmail) put('personal email', personalEmail);

  const countryLabel = addrFromFull?.country || info.zip_or_country || info.country || '';
  if (countryLabel) {
    put('country', countryLabel);
  }

  if (Array.isArray(info.alternate_job_roles)) {
    put('alternate roles', info.alternate_job_roles.filter(Boolean).join(', '));
  }
  if (Array.isArray(info.work_preferences)) {
    put('work preferences', info.work_preferences.filter(Boolean).join(', '));
    put('what work types are you open to', info.work_preferences.filter(Boolean).join(', '));
  } else if (info.work_preferences != null && info.work_preferences !== '') {
    const wp = String(info.work_preferences).trim();
    put('work preferences', wp);
    put('what work types are you open to', wp);
    put('schedule', wp);
    put('what schedule can you work', wp);
    put('what shifts can you work', wp);
  }
  if (info.state_of_residence) {
    put('state of residence', info.state_of_residence);
    put('state', info.state_of_residence);
  }
  if (info.date_of_birth) {
    const dob = String(info.date_of_birth).trim();
    const formatted = isoToMMDDYYYY(dob) || dob;
    put('date of birth', formatted);
    put('birth date', formatted);
    put('dob', formatted);
  }

  if (addrFromFull) {
    put('address line 1', addrFromFull.address_line1);
    put('city', addrFromFull.city);
    put('state', addrFromFull.state);
    put('postal code', addrFromFull.postal_code);
    if (addrFromFull.country) put('country', addrFromFull.country);
  }

  return qa;
}

/** Map API payload → profile.yml-shaped overlay (does not overwrite education Workday defaults). */
export function mapApplyWizzToProfile(client = {}, info = {}) {
  const names = splitGivenFamilyName(client.full_name || '');
  const addr = parseAddress(info.full_address || '');
  const startDate = isoToMMDDYYYY(info.desired_start_date) || getTodayMMDDYYYY('Asia/Kolkata');
  const veteranStatus = firstApiValue([
    'veteran_status', 'veteranStatus', 'protected_veteran_status', 'protectedVeteranStatus',
  ], info, client);

  const companyEmail = resolveCompanyEmail(client, client.full_name);
  const personalEmail = String(
    (!isCompanyEmail(client.personal_email) ? client.personal_email : '') ||
    (!isCompanyEmail(info.email) ? info.email : '') ||
    (!isCompanyEmail(client.company_email) ? client.company_email : '')
  ).trim();
  const applicationEmail = companyEmail || personalEmail || '';

  const countryName = addr.country || info.zip_or_country || info.country || '';
  const personalRaw = {
    first_name: names.first_name,
    last_name: names.last_name,
    email: applicationEmail,
    company_email: companyEmail,
    personal_email: personalEmail,
    phone: info.primary_phone && info.primary_phone !== '+' ? String(info.primary_phone).replace(/\D/g, '') : '',
    linkedin: info.linked_in_url || '',
    city: addr.city || (client.location_preferences || [])[0] || '',
    state: addr.state || info.state_of_residence || '',
    postal_code: addr.postal_code || '',
    address_line1: addr.address_line1 || '',
    country: countryName,
    country_phone_code: workdayPhoneCodeForCountry(countryName) || '',
    source: info.how_did_you_hear || client.source || '',
    date_of_birth: isoToMMDDYYYY(info.date_of_birth) || info.date_of_birth || '',
  };
  const personal = mergeNonEmpty({}, personalRaw);

  return {
    personal,
    work_auth: {
      authorized_us: info.eligible_to_work_in_us ? 'Yes' : 'No',
      sponsorship_needed: (info.require_future_sponsorship ?? client.sponsorship) ? 'Yes' : 'No',
      visa_type: client.visa_type || info.visa_type || '',
      willing_to_relocate: boolYesNo(info.willing_to_relocate) || '',
    },
    eeo: {
      ...(info.gender ? { gender: info.gender } : {}),
      ...(info.is_hispanic_latino != null && info.is_hispanic_latino !== ''
        ? { hispanic_latino: boolYesNo(info.is_hispanic_latino) || String(info.is_hispanic_latino) }
        : {}),
      ...(info.race_ethnicity ? { race: info.race_ethnicity } : {}),
      ...(veteranStatus ? { veteran_status: veteranStatus } : {}),
      ...(info.disability_status ? { disability_status: info.disability_status } : {}),
    },
    experience: {
      current_title: info.role || (client.job_role_preferences || [])[0] || '',
      current_company: info.latest_company || client.company || '',
      location: info.location || (client.location_preferences || [])[0] || '',
      from_date: info.from_date || '',
      to_date: info.to_date || '',
      currently_working: typeof info.currently_working === 'boolean' ? info.currently_working : (info.to_date ? false : true),
      years: info.experience != null && info.experience !== '' ? String(info.experience) : '',
    },
    education: (() => {
      let cleanMajor = String(info.main_subject || '').trim();
      if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4}$/i.test(cleanMajor) || /^\d{4}$/.test(cleanMajor)) {
        cleanMajor = '';
      }
      let cleanDegree = String(info.highest_education || '').trim();
      cleanDegree = cleanDegree.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4}\b/gi, '').trim();
      return {
        university: (info.university_name || '').trim() || 'Other',
        degree: cleanDegree || info.highest_education || '',
        major: cleanMajor || '',
        field_of_study_hierarchy: cleanMajor ? [cleanMajor] : [],
        highest_level: cleanDegree || info.highest_education || '',
        gpa: info.cumulative_gpa || '',
        to_year: info.graduation_year || '',
      };
    })(),
    compensation: parseSalaryMid(client.salary_range),
    compensation_hourly: parseHourlyMid(client.salary_range),
    _applyWizzId: client.applywizz_id || getApplyWizzId(),
    _resumeUrl: info.resume_url || info.resume_path || client.resume_url || client.resume_path || '',
    _desiredStartDate: startDate,
    _applyWizzAlternateRoles: Array.isArray(info.alternate_job_roles)
      ? info.alternate_job_roles.map((r) => String(r || '').trim()).filter(Boolean)
      : [],
    _applyWizzWorkPreferences: Array.isArray(info.work_preferences)
      ? info.work_preferences.map((r) => String(r || '').trim()).filter(Boolean)
      : [],
  };
}

export async function fetchApplyWizzClient(applywizzId = '') {
  const cfg = resolveApplyWizzConfig();
  const id = String(applywizzId || cfg.id).trim();
  if (!id || !cfg.configured) return null;

  const url = applywizzId
    ? (cfg.fetchUrl.includes('applywizz_id')
      ? cfg.fetchUrl.replace(/applywizz_id=[^&]+/i, `applywizz_id=${encodeURIComponent(id)}`)
      : `${cfg.fetchUrl}${cfg.fetchUrl.includes('?') ? '&' : '?'}applywizz_id=${encodeURIComponent(id)}`)
    : cfg.fetchUrl;

  const data = await fetchJsonWithRetry(url);
  if (!data?.client) throw new Error('Apply Wizz API: missing client payload');
  return data;
}

/** Convert the first parsed resume work/education records into client answer rows. */
export function buildResumeAnswerEntries(parsed = {}) {
  const entries = [];
  const add = (questionNormalized, answer, fieldType = 'text') => {
    if (answer == null || String(answer).trim() === '') return;
    entries.push({
      questionNormalized: normalizeLabel(questionNormalized),
      answer: String(answer).trim(),
      fieldType,
      source: 'resume',
      unknownQuestion: false,
    });
  };

  const experience = parsed.experience || {};
  add('resume work experience role', experience.current_title);
  add('resume work experience company', experience.current_company);
  add('resume work experience location', experience.location || experience.city);
  add('resume work experience from', experience.from_date);
  add('resume work experience to', experience.to_date);
  if (experience.currently_working != null) {
    add('resume work experience currently working', experience.currently_working ? 'Yes' : 'No', 'checkbox');
  }

  const education = parsed.education || {};
  add('resume education degree', education.degree);
  add('resume education major', education.major);
  add('resume education university', education.university);
  add('resume education from', education.from_year);
  add('resume education to', education.to_year);
  add('resume education highest level', education.highest_level);
  if (Array.isArray(parsed.skills) && parsed.skills.length) {
    add('resume skills', [...new Set(parsed.skills.map((skill) => String(skill).trim()).filter(Boolean))].slice(0, 2).join(', '), 'multi-select');
  }
  return entries;
}

/**
 * Load + cache Apply Wizz client; merge into profile for the run.
 */
export async function hydrateProfileFromApplyWizz(profile = {}, opts = {}) {
  const cfg = resolveApplyWizzConfig();
  if (!cfg.configured) return profile;

  const id = cfg.id;
  if (profile._applyWizzHydrated && cache?.id === id) {
    return profile;
  }

  try {
    if (!cache || cache.id !== id) {
      if (!hydrateInFlight) {
        hydrateInFlight = (async () => {
          let data;
          let cachedResumeProfile = null;
          let cachedAnswers = [];
          let loadedFromSupabase = false;
          let degreeClassification = null;
          if (isSupabaseConfigured()) {
            try {
              const snapshot = await loadSupabaseClientSnapshot(id);
              if (snapshot) {
                const stored = snapshot.client;
                degreeClassification = stored.degree_classification || null;
                data = {
                  client: {
                    full_name: stored.client_name || [stored.first_name, stored.last_name].filter(Boolean).join(' '),
                    company_email: stored.company_email || '',
                    resume_url: stored.resume_url || '',
                  },
                  additional_information: {
                    primary_phone: stored.mobile_number || '',
                    university_name: stored.university_or_school || '',
                    highest_education: stored.degree || stored.education || '',
                    main_subject: stored.field_of_study || '',
                    graduation_year: stored.graduation_year || '',
                    cumulative_gpa: stored.gpa || '',
                    experience: '',
                    role: stored.latest_job_title || '',
                    resume_url: stored.resume_url || '',
                    latest_company: stored.latest_company || '',
                    location: stored.latest_job_location || '',
                    from_date: stored.work_from || '',
                    to_date: stored.work_to || '',
                    currently_working: stored.currently_working,
                  },
                };
                cachedAnswers = snapshot.answers || [];
                loadedFromSupabase = true;
                console.log(`  ✓ Supabase client cache loaded for ${id} (${snapshot.answers.length} answers)`);

                // Also fetch Apply Wizz API in parallel — Supabase clients table does NOT store address/state/zip.
                // Merge API address/contact fields as base; non-empty Supabase values always win.
                try {
                  const apiData = await fetchApplyWizzClient();
                  const ai = apiData.additional_information || {};
                  const ac = apiData.client || {};
                  const mergeApiField = (field, apiValue) => {
                    if (!data.additional_information[field] && apiValue && apiValue !== '+') {
                      data.additional_information[field] = apiValue;
                    }
                  };
                  const mergeClientField = (field, apiValue) => {
                    if (!data.client[field] && apiValue) data.client[field] = apiValue;
                  };
                  mergeApiField('full_address', ai.full_address);
                  mergeApiField('state_of_residence', ai.state_of_residence);
                  mergeApiField('zip_or_country', ai.zip_or_country);
                  mergeApiField('primary_phone', ai.primary_phone);
                  mergeApiField('experience', ai.experience != null ? String(ai.experience) : '');
                  mergeApiField('linked_in_url', ai.linked_in_url || ac.linked_in_url);
                  mergeApiField('eligible_to_work_in_us', ai.eligible_to_work_in_us);
                  mergeApiField('authorized_without_visa', ai.authorized_without_visa);
                  mergeApiField('require_future_sponsorship', ai.require_future_sponsorship);
                  mergeApiField('gender', ai.gender);
                  mergeApiField('is_hispanic_latino', ai.is_hispanic_latino);
                  mergeApiField('race_ethnicity', ai.race_ethnicity);
                  mergeApiField('veteran_status', ai.veteran_status);
                  mergeApiField('disability_status', ai.disability_status);
                  mergeApiField('desired_start_date', ai.desired_start_date);
                  mergeApiField('willing_to_relocate', ai.willing_to_relocate);
                  mergeApiField('github_url', ai.github_url);
                  mergeApiField('date_of_birth', ai.date_of_birth);
                  mergeClientField('full_name', ac.full_name);
                  mergeClientField('personal_email', ac.personal_email);
                  mergeClientField('applywizz_id', ac.applywizz_id);
                  mergeClientField('visa_type', ac.visa_type);
                  mergeClientField('sponsorship', ac.sponsorship);
                  mergeClientField('salary_range', ac.salary_range);
                  mergeClientField('location_preferences', ac.location_preferences);
                  mergeClientField('job_role_preferences', ac.job_role_preferences);
                  mergeClientField('work_auth_details', ac.work_auth_details);
                  // Use API callable_phone only if Supabase mobile_number was empty
                  if (!stored.mobile_number && ac.callable_phone && ac.callable_phone !== '+') {
                    data.additional_information.primary_phone = ac.callable_phone;
                  }
                } catch (apiErr) {
                  console.log(`  ℹ️  Apply Wizz API supplemental fetch skipped: ${apiErr.message?.slice(0, 80)}`);
                }
              }
            } catch (err) {
              console.log(`  ⚠️  Supabase client cache unavailable: ${err.message?.slice(0, 100) || err}`);
            }
          }
          if (!data) {
            console.log(`  🌐 Apply Wizz API — loading client ${id}...`);
            data = await fetchApplyWizzClient();
          }
          const overlay = mapApplyWizzToProfile(data.client || {}, data.additional_information || {});
          const qaIndex = buildApplyWizzQaIndex(data.client || {}, data.additional_information || {});
          const apiQaIndex = { ...qaIndex };
          for (const row of cachedAnswers) {
            if (row?.question_normalized && row?.answer && Number(row.confidence_score ?? 1) >= 0.70) {
              qaIndex[row.question_normalized] = String(row.answer);
            }
          }
          if (isSupabaseConfigured() && !loadedFromSupabase) {
            try {
              const storedAnswers = await loadSupabaseAnswers(id);
              for (const row of storedAnswers) {
                if (row?.question_normalized && row?.answer && Number(row.confidence_score ?? 1) >= 0.70) {
                  qaIndex[row.question_normalized] = String(row.answer);
                }
              }
              console.log(`  ✓ Supabase answer memory loaded: ${storedAnswers.length} answer(s)`);
            } catch (err) {
              console.log(`  ⚠️  Supabase answer load skipped: ${err.message?.slice(0, 100) || err}`);
            }
          }
          cache = {
            id,
            overlay,
            apiQaIndex,
            qaIndex,
            clientContext: sanitizedClientContext(data.client || {}, data.additional_information || {}),
            fetchedAt: new Date().toISOString(),
            loadedFromSupabase,
            cachedResumeProfile,
            degreeClassification,
          };
          console.log(`  ✓ Apply Wizz loaded: ${overlay.personal?.first_name || ''} ${overlay.personal?.last_name || ''} | ${Object.keys(qaIndex).length} Q&A keys`);
        })().finally(() => {
          hydrateInFlight = null;
        });
      }
      await hydrateInFlight;
    }

    // Supabase is the shared answer source of truth for this client. Keep any
    // local values, but let the hydrated Supabase/API index take precedence.
    profile._applyWizzQa = { ...(profile._applyWizzQa || {}), ...(cache.qaIndex || {}) };
    profile._applyWizzId = cache.id;
    profile._degreeClassification = cache.degreeClassification || null;
    // In-memory only: gives the final LLM fallback the complete client context,
    // while excluding credentials/tokens. It is not written to profile.yml.
    profile._applyWizzClientContext = cache.clientContext || {};

    const o = cache.overlay;
    const { mergeApplyWizzContact, mergeNonEmpty } = await import('./clientContact.mjs');
    profile.personal = mergeNonEmpty(profile.personal || {}, o.personal || {});
    mergeApplyWizzContact(profile, o.personal || {});
    if (profile.personal) {
      const { normalizePersonalNames } = await import('./personName.mjs');
      profile.personal = normalizePersonalNames(profile.personal);
    }
    profile.work_auth = { ...(profile.work_auth || {}), ...(o.work_auth || {}) };
    profile.eeo = { ...(profile.eeo || {}), ...(o.eeo || {}) };
    profile.experience = {
      ...(profile.experience || {}),
      ...(o.experience || {}),
      // Prefer Apply Wizz years when present — source of truth for numeric experience Qs.
      years: o.experience?.years || profile.experience?.years || '',
    };
    if (Array.isArray(o._applyWizzAlternateRoles)) {
      profile._applyWizzAlternateRoles = o._applyWizzAlternateRoles;
    }
    if (Array.isArray(o._applyWizzWorkPreferences)) {
      profile._applyWizzWorkPreferences = o._applyWizzWorkPreferences;
    }
    profile.education = {
      ...(o.education || {}),
      ...(profile.education || {}),
      ...(o.education?.degree ? { degree: o.education.degree } : {}),
      ...(o.education?.major ? { major: o.education.major } : {}),
      ...(o.education?.to_year ? { to_year: o.education.to_year } : {}),
    };
    profile.education.university = cache.qaIndex?.['school or university'] || 'Other';
    if (!profile.personal?.phone) {
      const storedPhone = cache.qaIndex?.phone || cache.qaIndex?.primary_phone || '';
      if (storedPhone) profile.personal.phone = storedPhone;
    }
    if (o.compensation) profile.compensation = o.compensation;
    if (o.compensation_hourly) profile.compensation_hourly = o.compensation_hourly;
    if (o._resumeUrl) profile._resumeUrl = o._resumeUrl;
    if (o._desiredStartDate) profile._desiredStartDate = o._desiredStartDate;

    profile.qa_answers = profile.qa_answers || {};
    const { isApiOnlyAnswerMode } = await import('./apiOnlyProfile.mjs');
    if (!isApiOnlyAnswerMode()) {
      for (const [k, v] of Object.entries(cache.qaIndex || {})) {
        if (!profile.qa_answers[k]) profile.qa_answers[k] = v;
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Apply Wizz API skipped: ${formatHttpError(err)}`);
    console.log('     Answers will fall through to profile.yml / LLM until a later retry succeeds');
    return profile;
  }

  if (isSupabaseConfigured()) {
    try {
      await hydrateSupabaseAnswers(profile);
      const personal = profile.personal || {};
      const education = profile.education || {};
      const experience = profile.experience || {};
      await upsertSupabaseClient({
        applywizzId: profile._applyWizzId,
        clientName: [personal.first_name, personal.last_name].filter(Boolean).join(' ').trim(),
        firstName: personal.first_name || '',
        lastName: personal.last_name || '',
        mobileNumber: profile._generatedPhone ? '' : (personal.phone || ''),
        companyEmail: personal.company_email || resolveCompanyEmail(personal, [personal.first_name, personal.last_name].filter(Boolean).join(' ')),
        resumeUrl: profile._resumeUrl || '',
        education: education.highest_level || education.degree || '',
        universityOrSchool: education.university || 'Other',
        degree: normalizeDegreeForStorage(education.degree || ''),
        fieldOfStudy: education.major || '',
        graduationYear: education.to_year || '',
        gpa: education.gpa || '',
        skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 2) : [],
        latestCompany: experience.current_company || '',
        latestJobTitle: experience.current_title || '',
        latestJobLocation: experience.location || '',
        currentlyWorking: typeof experience.currently_working === 'boolean' ? experience.currently_working : null,
        workFrom: experience.from_date || '',
        workTo: experience.currently_working ? '' : (experience.to_date || ''),
      });
      if (cache?.apiQaIndex) {
        const saved = await upsertSupabaseAnswers(profile._applyWizzId, Object.entries(cache.apiQaIndex).map(([questionNormalized, answer]) => ({
          question: questionNormalized,
          questionNormalized,
          answer,
          source: 'applywizz',
        })));
        if (saved) console.log(`  ✓ Supabase API answers stored for ${profile._applyWizzId}`);
      }
    } catch (err) {
      console.log(`  ⚠️  Supabase client/API answer save skipped: ${err.message?.slice(0, 160) || err}`);
    }
  }

  try {
    const { ensureClientResumeFromApplyWizz, parseClientResumeText } = await import('./applyWizzResume.mjs');
    const { parseResumeProfile } = await import('./resumeParser.mjs');
    let parsed = cache?.cachedResumeProfile || null;
    await ensureClientResumeFromApplyWizz(profile).catch(() => {});
    if (profile._resumeText) {
      parsed = parseResumeProfile(profile._resumeText);
    } else if (!parsed) {
      await parseClientResumeText(profile);
      parsed = parseResumeProfile(profile._resumeText || '');
    } else {
      profile._resumeProfile = parsed;
      profile._resumeParsed = true;
    }
    if (parsed.education?.degree || parsed.education?.major || parsed.education?.university) {
      profile.education = {
        ...(profile.education || {}),
        ...parsed.education,
        university: profile.education?.university || parsed.education?.university || cache.qaIndex?.['school or university'] || 'Other',
      };
    }
    if (profile.education) {
      profile.education.university = profile.education.university || cache.qaIndex?.['school or university'] || 'Other';
    }
    if (Array.isArray(parsed.skills) && parsed.skills.length) {
      profile.skills = [...new Set([...(profile.skills || []), ...parsed.skills.map((skill) => String(skill).trim()).filter(Boolean)])].slice(0, 2);
    }
    if (parsed.experience?.current_title || parsed.experience?.current_company) {
      profile.experience = { ...(profile.experience || {}), ...parsed.experience };
    }
    // Normalize existing phone (strip non-digits, remove US country code prefix)
    if (profile.personal?.phone) profile.personal.phone = String(profile.personal.phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    // If API did not provide a phone number, attempt to extract one from resume text
    if (!profile.personal?.phone && profile._resumeText) {
      const { inferAnswerFromResume } = await import('./resumeParser.mjs');
      const phoneFromResume = inferAnswerFromResume('phone number', profile._resumeText, {});
      if (phoneFromResume) {
        profile.personal = profile.personal || {};
        profile.personal.phone = phoneFromResume;
        console.log(`  📞 Phone extracted from resume for ${profile._applyWizzId}: ${phoneFromResume}`);
      }
    }
    if (isSupabaseConfigured() && opts?.dryRun !== true) {
      const resumeEntries = buildResumeAnswerEntries(parsed);
      if (resumeEntries.length) {
        const saved = await upsertSupabaseAnswers(profile._applyWizzId, resumeEntries);
        if (saved) console.log(`  ✓ Supabase resume facts stored for ${profile._applyWizzId} (${resumeEntries.length} rows)`);
      }
    }
    if (isSupabaseConfigured() && opts?.dryRun !== true) {
      try {
        const personal = profile.personal || {};
        const education = profile.education || {};
        const experience = profile.experience || {};
        await upsertSupabaseClient({
          applywizzId: profile._applyWizzId,
          clientName: [personal.first_name, personal.last_name].filter(Boolean).join(' ').trim(),
          firstName: personal.first_name || '',
          lastName: personal.last_name || '',
          mobileNumber: profile._generatedPhone ? '' : (personal.phone || ''),
          companyEmail: personal.company_email || resolveCompanyEmail(personal, [personal.first_name, personal.last_name].filter(Boolean).join(' ')),
          resumeUrl: profile._resumeUrl || '',
          education: education.highest_level || education.degree || '',
          universityOrSchool: education.university || 'Other',
          degree: normalizeDegreeForStorage(education.degree || ''),
          fieldOfStudy: education.major || '',
          graduationYear: education.to_year || '',
          gpa: education.gpa || '',
          mobileNumber: profile._generatedPhone ? '' : (personal.phone || ''),
          skills: parsed.skills || [],
          latestCompany: experience.current_company || '',
          latestJobTitle: experience.current_title || '',
          latestJobLocation: experience.location || '',
          currentlyWorking: typeof experience.currently_working === 'boolean' ? experience.currently_working : null,
          workFrom: experience.from_date || '',
          workTo: experience.currently_working ? '' : (experience.to_date || ''),
        });
        console.log(`  ✓ Supabase client profile stored for ${profile._applyWizzId}`);
      } catch (err) {
        console.log(`  ⚠️  Supabase resume save skipped: ${err.message?.slice(0, 160) || err}`);
      }
    }
    // ─── Temp-file cleanup: remove the downloaded PDF immediately after parsing ───
    // For application runs, engine.mjs calls cleanupClientResume() after submission.
    // During bulk sync / hydration-only runs there is no submission step, so we
    // clean up the file here to avoid accumulating PDFs on disk.
    if (profile._isBulkSync) {
      const { cleanupClientResume } = await import('./applyWizzResume.mjs');
      await cleanupClientResume(profile).catch(() => {});
    }
  } catch (err) {
    console.log(`  ⚠️  Apply Wizz resume parse skipped: ${err.message?.slice(0, 160) || err}`);
  }

  profile._applyWizzHydrated = true;
  return profile;
}

const DEFAULT_SAVE_QA_URL = 'https://www.apply-wizz.me/api/save-client-qa';
const savedApplyWizzQaKeys = new Set();

/** @returns {string} */
export function resolveApplyWizzSaveQaUrl() {
  return String(process.env.APPLYWIZZ_SAVE_QA_URL || DEFAULT_SAVE_QA_URL).trim();
}

function applyWizzSaveAuthHeaders() {
  const key = String(process.env.APPLYWIZZ_API_KEY || process.env.APPLYWIZZ_AUTH_TOKEN || '').trim();
  if (!key) return {};
  return { Authorization: `Bearer ${key}`, 'X-API-Key': key };
}

/**
 * Update in-memory Apply Wizz Q&A so later questions reuse without another API round-trip.
 * @param {object} profile
 * @param {string} rawLabel
 * @param {string} answer
 */
export function mergeApplyWizzQaInMemory(profile = {}, rawLabel = '', answer = '') {
  const norm = normalizeLabel(stripWorkdayQuestionLabel(rawLabel));
  if (!profile || !norm || answer == null || answer === '') return;
  profile._applyWizzQa = profile._applyWizzQa || {};
  profile._applyWizzQa[norm] = String(answer);
  if (cache?.qaIndex && cache.id === profile._applyWizzId) {
    cache.qaIndex[norm] = String(answer);
  }
}

/**
 * Persist a new Workday Q&A pair to the Apply Wizz client record (API-only persistence).
 * @param {object} profile
 * @param {{ label?: string, question?: string, answer: string, fieldType?: string, options?: string[], source?: string, jobUrl?: string, company?: string }} entry
 * @returns {Promise<{ ok: boolean, skipped?: string, status?: number }>}
 */
export async function saveApplyWizzClientAnswer(profile = {}, entry = {}) {
  const applyWizzConfigured = isApplyWizzConfigured();
  if (!applyWizzConfigured && !profile._applyWizzId) return { ok: false, skipped: 'not_configured' };

  const id = String(profile._applyWizzId || resolveApplyWizzConfig().id || '').trim();
  const label = String(entry.label || entry.question || '').trim();
  const answer = entry.answer == null ? '' : String(entry.answer).trim();
  if (!id || !label || !answer) return { ok: false, skipped: 'missing_fields' };

  const norm = normalizeLabel(stripWorkdayQuestionLabel(label));
  const dedupeKey = `${id}:${norm}`;
  if (profile._applyWizzQa?.[norm] === answer) {
    return { ok: true, skipped: 'unchanged' };
  }
  if (savedApplyWizzQaKeys.has(dedupeKey)) {
    mergeApplyWizzQaInMemory(profile, label, answer);
    return { ok: true, skipped: 'duplicate_session' };
  }

  const personal = profile.personal || {};
  const clientName = [personal.first_name, personal.last_name].filter(Boolean).join(' ').trim();

  const body = {
    applywizz_id: id,
    question: label,
    question_normalized: norm,
    answer,
    field_type: entry.fieldType || entry.field_type || '',
    options: Array.isArray(entry.options) ? entry.options.slice(0, 40) : [],
    source: entry.source || 'llm',
    job_url: entry.jobUrl || profile._jobUrl || '',
    company: entry.company || profile._company || '',
    client_name: clientName,
  };

  if (isSupabaseConfigured()) {
    try {
      await upsertSupabaseAnswer({
        applywizzId: id,
        question: label,
        questionNormalized: norm,
        answer,
        fieldType: body.field_type,
        options: body.options,
        source: body.source,
        unknownQuestion: body.source === 'llm',
        llmModel: process.env.OPENROUTER_MODEL || '',
        jobUrl: body.job_url,
        company: body.company,
      });
      console.log(`    💾 Supabase client_questions ← "${label.slice(0, 45)}" = "${answer.slice(0, 40)}"`);
      recordSupabaseAnswerInMemory(profile, label, answer);
    } catch (err) {
      console.log(`  ⚠️  Supabase answer save skipped: ${err.message?.slice(0, 100) || err}`);
    }
  }

  if (!applyWizzConfigured || profile._applyWizzSaveDisabled || String(process.env.APPLYWIZZ_SAVE_QA || '1') === '0') {
    mergeApplyWizzQaInMemory(profile, label, answer);
    return { ok: true, skipped: applyWizzConfigured ? 'save_disabled' : 'applywizz_not_configured' };
  }

  const url = resolveApplyWizzSaveQaUrl();
  try {
    const res = await httpsJsonWithRetry({
      url,
      method: 'POST',
      timeoutMs: 25000,
      headers: applyWizzSaveAuthHeaders(),
      body,
    }, { attempts: 2, label: 'Apply Wizz save Q&A' });

    mergeApplyWizzQaInMemory(profile, label, answer);

    if (!res.ok) {
      if (res.status === 405 || res.status === 404) {
        profile._applyWizzSaveDisabled = true;
        console.log(`  ⚠️  Apply Wizz Q&A save endpoint returned ${res.status} — disabled for this run (answers kept in-memory only)`);
      } else {
        console.log(`  ⚠️  Apply Wizz Q&A save HTTP ${res.status}: ${String(res.text || '').slice(0, 120)} (cached in-memory for this run)`);
      }
      return { ok: false, status: res.status };
    }
    savedApplyWizzQaKeys.add(dedupeKey);
    console.log(`    💾 Apply Wizz client DB ← "${label.slice(0, 45)}" = "${answer.slice(0, 40)}"`);
    return { ok: true };
  } catch (err) {
    mergeApplyWizzQaInMemory(profile, label, answer);
    console.log(`  ⚠️  Apply Wizz Q&A save failed: ${formatHttpError(err)} (cached in-memory for this run)`);
    return { ok: false, skipped: 'network' };
  }
}

/** Semantic lookup across Apply Wizz Q&A index (exact → concept → substring → fuzzy). */
export function lookupApplyWizzAnswer(label, profile, { threshold = 0.52 } = {}) {
  const qa = profile?._applyWizzQa;
  if (!qa || typeof qa !== 'object') return null;
  const stripped = stripWorkdayQuestionLabel(label);
  const norm = normalizeLabel(stripped || label);
  if (!norm) return null;

  if (qa[norm]) return { answer: qa[norm], source: 'applywizz_exact', score: 1 };

  const concept = matchAnswerConcept(label) || matchAnswerConcept(stripped);
  if (concept) {
    const fromConcept = lookupConceptInQaMap(qa, concept);
    if (fromConcept) {
      return { answer: fromConcept, source: 'applywizz_concept', score: 0.96, matchedKey: concept.id };
    }
  }

  // Open-ended / essay prompts must not fuzzy-steal short profile facts (e.g. job title).
  // Yes/No relocate-style questions stay exact/concept/fuzzy even when the label is long.
  const looksYesNo = /^(have|has|had|are|is|was|were|do|does|did|will|would|can|could|should|may)\b/i
    .test(String(label || '').trim());
  const isOpenEnded = !looksYesNo && (
    norm.length > 55
    || /^(briefly|describe|explain|tell us|please describe|please explain|why (are|do|would)|cover letter|which of the following)/i.test(String(label || '').trim())
  );
  if (!isOpenEnded) {
    for (const [key, answer] of Object.entries(qa)) {
      if (!answer || key.length < 10) continue;
      if (norm.includes(key) || key.includes(norm)) {
        return { answer: String(answer), source: 'applywizz_substring', score: 0.78, matchedKey: key };
      }
    }
  }

  if (isOpenEnded) return null;

  let best = null;
  let bestScore = 0;
  const fuzzyThreshold = Math.max(threshold, 0.52);
  for (const [key, answer] of Object.entries(qa)) {
    if (!answer) continue;
    const score = fuzzyScore(norm, key);
    if (score > bestScore) {
      bestScore = score;
      best = { answer: String(answer), source: 'applywizz_fuzzy', score, matchedKey: key };
    }
  }
  if (best && bestScore >= fuzzyThreshold) return best;
  return null;
}

/**
 * Playwright DOM question → Apply Wizz client API (primary answer source).
 * Tries primary label, alternate DOM label candidates, and nearby element text.
 * Aligns API text to live dropdown/radio options when present.
 *
 * @param {string} label — question text from DOM
 * @param {object} profile — hydrated via hydrateProfileFromApplyWizz
 * @param {{ options?: string[], fieldType?: string, threshold?: number, extraTexts?: string[] }} [opts]
 * @returns {{ answer: string, source: string }|null}
 */
export function resolveDomQuestionFromApplyWizz(label, profile, opts = {}) {
  if (!label || !profile) return null;
  const options = opts.options || [];

  const candidates = [];
  const push = (raw) => {
    const t = stripWorkdayQuestionLabel(String(raw || '').replace(/\s+/g, ' ').trim());
    if (!t || t.length < 2) return;
    if (candidates.some((c) => c.toLowerCase() === t.toLowerCase())) return;
    candidates.push(t);
  };

  push(label);
  for (const extra of opts.extraTexts || []) push(extra);

  // Pull question-like snippets from long container text (e.g. richText + help copy)
  for (const extra of opts.extraTexts || []) {
    const text = String(extra || '');
    if (text.length < 20 || text.length > 600) continue;
    const qm = text.match(/([^.!?]{8,160}\?)/);
    if (qm) push(qm[1]);
  }

  for (const q of candidates) {
    const hit = lookupApplyWizzAnswer(q, profile, { threshold: opts.threshold ?? 0.48 });
    if (hit?.answer) {
      const aligned = alignAnswerToWorkdayOptions(hit.answer, options, opts.fieldType);
      if (aligned) return { answer: aligned, source: hit.source || 'applywizz' };
    }
  }

  for (const q of candidates) {
    const fromConcept = resolveByConcept(q, profile);
    if (fromConcept?.answer && /concept_applywizz|concept_profile/.test(fromConcept.source)) {
      const aligned = alignAnswerToWorkdayOptions(fromConcept.answer, options, opts.fieldType);
      if (aligned) return { answer: aligned, source: fromConcept.source };
    }
  }

  return null;
}
