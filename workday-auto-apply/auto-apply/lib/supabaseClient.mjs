/** Supabase REST client for the server-side ApplyWizz answer store. */

import { httpsJsonWithRetry } from './httpClient.mjs';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { normalizeLabel } from './qaStore.mjs';
import { fuzzyScore, tokenSetRatio } from './fields.mjs';
import { alignAnswerToWorkdayOptions, stripWorkdayQuestionLabel, resolveCompanyEmail } from './applyWizzClient.mjs';
import { trace } from './trace.mjs';

let envLoaded = false;

export function loadLocalEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(process.cwd(), '.env'), resolve(moduleDir, '..', '.env')];
  const envPath = candidates.find((path) => existsSync(path));
  if (!envPath) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
  }
}

function config() {
  loadLocalEnvOnce();
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

export function isSupabaseConfigured() {
  return config().configured;
}

async function request(path, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
  const { url, key } = config();
  if (!url || !key) return null;
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/${path}${query}`,
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body,
    timeoutMs: 20000,
  }, { attempts: 2, label: 'Supabase' });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${String(res.text || '').slice(0, 180)}`);
  if (!res.text) return null;
  return res.json();
}

function encode(value) {
  return encodeURIComponent(String(value ?? ''));
}

const ANSWER_COLUMNS = new Map([
  ['how did you hear about us', 'how_did_you_hear_about_us'],
  ['school or university', 'school_or_university'],
  ['university', 'school_or_university'],
  ['school', 'school_or_university'],
  ['college', 'school_or_university'],
  ['degree', 'degree'],
  ['highest level of education', 'degree'],
  ['highest education', 'degree'],
  ['field of study', 'field_of_study'],
  ['major', 'field_of_study'],
  ['gpa', 'gpa'],
  ['cumulative gpa', 'gpa'],
  ['graduation year', 'graduation_year'],
  ['year of graduation', 'graduation_year'],
  ['years of experience', 'years_of_experience'],
  ['experience years', 'years_of_experience'],
  ['desired salary', 'desired_salary'],
  ['salary expectation', 'desired_salary'],
  ['available to start', 'available_to_start'],
  ['desired start date', 'available_to_start'],
  ['visa sponsorship', 'visa_sponsorship'],
  ['sponsorship', 'visa_sponsorship'],
  ['require sponsorship', 'visa_sponsorship'],
  ['authorized to work', 'work_authorization'],
  ['legally authorized to work', 'work_authorization'],
]);

function answerColumn(questionNormalized = '') {
  const key = String(questionNormalized || '').trim();
  if (ANSWER_COLUMNS.has(key)) return ANSWER_COLUMNS.get(key);
  if (/sponsor|visa sponsorship|immigration sponsorship/i.test(key)) return 'visa_sponsorship';
  if (/authorized to work|work authorization|legally authorized/i.test(key)) return 'work_authorization';
  return '';
}

/** Stable key for unknown questions stored in the per-client JSONB object. */
export function normalizeAnswerKey(question = '') {
  const normalized = String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const column = answerColumn(normalized);
  if (column) return column;
  return normalized
    .replace(/^(do you|are you|have you|will you|can you|please|what is|what are|which)?\s+/i, '')
    .replace(/\s+/g, '_')
    .slice(0, 100) || 'unknown_question';
}

const ANSWER_SOURCES = new Set(['profile', 'resume', 'api', 'ai', 'database', 'default']);

function normalizeAnswerSource(source = '') {
  const value = String(source || '').toLowerCase();
  if (value === 'applywizz' || value.startsWith('applywizz_')) return 'api';
  if (value.startsWith('experience/') || value === 'resume') return 'resume';
  if (value.startsWith('llm') || value.includes('openrouter') || value === 'ai') return 'ai';
  if (value.includes('profile')) return 'profile';
  if (value === 'cache' || value.includes('memory') || value.includes('db')) return 'database';
  if (ANSWER_SOURCES.has(value)) return value;
  return 'ai';
}

function answerConfidence(source = '') {
  const normalized = normalizeAnswerSource(source);
  return {
    profile: 1.00,
    api: 1.00,
    resume: 0.98,
    database: 0.95,
    default: 0.70,
    ai: 0.92,
  }[normalized];
}

