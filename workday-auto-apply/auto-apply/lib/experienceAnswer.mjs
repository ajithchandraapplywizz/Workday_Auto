/**
 * experienceAnswer.mjs — Answer years / describe-experience questions from the
 * full client profile (Apply Wizz + YAML + skills + role), not from invented LLM text.
 *
 * Rules (required by product):
 * - Numeric / "how many years" → years from profile when topic matches experience; else 0
 * - Word / describe prompts → short factual blurb when topic matches; else NA
 * - Never answer years questions with Yes/No
 */

import { normalizeLabel } from './qaStore.mjs';

const STOP = new Set([
  'how', 'many', 'years', 'year', 'of', 'do', 'you', 'have', 'your', 'the', 'a', 'an',
  'to', 'in', 'on', 'for', 'with', 'and', 'or', 'is', 'are', 'was', 'were', 'be',
  'worked', 'used', 'built', 'familiar', 'proficient', 'experienced',
  'this', 'that', 'these', 'those', 'please', 'indicate', 'number', 'related',
  'using', 'use', 'level', 'expertise', 'experience', 'exp', 'work', 'working',
  'position', 'role', 'job', 'applicant', 'application', 'briefly', 'describe',
  'explain', 'tell', 'us', 'about', 'any', 'some', 'total', 'overall', 'professional',
  'possess', 'minimum', 'listed', 'description', 'field', 'area', 'industry',
]);

/** Tokens that never imply a specific domain by themselves. */
const WEAK_TOPIC = new Set([
  'related', 'position', 'role', 'job', 'professional', 'overall', 'total',
  'general', 'relevant', 'required', 'listed', 'possess', 'indicate',
]);

/**
 * @param {string} label
 * @returns {boolean}
 */
export function isYearsQuantityQuestion(label = '') {
  const text = String(label || '');
  if (!text) return false;
  if (/^(are you|do you|have you|will you|did you)\b/i.test(text.trim())
    && !/how many years/i.test(text)) {
    // Yes/No experience questions are not numeric-year fields.
    if (!/\bhow many\b/i.test(text)) return false;
  }
  return /(how\s*many\s*years|years?\s*(of\s*)?(experience|exp)\b|number\s+of\s+years|indicate\s+the\s+number\s+of\s+years)/i
    .test(text);
}

/**
 * Free-text “describe your experience…” prompts (not Yes/No, not numeric years).
 * @param {string} label
 * @returns {boolean}
 */
export function isDescribeExperienceQuestion(label = '') {
  const text = String(label || '');
  if (!text) return false;
  if (isYearsQuantityQuestion(text)) return false;
  return /(briefly\s+describe|please\s+describe|describe\s+your\s+experience|tell\s+us\s+about|why\s+are\s+you\s+looking|level\s+of\s+expertise|explain\s+your\s+experience|if\s+so,?\s+briefly|do\s+you\s+have\s+.{0,80}experience|which\s+of\s+the\s+following\s+areas)/i
    .test(text);
}

/**
 * Job-posting confirmation dropdowns ("Would you like to proceed?").
 * @param {string} label
 * @returns {boolean}
 */
export function isProceedQuestion(label = '') {
  return /would you like to proceed|do you (wish|want) to proceed|wish to continue|want to continue with this/i
    .test(String(label || ''));
}

/**
 * Generic “total years of experience” (no domain) — safe to use profile years directly.
 * @param {string} label
 * @returns {boolean}
 */
export function isGenericTotalYearsQuestion(label = '') {
  const text = String(label || '');
  if (!isYearsQuantityQuestion(text)) return false;
  // "years … related to this position/role/job" → use total profile years.
  if (/related\s+to\s+(this\s+)?(position|role|job|requisition)/i.test(text)) return true;
  if (/years?\s+(of\s+)?(professional\s+)?(work\s+)?experience\s*(do\s*you\s*have)?\s*\??$/i.test(text.trim())) {
    return true;
  }
  const domain = extractTopicTokens(text).filter((t) => !WEAK_TOPIC.has(t));
  return domain.length === 0;
}

/**
 * @param {string} label
 * @returns {string[]}
 */
