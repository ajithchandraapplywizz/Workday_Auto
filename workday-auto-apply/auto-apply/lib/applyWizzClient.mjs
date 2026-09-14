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

const DEFAULT_API_BASE = 'https://www.apply-wizz.me/api/get-client-details';

let cache = null;

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

function splitName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first_name: parts[0] || '', last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function parseAddress(fullAddress = '') {
  const parts = String(fullAddress || '').split(',').map((p) => p.trim()).filter(Boolean);
  return {
    address_line1: parts[0] || '',
    city: parts.length >= 3 ? parts[parts.length - 3] : parts[1] || '',
    state: parts.length >= 2 ? parts[parts.length - 2].replace(/\d.*/, '').trim() : '',
    postal_code: (parts[parts.length - 2]?.match(/\d{5}/) || [])[0] || '',
    country: parts[parts.length - 1] || 'United States of America',
  };
}

function boolYesNo(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 'Yes';
  if (value === false || value === 'false' || value === 0 || value === '0') return 'No';
  return null;
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
  if (info.veteran_status) {
    put('veteran status', info.veteran_status);
    put('please select the veteran status which most accurately describes how you identify yourself', info.veteran_status);
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
  const schoolName = String(info.university_name || '').trim();
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
  put('visa type', client.visa_type || '');
  put('linkedin', info.linked_in_url || '');
  put('github', info.github_url || '');
  put('role', info.role || (client.job_role_preferences || [])[0] || '');
  put('job title', info.role || (client.job_role_preferences || [])[0] || '');
  put('current title', info.role || (client.job_role_preferences || [])[0] || '');
  put('phone', info.primary_phone && info.primary_phone !== '+' ? info.primary_phone : '');
  put('email', client.personal_email || client.company_email || info.email || '');

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
    put('date of birth', dob);
    put('birth date', dob);
  }

  if (info.full_address) {
    const addr = parseAddress(info.full_address);
    put('address line 1', addr.address_line1);
    put('city', addr.city);
    put('state', addr.state);
    put('postal code', addr.postal_code);
    put('country', addr.country);
  }

  return qa;
}

/** Map API payload → profile.yml-shaped overlay (does not overwrite education Workday defaults). */
export function mapApplyWizzToProfile(client = {}, info = {}) {
  const names = splitName(client.full_name || '');
  const addr = parseAddress(info.full_address || '');
  const startDate = isoToMMDDYYYY(info.desired_start_date) || getTodayMMDDYYYY('Asia/Kolkata');

  return {
    personal: {
      first_name: names.first_name,
      last_name: names.last_name,
      email: client.personal_email || client.company_email || info.email || '',
      phone: info.primary_phone && info.primary_phone !== '+' ? info.primary_phone : undefined,
      linkedin: info.linked_in_url || '',
      city: addr.city || (client.location_preferences || [])[0] || '',
      state: addr.state || info.state_of_residence || '',
      postal_code: addr.postal_code || '',
      address_line1: addr.address_line1 || '',
      country: addr.country || info.zip_or_country || 'United States of America',
      source: info.how_did_you_hear || client.source || '',
      date_of_birth: info.date_of_birth || '',
    },
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
      ...(info.veteran_status ? { veteran_status: info.veteran_status } : {}),
      ...(info.disability_status ? { disability_status: info.disability_status } : {}),
    },
    experience: {
      current_title: info.role || (client.job_role_preferences || [])[0] || '',
      years: info.experience != null && info.experience !== '' ? String(info.experience) : '',
    },
    education: {
      university: String(info.university_name || '').trim(),
      degree: info.highest_education || '',
      major: info.main_subject || '',
      field_of_study_hierarchy: info.main_subject ? [info.main_subject] : [],
      highest_level: info.highest_education || '',
      gpa: info.cumulative_gpa || '',
      to_year: info.graduation_year || '',
    },
    compensation: parseSalaryMid(client.salary_range),
    compensation_hourly: parseHourlyMid(client.salary_range),
    _applyWizzId: client.applywizz_id || getApplyWizzId(),
    _resumeUrl: info.resume_url || info.resume_path || '',
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

/**
 * Load + cache Apply Wizz client; merge into profile for the run.
 */
export async function hydrateProfileFromApplyWizz(profile = {}) {
  const cfg = resolveApplyWizzConfig();
  if (!cfg.configured) return profile;

  const id = cfg.id;
  if (profile._applyWizzHydrated && cache?.id === id) {
    return profile;
  }

  try {
    if (!cache || cache.id !== id) {
      console.log(`  🌐 Apply Wizz API — loading client ${id}...`);
      const data = await fetchApplyWizzClient();
      const overlay = mapApplyWizzToProfile(data.client || {}, data.additional_information || {});
      const qaIndex = buildApplyWizzQaIndex(data.client || {}, data.additional_information || {});
      cache = {
        id,
        overlay,
        qaIndex,
        clientContext: sanitizedClientContext(data.client || {}, data.additional_information || {}),
        fetchedAt: new Date().toISOString(),
      };
      console.log(`  ✓ Apply Wizz loaded: ${overlay.personal?.first_name || ''} ${overlay.personal?.last_name || ''} | ${Object.keys(qaIndex).length} Q&A keys`);
    }

    profile._applyWizzQa = { ...(cache.qaIndex || {}), ...(profile._applyWizzQa || {}) };
    profile._applyWizzId = cache.id;
    // In-memory only: gives the final LLM fallback the complete client context,
    // while excluding credentials/tokens. It is not written to profile.yml.
    profile._applyWizzClientContext = cache.clientContext || {};

    const o = cache.overlay;
    profile.personal = { ...(o.personal || {}), ...(profile.personal || {}) };
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
      ...(o.education?.university ? { university: o.education.university } : {}),
      ...(o.education?.degree ? { degree: o.education.degree } : {}),
      ...(o.education?.major ? { major: o.education.major } : {}),
      ...(o.education?.to_year ? { to_year: o.education.to_year } : {}),
    };
    if (o.compensation) profile.compensation = o.compensation;
    if (o.compensation_hourly) profile.compensation_hourly = o.compensation_hourly;
    if (o._resumeUrl) profile._resumeUrl = o._resumeUrl;
    if (o._desiredStartDate) profile._desiredStartDate = o._desiredStartDate;

    profile.qa_answers = profile.qa_answers || {};
    for (const [k, v] of Object.entries(cache.qaIndex || {})) {
      if (!profile.qa_answers[k]) profile.qa_answers[k] = v;
    }
  } catch (err) {
    console.log(`  ⚠️  Apply Wizz API skipped: ${formatHttpError(err)}`);
    console.log('     Answers will fall through to profile.yml / LLM until a later retry succeeds');
    return profile;
  }

  profile._applyWizzHydrated = true;
  return profile;
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