function normalizeFieldType(fieldType = '') {
  const value = String(fieldType || '').toLowerCase();
  if (/textarea|essay|description/.test(value)) return 'textarea';
  if (/checkbox|multi/.test(value)) return 'checkbox';
  if (/radio/.test(value)) return 'radio';
  if (/date|month|year/.test(value)) return 'date';
  if (/file|upload/.test(value)) return 'file';
  if (/dropdown|select|searchable|typeahead|combobox/.test(value)) return 'dropdown';
  if (/input|text|number|phone|email/.test(value)) return 'input';
  return 'unknown';
}

export async function loadSupabaseAnswers(applywizzId) {
  if (!isSupabaseConfigured() || !applywizzId) return [];
  return await request('client_questions', {
    query: `?applywizz_id=eq.${encode(applywizzId)}&select=question_raw,question_normalized,answer,answer_source,confidence_score,field_type,options&order=updated_at.desc`,
  }) || [];
}

export async function loadSupabaseClientSnapshot(applywizzId) {
  if (!isSupabaseConfigured() || !applywizzId) return null;
  const [clients, answers] = await Promise.all([
    request('clients', { query: `?applywizz_id=eq.${encode(applywizzId)}&select=*&limit=1` }),
    loadSupabaseAnswers(applywizzId),
  ]);
  const client = clients?.[0] || null;
  if (!client) return null;
  return { client, answers: answers || [] };
}

export async function upsertSupabaseClient({
  applywizzId,
  clientName = '',
  firstName = '',
  lastName = '',
  mobileNumber = '',
  companyEmail = '',
  resumeUrl = '',
  education = '',
  universityOrSchool = '',
  degree = '',
  fieldOfStudy = '',
  graduationYear = '',
  gpa = '',
  skills = [],
  latestCompany = '',
  latestJobTitle = '',
  latestJobLocation = '',
  currentlyWorking = null,
  workFrom = '',
  workTo = '',
} = {}) {
  if (!isSupabaseConfigured() || !applywizzId) return false;
  const body = {
    applywizz_id: String(applywizzId),
    updated_at: new Date().toISOString(),
  };
  const setText = (column, value) => {
    if (value != null && String(value).trim()) body[column] = String(value).trim();
  };
  setText('client_name', clientName);
  setText('first_name', firstName);
  setText('last_name', lastName);
  setText('mobile_number', mobileNumber);
  // Only ever write a verified @applywizard.ai / @applywizz.ai email.
  // resolveCompanyEmail() will derive one from the client name if the API field is empty.
  // If even the derivation yields nothing, do NOT fall back to a personal email.
  const resolvedCompanyEmail = resolveCompanyEmail({
    company_email: companyEmail,
    first_name: firstName,
    last_name: lastName,
  }, clientName || [firstName, lastName].filter(Boolean).join(' '));
  if (resolvedCompanyEmail) setText('company_email', resolvedCompanyEmail);
  setText('resume_url', resumeUrl);
  setText('education', education);
  setText('university_or_school', universityOrSchool);
  setText('degree', degree);
  setText('field_of_study', fieldOfStudy);
  setText('graduation_year', graduationYear);
  setText('gpa', gpa);
  setText('latest_company', latestCompany);
  setText('latest_job_title', latestJobTitle);
  setText('latest_job_location', latestJobLocation);
  setText('work_from', workFrom);
  if (workTo) setText('work_to', workTo);
  if (typeof currentlyWorking === 'boolean') {
    body.currently_working = currentlyWorking;
    if (currentlyWorking) body.work_to = null;
  }
  if (Array.isArray(skills) && skills.length) body.skills = skills.slice(0, 2);
  await request('clients', {
    method: 'POST',
    query: '?on_conflict=applywizz_id',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body,
  });
  return true;
}

export async function upsertSupabaseAnswer({
  applywizzId,
  question,
  questionNormalized,
  answer,
  fieldType = '',
  options = [],
  source = 'llm',
  unknownQuestion = false,
  llmModel = '',
  jobUrl = '',
  company = '',
} = {}) {
  if (!isSupabaseConfigured() || !applywizzId || !questionNormalized || !answer) return false;
  return await upsertSupabaseAnswers(applywizzId, [{
    question: question || questionNormalized,
    questionNormalized,
    answer,
    fieldType,
    options,
    source,
    unknownQuestion,
    llmModel,
    jobUrl,
    company,
  }]);
}