export function extractTopicTokens(label = '') {
  const raw = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = raw.split(' ')
    .map((t) => t.replace(/\.js$/i, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  // Drop pure quantity scaffolding leftovers
  return [...new Set(tokens.filter((t) => !/^(many|much|least|minimum|maximum)$/.test(t)))];
}

/**
 * @param {object} profile
 * @returns {{ years: number, yearsText: string, corpus: string, role: string, skills: string[], summary: string }}
 */
export function buildExperienceContext(profile = {}) {
  const exp = profile.experience || {};
  const aw = profile._applyWizzQa || {};
  const personal = profile.personal || {};

  const yearsRaw = exp.years
    || aw[normalizeLabel('years of experience')]
    || aw[normalizeLabel('experience years')]
    || profile.qa_answers?.[normalizeLabel('years of experience')]
    || '0';
  const yearsMatch = String(yearsRaw).match(/(\d+(?:\.\d+)?)/);
  const years = yearsMatch ? Number(yearsMatch[1]) : 0;
  const yearsText = Number.isFinite(years) ? String(Math.max(0, Math.round(years))) : '0';

  const skills = [
    ...(Array.isArray(profile.skills) ? profile.skills : []),
    ...(Array.isArray(exp.skills) ? exp.skills : []),
  ].map((s) => String(s || '').trim()).filter(Boolean);

  const role = String(
    exp.current_title
    || aw[normalizeLabel('role')]
    || aw[normalizeLabel('job title')]
    || '',
  ).trim();

  const company = String(exp.current_company || '').trim();
  const description = String(exp.description || profile.qa_answers?.[normalizeLabel('role description')] || '').trim();
  const alternate = Array.isArray(profile._applyWizzAlternateRoles)
    ? profile._applyWizzAlternateRoles.join(' ')
    : '';

  const corpus = [
    role,
    company,
    description,
    skills.join(' '),
    alternate,
    String(profile._llmProfileBrief || ''),
    personal.city || '',
  ].join(' ').toLowerCase().replace(/\s+/g, ' ').trim();

  const summary = [
    yearsText !== '0' ? `${yearsText} years professional experience` : 'limited professional experience',
    role ? `as ${role}` : '',
    skills.length ? `skills: ${skills.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean).join(' — ');

  return { years, yearsText, corpus, role, skills, summary, description };
}

/**
 * True when the question’s domain tokens appear in the applicant corpus.
 * @param {string} label
 * @param {{ corpus: string, role: string, skills: string[] }} ctx
 * @returns {boolean}
 */
export function topicMatchesExperience(label, ctx) {
  if (isGenericTotalYearsQuestion(label)) return true;

  const tokens = extractTopicTokens(label).filter((t) => !WEAK_TOPIC.has(t));
  if (!tokens.length) return true; // generic total-years / generic describe

  const corpus = String(ctx?.corpus || '').toLowerCase();
  if (!corpus) return false;

  let hits = 0;
  for (const token of tokens) {
    if (corpus.includes(token)) hits += 1;
    else if (token.length >= 5 && [...corpus.matchAll(/[a-z0-9+#.]{3,}/g)].some((m) => {
      const w = m[0];
      return w.includes(token) || token.includes(w);
    })) {
      hits += 0.75;
    }
  }

  // Strong single domain hit (e.g. "python", "smartsheet") or ≥40% of tokens.
  if (hits >= 1 && tokens.length <= 2) return true;
  return hits / tokens.length >= 0.4;
}

/**
 * Invalid answers for years questions (e.g. fuzzy-matched Yes/No).
 * @param {string} answer
 * @returns {boolean}
 */
export function isInvalidYearsAnswer(answer = '') {
  const a = String(answer || '').trim();
  if (!a) return true;
  if (/^(yes|no|y|n|true|false)$/i.test(a)) return true;
  if (/^n\/?a$/i.test(a)) return false; // allowed only for word prompts; callers decide
  return false;
}

/**
 * Pick a dropdown bucket for a numeric years value.
 * @param {number} years
 * @param {string[]} options
 * @returns {string|null}
 */
export function pickYearsOption(years, options = []) {
  const list = (options || []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!list.length) return null;

  const y = Math.max(0, Number(years) || 0);
  const scored = list.map((opt) => {
    const lower = opt.toLowerCase();
    if (/^(none|no experience|n\/?a|not applicable)$/i.test(opt) && y === 0) return { opt, score: 100 };
    if (/^0$|^none$/i.test(opt) && y === 0) return { opt, score: 99 };

    const range = lower.match(/(\d+)\s*[-–to]+\s*(\d+)/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (y >= lo && y <= hi) return { opt, score: 90 };
      return { opt, score: Math.max(0, 40 - Math.min(Math.abs(y - lo), Math.abs(y - hi))) };
    }
    const plus = lower.match(/(\d+)\s*\+/);
    if (plus) {
      const lo = Number(plus[1]);
      if (y >= lo) return { opt, score: 88 };
      return { opt, score: Math.max(0, 30 - (lo - y)) };
    }
    const exact = lower.match(/\b(\d+)\b/);
    if (exact) {
      const n = Number(exact[1]);
      if (n === y) return { opt, score: 95 };
      return { opt, score: Math.max(0, 50 - Math.abs(n - y) * 8) };
    }
    if (/less than\s*1|under\s*1|< ?1/i.test(lower) && y < 1) return { opt, score: 85 };
    return { opt, score: 0 };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].opt : list.find((o) => /^0\b|none|no experience/i.test(o)) || list[0];
}

/**
 * Resolve years / describe-experience answers from the analysed profile.
 * @param {string} label
 * @param {object} profile
 * @param {{ options?: string[], fieldType?: string }} [opts]
 * @returns {{ answer: string, source: string, matched: boolean }|null}
 */
export function resolveExperienceQuestionAnswer(label, profile = {}, opts = {}) {
  const text = String(label || '').trim();
  if (!text) return null;

  const yearsQ = isYearsQuantityQuestion(text);
  const describeQ = isDescribeExperienceQuestion(text);
  if (!yearsQ && !describeQ) return null;

  const ctx = buildExperienceContext(profile);
  const matched = topicMatchesExperience(text, ctx);
  const options = (opts.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const wantsWords = describeQ
    || /describe|briefly|explain|tell us|write|narrative|paragraph/i.test(text)
    || (opts.fieldType && /textarea/i.test(opts.fieldType));

  if (yearsQ && !wantsWords) {
    const yearsValue = matched ? ctx.years : 0;
    if (options.length) {
      const picked = pickYearsOption(yearsValue, options);
      return {
        answer: picked || String(yearsValue),
        source: matched ? 'experience_years_match' : 'experience_years_zero',
        matched,
      };
    }
    return {
      answer: String(Math.max(0, Math.round(yearsValue))),
      source: matched ? 'experience_years_match' : 'experience_years_zero',
      matched,
    };
  }

  // Word / describe prompts
  if (matched && (ctx.description || ctx.role || ctx.summary)) {
    const blurb = ctx.description
      || `${ctx.role || 'Professional'} with ${ctx.yearsText} years of experience${ctx.skills.length ? ` in ${ctx.skills.slice(0, 5).join(', ')}` : ''}.`;
    return {
      answer: String(blurb).replace(/\s+/g, ' ').trim().slice(0, 500),
      source: 'experience_describe_match',
      matched: true,
    };
  }

  return {
    answer: profileBackedEssay(text, profile),
    source: 'experience_describe_profile',
    matched: false,
  };
}

/**
 * Honest required-essay text from the Apply Wizz / YAML profile when the
 * question domain is not in the applicant's skills (never leave the box empty).
 * @param {string} label
 * @param {object} profile
 * @returns {string}
 */
export function profileBackedEssay(label = '', profile = {}) {
  const ctx = buildExperienceContext(profile);
  const role = ctx.role || 'software professional';
  const years = ctx.yearsText && ctx.yearsText !== '0' ? ctx.yearsText : 'several';
  const skills = (ctx.skills || []).slice(0, 6).join(', ');
  const summary = ctx.summary || ctx.description || '';
  if (/why\s+are\s+you\s+looking/i.test(label)) {
    return `I am looking for a new ${role} role that better matches my skills${skills ? ` in ${skills}` : ''} and the next step in my career. I have ${years} years of experience and want to apply that background on a team where I can contribute immediately.`.slice(0, 800);
  }
  const honest = `I do not have direct day-to-day experience in the specific area this question asks about. My background is ${years} years as ${role}${skills ? `, working with ${skills}` : ''}. ${summary}`.replace(/\s+/g, ' ').trim();
  return honest.slice(0, 800);
}

/**
 * Sanitize a stored/fuzzy answer for years questions (reject Yes/No).
 * @param {string} label
 * @param {string} answer
 * @param {object} profile
 * @param {{ options?: string[], fieldType?: string }} [opts]
 * @returns {string}
 */
export function sanitizeExperienceAnswer(label, answer, profile = {}, opts = {}) {
  if (!isYearsQuantityQuestion(label) && !isDescribeExperienceQuestion(label)) {
    return answer;
  }
  if (isYearsQuantityQuestion(label) && isInvalidYearsAnswer(answer)) {
    return resolveExperienceQuestionAnswer(label, profile, opts)?.answer ?? '0';
  }
  if (isDescribeExperienceQuestion(label) && /^(yes|no|na|n\/a)$/i.test(String(answer || '').trim())) {
    return profileBackedEssay(label, profile);
  }
  return answer;
}
