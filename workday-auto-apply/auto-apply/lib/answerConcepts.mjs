/**
 * answerConcepts.mjs — Map Workday label variants to the same fact bucket.
 *
 * "Graduation year" / "When did you graduate" / "Expected graduation" /
 * "Education end year" all resolve to the same stored answer.
 */

function normalizeLabel(label) {
  if (!label) return '';
  return String(label)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Each concept: id + matcher regexes + canonical keys that may exist in
 * Apply Wizz QA / profile.qa_answers / tenant YAML.
 */
export const ANSWER_CONCEPTS = [
  {
    id: 'graduation_year',
    match: [
      /graduat/i,
      /when\s*(did|do|will)\s*you\s*(expect\s*to\s*)?graduat/i,
      /expected\s*(year|date).*graduat/i,
      /education\s*(end|to|completion)\s*(year|date)/i,
      /year\s*(of\s*)?(completion|graduation)/i,
      /degree\s*(completion|conferred).*year/i,
    ],
    keys: ['graduation year', 'education to', 'to year', 'graduated', 'expected graduation'],
    profilePaths: ['education.to_year', 'education.graduation_year'],
  },
  {
    id: 'education_start',
    match: [
      /education\s*(start|from|begin)/i,
      /when\s*(did|do)\s*you\s*(start|begin).*school|college|university|degree/i,
      /attended\s*from/i,
    ],
    keys: ['education from', 'from year', 'school start'],
    profilePaths: ['education.from_year'],
  },
  {
    id: 'degree',
    match: [
      /\bdegree\b/i,
      /highest\s*(level|degree|education)/i,
      /what\s*(degree|level\s*of\s*education)/i,
      /educational\s*(level|qualification|attainment)/i,
    ],
    keys: ['degree', 'highest level of education', 'highest education'],
    profilePaths: ['education.degree', 'education.highest_level'],
  },
  {
    id: 'field_of_study',
    match: [
      /field\s*of\s*study/i,
      /\bmajor\b/i,
      /area\s*of\s*study/i,
      /concentration|discipline|subject\s*studied/i,
      /what\s*did\s*you\s*study/i,
    ],
    keys: ['field of study', 'major', 'main subject'],
    profilePaths: ['education.major'],
  },
  {
    id: 'school',
    match: [
      /school\s*or\s*university/i,
      /\buniversity\b|\bcollege\b|\binstitution\b/i,
      /name\s*of\s*(your\s*)?(school|university|college)/i,
      /where\s*did\s*you\s*(go\s*to\s*school|attend|study)/i,
    ],
    keys: ['school or university', 'university', 'school', 'college'],
    profilePaths: ['education.university'],
  },
  {
    id: 'gpa',
    match: [/\bgpa\b|grade\s*point|cumulative\s*gpa/i],
    keys: ['gpa', 'cumulative gpa'],
    profilePaths: ['education.gpa'],
  },
  {
    id: 'start_date',
    match: [
      /available\s*to\s*start/i,
      /when\s*(are|can)\s*you\s*start/i,
      /desired\s*start/i,
      /earliest\s*start/i,
      /start\s*date/i,
    ],
    keys: [
      'when are you available to start',
      'available to start',
      'desired start date',
      'when can you start',
    ],
    profilePaths: ['_desiredStartDate', 'experience.start_date'],
  },
  {
    id: 'hourly_wage',
    match: [/hourly\s*(wage|rate|pay|comp)|minimum\s+hourly|per\s*hour|wage\s+requirement/i],
    keys: [
      'minimum hourly wage',
      'hourly wage',
      'hourly rate',
      'minimum hourly wage requirement',
    ],
    profilePaths: ['compensation_hourly'],
  },
  {
    id: 'salary',
    match: [
      /salary|compensation|pay\s*expect|desired\s*(pay|comp|amount)|remuneration/i,
    ],
    keys: [
      'desired salary',
      'desired compensation',
      'salary expectation',
      'compensation',
      'what is your desired compensation',
    ],
    profilePaths: ['compensation', 'salary', 'experience.desired_salary'],
  },
  {
    id: 'work_auth',
    match: [
      /authorized\s*to\s*work|legally\s*authorized|eligible\s*to\s*work|work\s*authorization|right\s*to\s*work/i,
    ],
    keys: ['authorized to work', 'legally authorized to work'],
    profilePaths: ['work_auth.authorized_us'],
  },
  {
    id: 'sponsorship',
    match: [
      /sponsor|visa\s*sponsor|require\s*.*visa|immigration\s*sponsor/i,
    ],
    keys: ['require sponsorship', 'visa sponsorship', 'sponsorship'],
    profilePaths: ['work_auth.sponsorship_needed'],
  },
  {
    id: 'years_experience',
    // Generic total-years only. Domain-specific "years leading X / years with Y"
    // are handled by experienceAnswer.mjs (match → years, else 0).
    match: [
      /^(how\s*many\s*)?years?\s*(of\s*)?(professional\s*)?(work\s*)?(experience|exp)\??$/i,
      /total\s*(years|experience)/i,
      /overall\s*years?\s*(of\s*)?experience/i,
      /how\s*many\s*years\s*(of\s*)?(professional\s*)?(work\s*)?experience\s*(do\s*you\s*have)?\??$/i,
    ],
    keys: ['years of experience', 'experience years'],
    profilePaths: ['experience.years'],
  },
  {
    id: 'job_title',
    match: [
      /^job\s*title$/i,
      /current\s*(title|role|position)/i,
      /most\s*recent\s*(title|role|position)/i,
    ],
    keys: ['role', 'job title', 'current title'],
    profilePaths: ['experience.current_title'],
  },
  {
    id: 'company',
    match: [
      /^company$/i,
      /current\s*(company|employer)/i,
      /most\s*recent\s*(company|employer)/i,
      /employer\s*name/i,
    ],
    keys: ['company', 'current company', 'employer'],
    profilePaths: ['experience.current_company'],
  },
  {
    id: 'relocate',
    match: [/relocat/i, /reside in (nebraska|iowa)/i, /\bne or ia\b/i],
    keys: ['willing to relocate'],
    profilePaths: ['work_auth.willing_to_relocate'],
  },
  {
    id: 'gender',
    match: [/^gender$|^sex$|please\s*select\s*your\s*(gender|sex)/i],
    keys: ['gender', 'sex'],
    profilePaths: ['eeo.gender'],
  },
  {
    id: 'hispanic',
    match: [/hispanic|latino/i],
    keys: ['hispanic or latino'],
    profilePaths: ['eeo.hispanic_latino'],
  },
  {
    id: 'race',
    match: [/\brace\b|ethnicity/i],
    keys: ['race ethnicity', 'race'],
    profilePaths: ['eeo.race'],
  },
  {
    id: 'veteran',
    match: [/veteran/i],
    keys: ['veteran status'],
    profilePaths: ['eeo.veteran_status'],
  },
  {
    id: 'disability',
    match: [/disability/i],
    keys: ['disability'],
    profilePaths: ['eeo.disability_status'],
  },
  {
    id: 'city',
    match: [/^city$/i],
    keys: ['city'],
    profilePaths: ['personal.city'],
  },
  {
    id: 'phone',
    match: [/^phone(\s*number)?$/i, /mobile\s*number/i],
    keys: ['phone', 'phone number'],
    profilePaths: ['personal.phone'],
  },
  {
    id: 'email',
    match: [/^email/i],
    keys: ['email'],
    profilePaths: ['personal.email'],
  },
];

/**
 * @param {string} label
 * @returns {{ id: string, keys: string[], profilePaths: string[] }|null}
 */
export function matchAnswerConcept(label) {
  const text = String(label || '').trim();
  if (!text) return null;
  for (const concept of ANSWER_CONCEPTS) {
    if (concept.match.some((re) => re.test(text))) {
      return {
        id: concept.id,
        keys: concept.keys || [],
        profilePaths: concept.profilePaths || [],
      };
    }
  }
  return null;
}

/**
 * Look up a value from a flat QA map (normalized keys) using concept keys.
 * @param {Record<string, string>} qaMap
 * @param {{ keys?: string[] }} concept
 * @returns {string|null}
 */
export function lookupConceptInQaMap(qaMap, concept) {
  if (!qaMap || !concept?.keys?.length) return null;
  for (const key of concept.keys) {
    const norm = normalizeLabel(key);
    const hit = qaMap[norm] ?? qaMap[key];
    if (hit != null && hit !== '') return String(hit);
  }
  // Also try fuzzy-ish: any qa key that matches the concept regexes via normalize
  for (const [k, v] of Object.entries(qaMap)) {
    if (v == null || v === '') continue;
    const conceptHit = matchAnswerConcept(k);
    if (conceptHit && conceptHit.id === concept.id) return String(v);
  }
  return null;
}

/**
 * Read nested profile path like "education.to_year".
 * @param {object} profile
 * @param {string} path
 * @returns {string|null}
 */
export function getProfilePathValue(profile, path) {
  if (!profile || !path) return null;
  if (path.startsWith('_')) {
    const v = profile[path];
    return v != null && v !== '' ? String(v) : null;
  }
  const parts = path.split('.');
  let cur = profile;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  if (cur == null || cur === '') return null;
  return Array.isArray(cur) ? cur.join(' > ') : String(cur);
}

/**
 * Resolve answer from profile paths for a matched concept.
 * @param {object} profile
 * @param {{ profilePaths?: string[] }} concept
 * @returns {string|null}
 */
export function lookupConceptInProfile(profile, concept) {
  if (!profile || !concept?.profilePaths?.length) return null;
  for (const path of concept.profilePaths) {
    const v = getProfilePathValue(profile, path);
    if (v) return v;
  }
  return null;
}

/**
 * Full concept resolve: Apply Wizz QA → profile qa_answers → profile paths.
 * @param {string} label
 * @param {object} profile
 * @returns {{ answer: string, source: string, concept: string }|null}
 */
export function resolveByConcept(label, profile = {}) {
  const concept = matchAnswerConcept(label);
  if (!concept) return null;

  const fromAw = lookupConceptInQaMap(profile._applyWizzQa || {}, concept);
  if (fromAw) return { answer: fromAw, source: 'concept_applywizz', concept: concept.id };

  const fromQa = lookupConceptInQaMap(profile.qa_answers || {}, concept);
  if (fromQa) return { answer: fromQa, source: 'concept_profile_qa', concept: concept.id };

  const fromProfile = lookupConceptInProfile(profile, concept);
  if (fromProfile) return { answer: fromProfile, source: 'concept_profile', concept: concept.id };

  return null;
}
