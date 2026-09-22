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
  if (hourly) {
    if (profile.compensation_hourly) return String(profile.compensation_hourly);
    const hourlyFromQa = qaGet(profile, 'hourly wage', 'hourly rate', 'hourly compensation', 'hourly');
    if (hourlyFromQa) {
      const m = hourlyFromQa.match(/(\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }
    const unwrapComp = (val) => {
      if (val == null) return null;
      if (typeof val === 'object') return val.target || val.amount || val.value || val.annual || null;
      return val;
    };
    const annualRaw = unwrapComp(profile.compensation)
      || profile.target_salary
      || profile.expected_salary
      || qaGet(profile, 'salary', 'compensation', 'target compensation', 'desired compensation');
    if (annualRaw) {
      const numMatch = String(annualRaw).replace(/,/g, '').match(/(\d{4,7})/);
      if (numMatch) {
        const annualNum = Number(numMatch[1]);
        if (annualNum > 1000) {
          return String(Math.round(annualNum / 2080));
        }
      }
    }
    if (profile._supabaseQa) {
      for (const [k, v] of Object.entries(profile._supabaseQa)) {
        if (/compensation|salary/i.test(k) && !/hourly/i.test(k) && v) {
          const numMatch = String(v).replace(/,/g, '').match(/(\d{4,7})/);
          if (numMatch) {
            const annualNum = Number(numMatch[1]);
            if (annualNum > 1000) return String(Math.round(annualNum / 2080));
          }
        }
      }
    }
    return '';
  }

  const unwrapComp = (val) => {
    if (val == null) return null;
    if (typeof val === 'object') return val.target || val.amount || val.value || val.annual || null;
    return val;
  };
  const annual = unwrapComp(profile.compensation)
    || profile.target_salary
    || profile.expected_salary
    || qaGet(profile, 'salary', 'compensation', 'target compensation', 'desired compensation');
  if (annual != null && String(annual).trim()) return String(annual).trim();

  if (profile._supabaseQa) {
    for (const [k, v] of Object.entries(profile._supabaseQa)) {
      if (/compensation|salary/i.test(k) && v) {
        return String(v).trim();
      }
    }
  }
  return '';
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