export async function upsertSupabaseAnswers(applywizzId, entries = []) {
  if (!isSupabaseConfigured() || !applywizzId || !Array.isArray(entries) || !entries.length) return false;
  const now = new Date().toISOString();
  const rows = entries.filter((entry) => entry?.questionNormalized && entry?.answer).map((entry) => ({
    applywizz_id: String(applywizzId),
    question_raw: String(entry.question || entry.questionNormalized).replace(/\s+/g, ' ').trim(),
    question_normalized: String(entry.questionNormalized).replace(/\s+/g, ' ').trim().toLowerCase(),
    answer: String(entry.answer),
    answer_source: normalizeAnswerSource(entry.source),
    confidence_score: answerConfidence(entry.source),
    field_type: normalizeFieldType(entry.fieldType),
    options: Array.isArray(entry.options) ? entry.options.slice(0, 40) : [],
    updated_at: now,
  }));
  if (!rows.length) return false;
  await request('client_questions', {
    method: 'POST',
    query: '?on_conflict=applywizz_id%2Cquestion_normalized',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: rows,
  });
  return true;
}

export async function upsertSupabaseApplication({
  applywizzId,
  jobUrl,
  company = '',
  roleTitle = '',
  status = 'started',
  failureReason = '',
} = {}) {
  if (!isSupabaseConfigured() || !applywizzId || !jobUrl) return false;
  const cleanUrl = String(jobUrl).trim()
    .replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '')
    .replace(/%2C/gi, ',');
  const normalizedStatus = ['started', 'in_progress', 'submitted', 'failed', 'skipped'].includes(status)
    ? status
    : (status === 'ready_for_review' || status === 'needs_manual_verification' || status === 'review-pending-confirmation'
        ? 'in_progress'
        : (status === 'incomplete' || status === 'error'
            ? 'failed'
            : (status === 'review-declined' || status === 'review_declined' ? 'skipped' : 'started')));
  const row = {
    applywizz_id: String(applywizzId),
    job_url: cleanUrl,
    company: company || null,
    role_title: roleTitle || null,
    status: normalizedStatus,
    failure_reason: failureReason || null,
    updated_at: new Date().toISOString(),
  };
  if (normalizedStatus === 'submitted') row.submitted_at = new Date().toISOString();
  try {
    await request('applications', {
      method: 'POST',
      query: '?on_conflict=applywizz_id%2Cjob_url',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: row,
    });
  } catch (err) {
    if (!/42P10|unique or exclusion constraint/i.test(String(err.message || ''))) throw err;

    // Older deployments may have the table but not the unique pair constraint.
    const existing = await request('applications', {
      query: `?applywizz_id=eq.${encode(applywizzId)}&job_url=eq.${encode(cleanUrl)}&select=id&limit=1`,
    });
    if (existing?.[0]?.id) {
      await request('applications', {
        method: 'PATCH',
        query: `?id=eq.${encode(existing[0].id)}`,
        prefer: 'return=minimal',
        body: row,
      });
    } else {
      await request('applications', {
        method: 'POST',
        prefer: 'return=minimal',
        body: row,
      });
    }
  }
  return true;
}

/**
 * Check if the candidate has an existing application recorded for this company in Supabase.
 * @param {string} applywizzId
 * @param {string} companyName
 * @returns {Promise<boolean>}
 */
