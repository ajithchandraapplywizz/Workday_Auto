/**
 * profileFacts.mjs — What the Apply Wizz / local profile actually contains.
 * Never logs raw PII. Does not invent missing facts.
 */

import { extractTopicTokens, buildExperienceContext, topicMatchesExperience } from '../experienceAnswer.mjs';
import { isApplyWizzConfigured } from '../applyWizzClient.mjs';

function nonEmpty(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item) => String(item || '').trim());
  return String(value).trim() !== '';
}

function qaGet(profile, ...keys) {
  const maps = [profile?._applyWizzQa, profile?.qa_answers];
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const key of keys) {
      const hit = map[key];
      if (nonEmpty(hit)) return String(hit).trim();
    }
  }
  return '';
}

/**
 * Presence flags only — safe to log.
 * @param {object} profile
 */
export function profileFactPresence(profile = {}) {
  const p = profile.personal || {};
  const w = profile.work_auth || {};
  const e = profile.education || {};
  const x = profile.experience || {};
  const eeo = profile.eeo || {};
  return {
    applyWizzConfigured: isApplyWizzConfigured(),
    applyWizzHydrated: profile._applyWizzHydrated === true,
    name: Boolean(p.first_name || p.last_name || p.full_name),
    email: nonEmpty(p.email),
    phone: nonEmpty(p.phone),
    city: nonEmpty(p.city),
    workAuth: nonEmpty(w.authorized_us),
    sponsorship: nonEmpty(w.sponsorship_needed),
    years: nonEmpty(x.years),
    title: nonEmpty(x.current_title),
    company: nonEmpty(x.current_company),
    degree: nonEmpty(e.degree || e.highest_level),
    school: nonEmpty(e.university),
    major: nonEmpty(e.major),
    salary: nonEmpty(profile.compensation),
    hourly: nonEmpty(profile.compensation_hourly),
    gender: nonEmpty(eeo.gender),
    skills: Array.isArray(profile.skills) ? profile.skills.length : 0,
  };
}

export function explicitWorkAuth(profile = {}) {
  return profile?.work_auth?.authorized_us
    || qaGet(profile, 'authorized to work', 'legally authorized to work')
    || '';
}

export function explicitSponsorship(profile = {}) {
  return profile?.work_auth?.sponsorship_needed
    || qaGet(profile, 'require sponsorship', 'visa sponsorship', 'sponsorship')
    || '';
}

export function explicitYears(profile = {}) {
  const raw = profile?.experience?.years
    || qaGet(profile, 'years of experience', 'experience years');
  const m = String(raw || '').match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

export function explicitEeo(profile = {}, kind = '') {
  const eeo = profile?.eeo || {};
  if (kind === 'gender') return eeo.gender || qaGet(profile, 'gender', 'sex') || '';
  if (kind === 'hispanic') return eeo.hispanic_latino || qaGet(profile, 'hispanic or latino', 'hispanic', 'latino') || '';
  if (kind === 'race') return eeo.race || qaGet(profile, 'race ethnicity', 'race', 'ethnicity') || '';
  if (kind === 'veteran') return eeo.veteran_status || qaGet(profile, 'veteran status', 'veteran') || '';
  if (kind === 'disability') return eeo.disability_status || qaGet(profile, 'disability') || '';
  return '';
}

export function explicitSalary(profile = {}, hourly = false) {
  if (hourly) return profile.compensation_hourly ? String(profile.compensation_hourly) : '';
  return profile.compensation != null ? String(profile.compensation) : '';
}

/**
 * True when the profile corpus mentions the question's technology/topic tokens.
 */
export function profileMentionsTopic(profile, label) {
  const ctx = buildExperienceContext(profile);
  return topicMatchesExperience(label, ctx);
}

export function topicTokens(label) {
  return extractTopicTokens(label);
}

export function applyWizzStatus(profile = {}) {
  const configured = isApplyWizzConfigured();
  return {
    configured,
    hydrated: profile._applyWizzHydrated === true,
    missing: configured
      ? (profile._applyWizzHydrated ? '' : 'Apply Wizz is configured but this run has not hydrated yet')
      : 'Apply Wizz is not configured (set APPLYWIZZ_ID or APPLYWIZZ_API_URL in .env). No endpoint was invented.',
  };
}