export async function hasClientAppliedToCompany(applywizzId, companyName) {
  if (!isSupabaseConfigured() || !applywizzId || !companyName) return false;
  try {
    const cleanCompany = String(companyName).trim();
    const res = await request('applications', {
      query: `?applywizz_id=eq.${encode(applywizzId)}&company=ilike.${encode(cleanCompany)}&select=id,status&limit=10`,
    });
    if (Array.isArray(res) && res.length > 0) {
      const valid = res.some((r) => r.status === 'submitted' || r.status === 'in_progress');
      return valid || res.length > 0;
    }
    return false;
  } catch (err) {
    console.log(`  ⚠️  Supabase hasClientAppliedToCompany query error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

/**
 * Hydrate Supabase answers into profile._supabaseQa and profile._supabaseAnswers.
 * @param {object} profile
 * @returns {Promise<object>}
 */
export async function hydrateSupabaseAnswers(profile = {}) {
  if (!isSupabaseConfigured()) return profile;
  const id = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.client_id
    || process.env.APPLYWIZZ_ID
    || ''
  ).trim();
  if (!id) return profile;

  try {
    const answers = await loadSupabaseAnswers(id);
    profile._supabaseAnswers = answers || [];
    profile._supabaseQa = profile._supabaseQa || {};
    for (const row of (answers || [])) {
      if (row.question_normalized && row.answer) {
        profile._supabaseQa[row.question_normalized] = String(row.answer);
      }
      if (row.question_raw && row.answer) {
        const rawNorm = normalizeLabel(row.question_raw);
        if (rawNorm && !profile._supabaseQa[rawNorm]) {
          profile._supabaseQa[rawNorm] = String(row.answer);
        }
      }
    }
    profile._supabaseHydrated = true;
    console.log(`  ✓ Loaded ${profile._supabaseAnswers.length} cached answer(s) from Supabase for ${id}`);
  } catch (err) {
    console.log(`  ⚠️  Supabase answers hydration failed: ${err.message?.slice(0, 120) || err}`);
  }
  return profile;
}

/**
 * Record a newly answered question into in-memory profile._supabaseQa immediately.
 */
export function recordSupabaseAnswerInMemory(profile = {}, rawLabel = '', answer = '') {
  if (!profile || !rawLabel || answer == null || answer === '') return;
  const stripped = stripWorkdayQuestionLabel(rawLabel);
  const norm = normalizeLabel(stripped || rawLabel);
  if (!norm) return;
  profile._supabaseQa = profile._supabaseQa || {};
  profile._supabaseQa[norm] = String(answer);
}

/**
 * Synchronous lookup against profile._supabaseQa with concept, substring, and fuzzy matching.
 */
export function lookupSupabaseAnswerSync(rawLabel, profile = {}, opts = {}) {
  const qa = profile?._supabaseQa;
  if (!qa || typeof qa !== 'object') return null;
  const stripped = stripWorkdayQuestionLabel(rawLabel);
  const norm = normalizeLabel(stripped || rawLabel);
  if (!norm) return null;

  const options = opts.options || [];
  const fieldType = opts.fieldType || '';
  const threshold = opts.threshold || 0.52;

  const align = (val) => {
    if (!options.length) return val;
    return alignAnswerToWorkdayOptions(val, options, fieldType) || val;
  };

  const clientId = profile?._applyWizzId || profile?.applywizz_id || profile?.client_id || process.env.APPLYWIZZ_ID || '';
  const tenant = opts.tenant || profile?._tenant || '';
  const totalCachedRows = Object.keys(qa).length;

  // Helper to validate and return Tier 1 hits
  const acceptHit = (hitAnswer, matchType, score, matchedKey = '') => {
    // Stop generic keys like "years of experience" from answering specific technology or domain questions
    if (/years of experience|total years/i.test(matchedKey) && /(python|java|react|node|aws|cloud|backend|distributed|database|sql|docker|kubernetes|c\+\+|golang|ruby|c#|\.net)/i.test(norm)) {
      trace({
        stage: 'tier1',
        clientId,
        tenant,
        query: norm,
        rowsReturned: totalCachedRows,
        hit: false,
        rejectionReason: 'generic_key_mismatch_for_tech',
        matchedKey,
      });
      return null;
    }

    const aligned = align(hitAnswer);
    // (3) Reject any Tier 1 match whose answer isn't one of the live options for select/radio
    if (options.length > 0 && /select|radio|dropdown|combobox/i.test(fieldType)) {
      const existsInOptions = options.some(opt => {
        const o = String(opt).trim().toLowerCase();
        const a = String(aligned).trim().toLowerCase();
        return o === a || o.includes(a) || a.includes(o);
      });
      if (!existsInOptions) {
        trace({
          stage: 'tier1',
          clientId,
          tenant,
          query: norm,
          rowsReturned: totalCachedRows,
          hit: false,
          rejectionReason: 'answer_not_in_options',
          rawAnswer: hitAnswer,
          alignedAnswer: aligned,
          options,
        });
        return null;
      }
    }

    const res = { answer: aligned, source: `supabase_${matchType}`, score, rawAnswer: hitAnswer, matchedKey };
    trace({
      stage: 'tier1',
      clientId,
      tenant,
      query: norm,
      rowsReturned: totalCachedRows,
      hit: true,
      matchType,
      matchedKey,
      score,
      answer: res.answer,
    });
    return res;
  };

  // 1. Exact normalized match
  if (qa[norm]) {
    const hit = acceptHit(qa[norm], 'exact', 1);
    if (hit) return hit;
  }
  if (stripped && qa[normalizeLabel(stripped)]) {
    const hit = acceptHit(qa[normalizeLabel(stripped)], 'exact_stripped', 1);
    if (hit) return hit;
  }

  // 2. High-value concept matching
  if (/veteran/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /veteran/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_veteran', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/gender|sex/i.test(norm) && !/orientation/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /^(gender|sex|please select your gender)$/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_gender', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/hispanic|latino/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /hispanic|latino/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_hispanic', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/\b(race|ethnicity)\b/i.test(norm) && !/hispanic|latino/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /\b(race|ethnicity)\b/i.test(k) && !/hispanic|latino/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_race', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/permanent.*unrestricted\s+right\s+to\s+work|unrestricted\s+right\s+to\s+work|permanent\s+resident|right to work/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /authori[sz]ed to work|legally authori[sz]ed|work authori[sz]ation/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_work_auth_unrestricted', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/acknowledge.*truthfully|select\s*['"]?yes['"]?\s*if\s*you\s*acknowledge/i.test(norm)) {
    const hit = acceptHit('Yes', 'concept_acknowledge', 0.98, 'acknowledgement');
    if (hit) return hit;
  }
  if (/authori[sz]ed to work|legally authori[sz]ed|eligible to work/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /authori[sz]ed to work|legally authori[sz]ed|work authori[sz]ation/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_work_auth', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/sponsor|visa sponsorship/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /sponsorship|visa sponsorship/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_sponsorship', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/salary|compensation|pay|wage/i.test(norm) && !/hourly/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /desired compensation|desired salary|salary expectation|compensation/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_salary', 0.96, key);
      if (hit) return hit;
    }
  }
  if (/available to start|when can you start|when are you available|desired start date/i.test(norm)) {
    const key = Object.keys(qa).find((k) => /available to start|when are you available to start|desired start date|when can you start/i.test(k) && qa[k]);
    if (key) {
      const hit = acceptHit(qa[key], 'concept_start_date', 0.96, key);
      if (hit) return hit;
    }
  }

  // 3. Substring match (non-essay)
  const looksOpenEssay = /^(briefly|describe|explain|tell us|please describe|please explain|why (are|do|would)|cover letter)/i.test(norm);
  const isOpenEnded = looksOpenEssay && norm.length > 80;
  const GENERIC_SUBSTR_KEYS = new Set(['company', 'education', 'university', 'school', 'degree', 'major', 'location', 'title', 'job title', 'current title', 'experience', 'country', 'name', 'phone']);
  if (!isOpenEnded) {
    for (const [key, answer] of Object.entries(qa)) {
      if (!answer || key.length < 8) continue;
      // Disallow overly generic keys from answering longer specific questions via substring
      if (GENERIC_SUBSTR_KEYS.has(key.toLowerCase().trim())) continue;
      if (norm.length > key.length * 2.5 && key.split(/\s+/).length <= 2) continue;
      if (norm.includes(key) || key.includes(norm)) {
        const hit = acceptHit(answer, 'substring', 0.85, key);
        if (hit) return hit;
      }
    }
  }

  // 4. Fuzzy match & Candidate tracking
  const candidates = [];
  const fuzzyThreshold = Math.max(threshold, 0.52);

  if (!isOpenEnded) {
    for (const [key, answer] of Object.entries(qa)) {
      if (!answer || key.length < 6) continue;
      if (key === 'country' && norm.length > 25) continue;
      const score = fuzzyScore(norm, key);
      candidates.push({ key, answer, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    const top3 = candidates.slice(0, 3).map((c) => ({ key: c.key, score: Number(c.score.toFixed(3)) }));
    const best = candidates[0] || null;

    if (best && best.score >= fuzzyThreshold) {
      const hit = acceptHit(best.answer, 'fuzzy', best.score, best.key);
      if (hit) return hit;
    }

    // (2) Fallback: Token Set Ratio >= 85 check
    let bestTokenSet = null;
    let bestTokenScore = 0;
    for (const [key, answer] of Object.entries(qa)) {
      if (!answer || key.length < 6) continue;
      if (key === 'country' && norm.length > 25) continue;
      const tsScore = tokenSetRatio(norm, key);
      if (tsScore > bestTokenScore) {
        bestTokenScore = tsScore;
        bestTokenSet = { key, answer, tsScore };
      }
    }

    if (bestTokenSet && bestTokenScore >= 85) {
      const hit = acceptHit(bestTokenSet.answer, 'token_set_ratio', bestTokenScore / 100, bestTokenSet.key);
      if (hit) return hit;
    }

    // Trace rejection / miss details
    trace({
      stage: 'tier1',
      clientId,
      tenant,
      query: norm,
      rowsReturned: totalCachedRows,
      hit: false,
      threshold: fuzzyThreshold,
      topCandidates: top3,
      tokenSetTopScore: bestTokenScore,
      rejectionReason: totalCachedRows === 0 ? 'no_rows' : (best && best.score < fuzzyThreshold ? 'below_threshold' : 'no_candidates'),
    });
  } else {
    trace({
      stage: 'tier1',
      clientId,
      tenant,
      query: norm,
      rowsReturned: totalCachedRows,
      hit: false,
      rejectionReason: 'open_ended_essay',
    });
  }

  return null;
}



/**
 * Async lookup: loads Supabase cache if needed, then sync-looks up answer.
 */
export async function lookupSupabaseAnswer(rawLabel, profile = {}, opts = {}) {
  if (!isSupabaseConfigured() || !rawLabel) return null;
  if (!profile?._supabaseQa || !profile._supabaseHydrated) {
    await hydrateSupabaseAnswers(profile);
  }
  return lookupSupabaseAnswerSync(rawLabel, profile, opts);
}

/**
 * Canonical URL for job templates: removes sub-paths and tracking parameters.
 */
export function canonicalJobPostingUrl(rawUrl = '') {
  if (!rawUrl) return '';
  let url = String(rawUrl).trim().replace(/%2C/gi, ',');
  try {
    const u = new URL(url);
    let pathname = u.pathname
      .replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '')
      .replace(/\/+$/, '');
    return `${u.origin}${pathname}`;
  } catch {
    return url.split('?')[0]
      .replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '')
      .replace(/\/+$/, '');
  }
}

/**
 * Loads a cached job form schema from Supabase job_form_schemas table.
 * @param {string} jobUrl
 * @returns {Promise<object|null>}
 */
export async function loadJobFormSchema(jobUrl) {
  if (!isSupabaseConfigured() || !jobUrl) return null;
  const canonical = canonicalJobPostingUrl(jobUrl);
  try {
    const rows = await request('job_form_schemas', {
      query: `?canonical_job_url=eq.${encode(canonical)}&select=*&limit=1`,
    });
    return rows?.[0] || null;
  } catch (err) {
    console.log(`  ⚠️  loadJobFormSchema query error: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * Persists a newly scanned or verified job form schema to Supabase.
 */
export async function upsertJobFormSchema({
  jobUrl,
  tenant = '',
  company = '',
  roleTitle = '',
  atsType = 'workday',
  fieldsSchema = [],
  stepNames = [],
  scannedByApplywizzId = '',
} = {}) {
  if (!isSupabaseConfigured() || !jobUrl) return false;
  const canonical = canonicalJobPostingUrl(jobUrl);
  const now = new Date().toISOString();
  const body = {
    canonical_job_url: canonical,
    tenant: tenant || null,
    company: company || null,
    role_title: roleTitle || null,
    ats_type: atsType || 'workday',
    fields_schema: Array.isArray(fieldsSchema) ? fieldsSchema : [],
    step_names: Array.isArray(stepNames) ? stepNames : [],
    total_fields: Array.isArray(fieldsSchema) ? fieldsSchema.length : 0,
    scanned_by_applywizz_id: scannedByApplywizzId || null,
    updated_at: now,
  };

  try {
    await request('job_form_schemas', {
      method: 'POST',
      query: '?on_conflict=canonical_job_url',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body,
    });
    return true;
  } catch (err) {
    console.log(`  ⚠️  upsertJobFormSchema error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

/**
 * Batch Queue Methods for Multi-Client 3-Worker Pipeline
 */
export async function ingestCsvToBatchQueue(items = [], { chunkSize = 250 } = {}) {
  if (!isSupabaseConfigured() || !Array.isArray(items) || !items.length) return { inserted: 0 };
  const rows = items
    .filter((it) => (it?.applywizzId || it?.applywizz_id) && (it?.jobUrl || it?.job_url))
    .map((it) => ({
      applywizz_id: String(it.applywizzId || it.applywizz_id).trim(),
      candidate_email: it.candidateEmail || it.candidate_email ? String(it.candidateEmail || it.candidate_email).trim() : null,
      job_url: String(it.jobUrl || it.job_url).trim(),
      company: it.company ? String(it.company).trim() : null,
      role_title: it.roleTitle || it.role_title ? String(it.roleTitle || it.role_title).trim() : null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  if (!rows.length) return { inserted: 0 };

  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      await request('batch_job_queue', {
        method: 'POST',
        query: '?on_conflict=applywizz_id%2Cjob_url',
        prefer: 'resolution=ignore-duplicates,return=minimal',
        body: chunk,
      });
      totalInserted += chunk.length;
    } catch (err) {
      console.log(`  ⚠️  ingestCsvToBatchQueue chunk error: ${err.message?.slice(0, 100)}`);
    }
  }

  return { inserted: totalInserted };
}

export async function leaseNextQueueTask(workerId = 'worker-1') {
  if (!isSupabaseConfigured()) return null;
  try {
    const tasks = await request('batch_job_queue', {
      query: `?status=in.(pending,pre_resolved)&order=created_at.asc&limit=1`,
    });
    const task = tasks?.[0];
    if (!task) return null;

    const now = new Date().toISOString();
    const patchBody = {
      status: 'processing',
      worker_id: workerId,
      locked_at: now,
      started_at: now,
      attempts: (task.attempts || 0) + 1,
      updated_at: now,
    };

    const patched = await request('batch_job_queue', {
      method: 'PATCH',
      query: `?id=eq.${encode(task.id)}&status=in.(pending,pre_resolved)`,
      prefer: 'return=representation',
      body: patchBody,
    });

    if (!Array.isArray(patched) || !patched.length) {
      // Optimistic lock contention: another worker leased it first; retry next task
      return await leaseNextQueueTask(workerId);
    }

    return { ...task, ...patched[0] };
  } catch (err) {
    console.log(`  ⚠️  leaseNextQueueTask error for ${workerId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

export async function updateQueueTaskStatus(taskId, {
  status = 'completed',
  errorMessage = null,
  screenshotPath = null,
  preResolvedAnswers = undefined,
} = {}) {
  if (!isSupabaseConfigured() || !taskId) return false;
  const now = new Date().toISOString();
  const body = {
    status,
    updated_at: now,
  };
  if (['submitted', 'reached_review', 'failed', 'skipped'].includes(status)) {
    body.completed_at = now;
  }
  if (errorMessage !== undefined) body.error_message = errorMessage;
  if (screenshotPath !== undefined) body.screenshot_path = screenshotPath;
  if (preResolvedAnswers !== undefined) body.pre_resolved_answers = preResolvedAnswers;

  try {
    await request('batch_job_queue', {
      method: 'PATCH',
      query: `?id=eq.${encode(taskId)}`,
      prefer: 'return=minimal',
      body,
    });
    return true;
  } catch (err) {
    console.log(`  ⚠️  updateQueueTaskStatus error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

export async function getBatchQueueStats() {
  if (!isSupabaseConfigured()) return null;
  try {
    const rows = await request('batch_job_queue', {
      query: '?select=status',
    });
    if (!Array.isArray(rows)) return null;
    const stats = {
      total: rows.length,
      pending: 0,
      processing: 0,
      pre_resolved: 0,
      reached_review: 0,
      submitted: 0,
      failed: 0,
      skipped: 0,
    };
    for (const r of rows) {
      if (stats[r.status] !== undefined) stats[r.status]++;
    }
    return stats;
  } catch (err) {
    return null;
  }
}

/**
 * Returns all 'pending' queue tasks for a specific job URL (excluding tasks that are
 * already processing, pre_resolved, or done). Used by bulkPreResolveForJobUrl.
 */
export async function getPendingQueueTasksForUrl(jobUrl) {
  if (!isSupabaseConfigured() || !jobUrl) return [];
  try {
    const canonical = canonicalJobPostingUrl(jobUrl);
    const rows = await request('batch_job_queue', {
      query: `?job_url=eq.${encode(canonical)}&status=eq.pending&select=id,applywizz_id,job_url,company,role_title`,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.log(`  ⚠️  getPendingQueueTasksForUrl error: ${err.message?.slice(0, 100)}`);
    return [];
  }
}

function isTransientDateQuestion(label = '') {
  const s = String(label || '').toLowerCase();
  return /enter\s+(the|today'?s?)\s*date|today'?s?\s*date|^date:?\s*\*?$|signature\s*date|date\s*(?:of\s*)?signature|date\s*signed/i.test(s);
}

/**
 * Auto-record a verified question & answer to candidate's Supabase cache and in-memory map.
 * De-duplicates so identical existing answers are not re-written.
 * Filters out ephemeral signature dates.
 * Non-blocking / fire-and-forget to keep Playwright loops fast.
 */
export async function autoRecordVerifiedFieldAnswer(profile = {}, field = {}, answer = '', meta = {}) {
  if (!profile || !field || answer == null || String(answer).trim() === '') return false;

  const rawLabel = String(field.label || field.questionId || '').replace(/\s+/g, ' ').trim();
  if (!rawLabel) return false;

  // Filter out ephemeral signature-companion dates
  if (isTransientDateQuestion(rawLabel)) return false;

  const applywizzId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.id
    || process.env.APPLYWIZZ_ID
    || ''
  ).trim();
  if (!applywizzId) return false;

  const stripped = stripWorkdayQuestionLabel(rawLabel);
  const norm = normalizeLabel(stripped || rawLabel);
  if (!norm) return false;

  const answerStr = String(answer).trim();

  // Deduplication check: if in-memory _supabaseQa already has this exact answer, skip DB write
  const existingVal = profile._supabaseQa?.[norm] || profile._supabaseQa?.[normalizeLabel(rawLabel)];
  const isDuplicate = existingVal != null && String(existingVal).trim().toLowerCase() === answerStr.toLowerCase();

  // Always keep in-memory cache current for immediate reuse on later pages/steps
  recordSupabaseAnswerInMemory(profile, rawLabel, answerStr);
  const fullNorm = normalizeLabel(rawLabel);
  if (fullNorm && fullNorm !== norm) {
    recordSupabaseAnswerInMemory(profile, fullNorm, answerStr);
  }

  if (isDuplicate) {
    return true; // Already recorded, no need to write duplicate row
  }

  // Scrape visible options and control type
  const rawOptions = field.options || field._raw?.options || [];
  const options = (Array.isArray(rawOptions) ? rawOptions : [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const fieldType = field.elementType || field.controlType || field.fieldType || 'text';

  // Fire-and-forget asynchronous upsert to Supabase client_questions
  upsertSupabaseAnswer({
    applywizzId,
    question: rawLabel,
    questionNormalized: norm,
    answer: answerStr,
    fieldType,
    options,
    source: meta.source || 'verified',
    jobUrl: meta.jobUrl || profile._currentJobUrl || '',
    company: meta.company || profile._currentCompany || '',
  }).catch(() => {});

  return true;
}
