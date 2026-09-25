/**
 * workdayDefaults.mjs — Default Workday application / disclosure answers
 *
 * Merged into profile.qa_answers on load for fuzzy matching on every application.
 */

import { normalizeLabel } from './qaStore.mjs';
import { getTodayMMDDYYYY, isCurrentDateQuestionLabel } from './date-utils.mjs';
import { isMinimumAgeQuestion } from './minimumAge.mjs';

/** Default leaf answer for "How did you hear about us?" — used when profile has no override. */
export const WORKDAY_DEFAULT_SOURCE = 'LinkedIn';

/** Voluntary Disclosures — foregoing statement certification checkbox (e.g. Mass General Brigham). */
export const WORKDAY_CERTIFY_FOREGOING_STATEMENT = {
  question: 'I certify that I have read, fully understand and accept all terms of the foregoing statement.',
  answer: 'Yes',
};

export function isForegoingStatementCertifyLabel(label = '') {
  return /i certify that i have read.*foregoing statement/i.test(normalizeLabel(label));
}

/** Default for "Enter N/A if not applicable" and similar follow-up text fields. */
export const WORKDAY_NA_ANSWER = 'N/A';

export function isNaIfApplicableQuestion(label = '') {
  const raw = String(label || '');
  const norm = normalizeLabel(label);
  return /enter\s*n\/?a\s*if\s*not\s*applicable/i.test(raw)
    || /enter\s*n\/?a\s*if\s*not\s*applicable/i.test(norm)
    || /or\s+n\/?a\s*[\.\*]*$/i.test(raw.trim())
    || /if yes.*relationship with this individual/i.test(norm)
    || /if yes.*institution name and level/i.test(norm)
    || /enter your name.*agency.*n\/?a/i.test(norm)
    || /timekeepers?\s+only.*please\s+enter\s+n\/?a/i.test(raw)
    || /n\/?a\s+if\s+not\s+applicable.*timekeeper/i.test(raw)
    || /amount\s+of\s+hours.*billed.*past\s+year/i.test(norm);
}

export const WORKDAY_SOURCE_FALLBACK_OPTIONS = [
  'Company Website',
  'Company website',
  'External Career Site Sources',
  'External Career Sites',
  'Job Boards',
  'Glassdoor',
  'External Career Websites',
  'External Career Website',
  'Workday.com',
  'Instahire',
  'LinkedIn',
  'Indeed',
  'Google',
  'Website',
  'Anthropic',
];

/** Parent → child pairs tried when the source dropdown is hierarchical. */
export const WORKDAY_SOURCE_HIERARCHICAL_PREFERENCES = [
  ['Website', 'Company Website'],
  ['Website', 'Company website'],
  ['Website', 'Workday.com'],
  ['Website', 'Instahire'],
  ['Website', 'LinkedIn'],
  ['External Career Site Sources', 'External Career Websites'],
  ['External Career Site Sources', 'Anthropic'],
  ['Job Boards', 'LinkedIn'],
  ['Job Boards', 'Indeed'],
  ['Job Boards', 'Glassdoor'],
  ['Job Board', 'LinkedIn'],
  ['Job Board', 'Indeed'],
  ['Job Board', 'Glassdoor'],
  ['Job Board', 'CareerBuilder'],
  ['Job Board', 'Careerbuilder'],
  ['Job Board', 'Dice'],
  ['Job Board', 'DICE'],
  ['Job Boards', 'CareerBuilder'],
  ['Job Boards', 'Dice'],
  ['Job Sites', 'LinkedIn'],
  ['Job Sites', 'Indeed'],
  ['Job Sites', 'Glassdoor'],
  ['Job Sites', 'CareerBuilder'],
  ['Job Sites', 'Dice'],
  ['External Career Websites', 'Anthropic'],
  ['External Career Website', 'Anthropic'],
];

/** Notice period — prefer 4 weeks; fall back to 1 month when 4 weeks is not listed. */
export const WORKDAY_DEFAULT_NOTICE_PERIOD = '4 Weeks';
export const WORKDAY_NOTICE_PERIOD_OPTIONS = ['4 Weeks', '4 weeks', '1 Month', '1 month', 'One Month'];

/** Default Work Experience (Booz Allen / general Workday My Experience). */
export const WORKDAY_DEFAULT_EXPERIENCE = {
  current_title: 'Full stack Intern',
  current_company: 'Student spot',
  location: 'Hybrid',
  from_date: '05/2025',
  to_date: '06/2026',
  description: "Full stack Intern developed websites and automation worked with agents Rags and LLM's",
  currently_working: false,
  notice_period: WORKDAY_DEFAULT_NOTICE_PERIOD,
};

/** Default answer for Workday address City input fields. */
export const WORKDAY_DEFAULT_CITY = 'Hyderabad';

/** Default answer for Workday Address Line 1 (mandatory on My Information). */
export const WORKDAY_DEFAULT_ADDRESS_LINE1 = 'Hyderabad';

/** Default Education — searchable school "Other", Bachelor's, Computer Science. */
export const WORKDAY_DEFAULT_EDUCATION = {
  university: 'Other',
  degree: "Bachelor's",
  major: 'Computer Science',
  highest_level: 'Bachelors of Technology',
  from_year: '2020',
  to_year: '2024',
  field_of_study_hierarchy: ['Computer Science'],
};

/** My Experience — Skills multi-select (type → Enter → click option). */
export const WORKDAY_DEFAULT_SKILLS = [
  'Python',
  'JavaScript',
  'AI Development',
];

/** Field of Study parent → child attempts (hierarchical dropdown). */
export const WORKDAY_FIELD_OF_STUDY_HIERARCHY = ['Computer Science'];

export const WORKDAY_FIELD_OF_STUDY_ATTEMPTS = [
  ['Computer Science'],
  ['Engineering', 'Computer Science'],
  ['Engineering', 'Computer Engineering'],
  ['All', 'Computer Science'],
];

/** Default availability answers for schedule / shift questions. */
export const WORKDAY_DEFAULT_SCHEDULE = 'Full Time';
export const WORKDAY_DEFAULT_SHIFTS = ['Days', 'Evenings', 'Nights', 'Holidays', 'Weekends'];

const ADVERSE_HISTORY_RE = new RegExp([
  'disciplin', 'reprimand', 'suspension', 'suspended',
  'terminated|termination|discharged|dismissed|fired',
  'resign\\w*\\s+in\\s+lieu',
  'convict\\w*|felony|misdemeanor|criminal|plead\\w*\\s+(guilty|no\\s+contest)',
  'under\\s+investigation|investigated\\s+for|found\\s+(guilty|liable)',
  'licen[cs]\\w*\\s*(revok|suspend|surrender|restrict|denied)|revoked|surrendered\\s+(your|a)\\s+licen',
  'debarred|excluded\\s+from\\s+(medicare|medicaid)|been\\s+sanctioned|exclusion\\s+list',
  'malpractice|abuse\\s+or\\s+neglect|substantiated\\s+finding',
  'failed\\s+a\\s*(drug|background)|positive\\s+drug',
  'professional\\s+(misconduct|conduct)',
  'breach\\s+of\\s+(contract|duty|confidentiality)',
  'export\\s+control|export\\s+license|citizen.*(?:iran|cuba|north\\s*korea|syria)',
].join('|'), 'i');

const PRIOR_ASSOCIATION_RE = new RegExp([
  'have\\s+you\\s+ever\\s+(been\\s+)?(a\\s+)?volunteer',
  'volunteered\\s+(at|for|with)',
  '(worked|employed|placed)\\s+.*(through|via|by)\\s+(an?\\s+)?(outside|external|staffing|temp\\w*|third[-\\s]?party|contract)\\s+agency',
  'have\\s+you\\s+ever\\s+(worked|been\\s+employed|been\\s+an\\s+employee|applied|interviewed|been\\s+a\\s+(patient|student|contractor|intern))',
  'have\\s+you\\s+(ever\\s+)?(previously\\s+)?(applied|interviewed|submitted\\s+an\\s+application|filed\\s+an\\s+application)',
  'are\\s+you\\s+(currently\\s+)?(related\\s+to|a\\s+relative\\s+of)',
  'do\\s+you\\s+have\\s+(a\\s+)?(relative|family\\s+member)s?\\s+(who|that|currently)',
  'do\\s+any\\s+of\\s+your\\s+(friends|relatives|family\\s+members?)',
  'friends?\\s+or\\s+relatives?\\s+(work|employed|currently)',
  'previously\\s+interviewed\\s+(at|with)',
  'been\\s+employed\\s+by\\s+\\w+\\s+previously|previously\\s+been\\s+employed',
].join('|'), 'i');

const WORK_ELIGIBILITY_RE = /\b(eligible|legally\s+(eligible|authori[sz]ed|entitled)|authori[sz]ed|permitted)\s+(to\s+(work|be\s+employed)|for\s+employment)(\s+(lawfully|legally))?(\s+(in|within|for))?\b/i;

const SCHEDULE_QUESTION_RE = /what\s+schedule|schedule\s+(can|could|are)\s+you|schedule\s+(preference|availability)|which\s+schedule|hours?\s+(are\s+you\s+)?available|employment\s+type|are\s+you\s+available\s+to\s+work|please\s+indicate\s+availability|indicate\s+your\s+availability/i;

// "Shift preference" is deliberately absent — that one belongs to the work-type group.
const SHIFT_QUESTION_RE = /what\s+shifts?|which\s+shifts?|shifts?\s+(can|could|are)\s+you|shift\s+availability|available\s+shifts?/i;

/**
 * Misconduct / discipline / criminal-history style question — always answered "No".
 * @param {string} label
 * @returns {boolean}
 */
export function isAdverseHistoryQuestion(label = '') {
  const s = String(label || '');
  if (/please\s+sign|electronic\s+signature|typed\s+name|sign\s*\(\s*type\s*name\s*\)|type\s+(your\s+)?(full\s+)?name|\bsignature\b/i.test(s)) {
    return false;
  }
  if (/acknowledge|attest|certif|read.*reviewed.*truthfully|truthfully and accurately|conditional on the truth/i.test(s)) {
    return false;
  }
  return ADVERSE_HISTORY_RE.test(s);
}

/**
 * "Have you ever worked/volunteered here / are you related to an employee" — always "No".
 * @param {string} label
 * @returns {boolean}
 */
export function isPriorAssociationQuestion(label = '') {
  const text = String(label || '');
  if (WORK_ELIGIBILITY_RE.test(text)) return false;
  return PRIOR_ASSOCIATION_RE.test(text);
}

/**
 * "Are you eligible / legally authorized to work in the US" — always "Yes".
 * @param {string} label
 * @returns {boolean}
 */
export function isWorkEligibilityQuestion(label = '') {
  const text = String(label || '');
  if (/sponsorship|visa|require\s+(any\s+)?immigration/i.test(text)) return false;
  return WORK_ELIGIBILITY_RE.test(text);
}

/** @param {string} label @returns {boolean} */
export function isScheduleAvailabilityQuestion(label = '') {
  return SCHEDULE_QUESTION_RE.test(String(label || ''));
}

/** @param {string} label @returns {boolean} */
export function isShiftAvailabilityQuestion(label = '') {
  return SHIFT_QUESTION_RE.test(String(label || ''));
}

/**
 * Yes/No shaped question ("Have you ever…", "Are you…") — used to reject answers
 * from fuzzy sources that clearly belong to another question.
 * @param {string} label
 * @returns {boolean}
 */
export function isYesNoQuestionLabel(label = '') {
  const raw = String(label || '').replace(/\*+/g, '').trim();
  if (/\b(how many|how much|how soon|how long|which|what|when|where|why|describe|explain|list)\b|select\s+all/i.test(raw)) {
    return false;
  }
  if (/government\s+employment|entered into any agreement|non-?compet|acceptance of employment/i.test(raw)) {
    return true;
  }
  let text = raw.replace(/^\s*\d+[.)]\s*/, '').trim();
  const inner = text.match(/\b((?:have|has|had|are|is|was|were|do|does|did|will|would|can|could)\b[^?]{6,240}\?)/i);
  if (inner) text = inner[1];
  if (!/^(have|has|had|are|is|was|were|do|does|did|will|would|can|could|should|may)\b/i.test(text)) return false;
  if (/\b(prefer|which|what|how|when|where|why|describe|explain|list)\b|select\s+all/i.test(text)) return false;
  return true;
}

/** @param {*} value @returns {boolean} */
export function isYesNoAnswer(value) {
  return /^(yes|no|y|n|true|false|i\s+(do|am|have|agree|acknowledge)|i\s+(do\s+not|don't|am\s+not|have\s+not|haven't))\b/i
    .test(String(value ?? '').trim());
}

/**
 * Pull a Yes/No token from LLM prose ("I live in Texas but am willing to relocate → Yes").
 * @param {*} value
 * @returns {'Yes'|'No'|null}
 */
export function extractYesNoAnswer(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const leading = leadingYesNo(text);
  if (leading === 'yes') return 'Yes';
  if (leading === 'no') return 'No';
  const m = text.match(/\b(yes|no)\b/i);
  if (!m) return null;
  return /^no$/i.test(m[1]) ? 'No' : 'Yes';
}

/**
 * The leading Yes/No of an option or value, or null when it starts with neither.
 * @param {*} value
 * @returns {'yes'|'no'|null}
 */
export function leadingYesNo(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^(yes|y\b|true|i\s+(do|am|have|agree|acknowledge)\b)/.test(text) && !/^i\s+(do\s+not|don't|am\s+not|have\s+not|haven't)\b/.test(text)) {
    return 'yes';
  }
  // "Not Hispanic or Latino", "Not a protected veteran" — a negative option that
  // a stored "No" is meant to select.
  if (/^(no\b|n\b|false|not\b|i\s+(do\s+not|don't|am\s+not|have\s+not|haven't)\b)/.test(text)) return 'no';
  return null;
}

/**
 * True when a control's live value really is the answer that was intended.
 *
 * Yes/No is compared on the leading word only: a plain substring test lets
 * "Yes, I have been notified" satisfy an intended "No" (it contains "no"),
 * which silently submits the opposite answer.
 * @param {*} actual value read back from the DOM
 * @param {*} expected answer we meant to give
 * @returns {boolean}
 */
export function selectionMatchesAnswer(actual, expected) {
  const a = String(actual ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const e = String(expected ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!a || !e) return false;
  if (a === e) return true;

  const expectedYesNo = leadingYesNo(e);
  if (expectedYesNo) return leadingYesNo(a) === expectedYesNo;
  if (leadingYesNo(a)) return false;

  if (a.includes(e) || e.includes(a)) return true;

  // Handle degree equivalencies (e.g. "master's degree" vs "master of science/masters/ms")
  const degA = /master|\bms\b/i.test(a) ? 'master' : /bachelor|\bbs\b|\bb\.?tech\b/i.test(a) ? 'bachelor' : /doctor|\bph\.?d\b/i.test(a) ? 'doctor' : null;
  const degE = /master|\bms\b/i.test(e) ? 'master' : /bachelor|\bbs\b|\bb\.?tech\b/i.test(e) ? 'bachelor' : /doctor|\bph\.?d\b/i.test(e) ? 'doctor' : null;
  if (degA && degE && degA === degE) return true;

  // Handle salary/currency numeric variations (e.g., "90000" vs "90000 USD" or "$90,000")
  const numA = a.replace(/,/g, '').match(/\b(\d{4,7})\b/);
  const numE = e.replace(/,/g, '').match(/\b(\d{4,7})\b/);
  if (numA && numE && numA[1] === numE[1]) return true;

  return false;
}

/**
 * Deterministic answer for questions that must never be guessed or fabricated:
 * adverse history and prior association are "No", work eligibility is "Yes".
 * @param {string} label
 * @returns {string|null}
 */
export function lookupSensitiveSafeAnswer(label = '') {
  if (isWorkEligibilityQuestion(label)) return 'Yes';
  if (isAdverseHistoryQuestion(label)) return 'No';
  if (isPriorAssociationQuestion(label)) return 'No';
  if (isMinimumAgeQuestion(label)) return 'Yes';
  const t = String(label || '');
  if (/sponsor|visa|authorized to work|legally authorized|work authorization/i.test(t)) return null;
  if (/government\s+employment|federal\s+government|state,?\s+local.{0,40}government|u\.s\.?\s+armed\s+services|post-government\s+employment|government entity|political party|royal family|candidate for political/i.test(t)
    && !/years of|experience in|authorized|sponsor/i.test(t)) {
    return 'No';
  }
  if (/entered into any agreement|non-?compet|non-?solicit|confidentiality of information|assignment of rights to inventions/i.test(t)) {
    return 'No';
  }
  if (/acceptance of employment|conflict of interest|restrict(ion|ed).{0,60}(accept|employ)/i.test(t)) {
    return 'No';
  }
  if (/family or household|board of directors|government official|related to an employee/i.test(t)) {
    return 'No';
  }
  if (/export\s+control|export\s+license|citizen.*(?:iran|cuba|north\s*korea|syria)|resident\s+of\s+(?:iran|cuba|north\s*korea|syria)/i.test(t)) {
    return 'No';
  }
  if (/read,?\s*reviewed\s*and\s*answered\s*the\s*above\s*questions\s*truthfully|select\s*["']?yes["']?\s*if\s*you\s*acknowledge/i.test(t)) {
    return 'Yes';
  }
  if (/regarding\s+future\s+positions(\s+at\s+\w+)?,\s*please\s+select/i.test(t)) {
    return 'Yes';
  }
  // "Can you perform the essential functions of the job, with or without a reasonable accommodation?"
  if (/perform\s+(the\s+)?essential\s+functions(\s+of\s+the\s+job)?/i.test(t)) {
    return 'Yes';
  }
  // "Can you travel if a job requires it?" / "Are you willing to travel?"
  if (/can\s+you\s+travel\s+if|willing\s+to\s+travel|able\s+to\s+travel\s+(if|when|as|for)/i.test(t)) {
    return 'Yes';
  }
  // Travel percentage questions — always answer 50-75%
  // e.g. "What percentage of travel are you comfortable with?"
  //      "Should the role require travel, what percentage are you comfortable with?"
  //      "What percentage of time can you travel?"
  //      "How much travel are you willing to do?"
  if (/percentage.*travel|travel.*percentage|comfortable.*travel|travel.*comfortable|percent.*time.*travel|travel.*percent/i.test(t)) {
    return '50-75%';
  }
  // "May we contact your current or most recent employer?"
  if (/may\s+we\s+contact\s+your\s+(current|most\s+recent)\s+employer/i.test(t)) {
    return 'Yes';
  }
  // "Are you local to the area in which this job has been advertised?"
  if (/local\s+to\s+the\s+area|are\s+you\s+local\s+to/i.test(t)) {
    return 'No';
  }
  // "Do you hold any FINRA licenses?" / "Do you have any FINRA licenses?"
  if (/finra\s+(licenses?|series\s+\d)/i.test(t)) {
    return 'No';
  }
  // "Have you previously interviewed at [Company]?"
  if (/previously\s+interviewed\s+(at|with)/i.test(t)) {
    return 'No';
  }
  // "Are there any limitations to the hours you may be available, as required by the job?" / schedule restrictions
  if (/limitation.*(hour|schedule|available)|restriction.*(hour|schedule|available)|limitations?\s+to\s+(the\s+)?hours/i.test(t)) {
    return 'No';
  }
  // "Are you able to commute to the site?" / "Do you have reliable transportation?"
  if (/able\s+to\s+commute|commute\s+to\s+(the\s+)?(site|location|office|job)|reliable\s+(transportation|commute)/i.test(t)) {
    return 'Yes';
  }
  // "Will you work overtime?" / "Are you willing to work overtime?"
  if (/willing.*work\s*overtime|able.*work\s*overtime|will\s+you\s+work\s+overtime/i.test(t)) {
    return 'Yes';
  }
  return null;
}

/**
 * Maps arbitrary degree text ("Master of Science in Computer Science Java Python...", "MS", "B.Tech")
 * to a canonical degree category: 'master', 'bachelor', 'doctorate', 'associate', 'high_school'.
 */
export function canonicalDegreeBucket(degreeText = '') {
  const s = String(degreeText || '').toLowerCase().trim();
  if (!s) return null;
  if (/master|m\.?s\.?(?!\s*degree|\s*in\s*arts)|\bmsc\b|\bms\b|post[\s-]?grad/i.test(s) && !/bachelor|b\.?s\.?|undergrad/i.test(s)) {
    return 'master';
  }
  if (/bachelor|b\.?tech\b|\bbtech\b|\bbsc\b|\bb\.?s\.?\b|undergrad/i.test(s) && !/master|ms\b/i.test(s)) {
    return 'bachelor';
  }
  if (/doctor|ph\.?d|doctoral/i.test(s)) {
    return 'doctorate';
  }
  if (/associate/i.test(s)) {
    return 'associate';
  }
  if (/high\s*school|ged|secondary/i.test(s)) {
    return 'high_school';
  }
  return null;
}

/**
 * Matches a candidate degree to the best option in a Workday education dropdown list.
 */
export function matchDegreeToOptions(degreeText = '', options = []) {
  if (!degreeText || !options?.length) return null;
  const bucket = canonicalDegreeBucket(degreeText);
  if (!bucket) return null;

  const optStrings = options.map((o) => (typeof o === 'string' ? o : o?.text || o?.value || '')).filter(Boolean);

  // Filter out negative / catch-all options like "None of the Above"
  const validOpts = optStrings.filter((o) => !/none\s+of\s+the\s+above|not\s+applicable|n\/?a/i.test(o));

  if (bucket === 'master') {
    const hit = validOpts.find((o) => /master/i.test(o))
      || validOpts.find((o) => /graduate\s+degree/i.test(o));
    if (hit) return hit;
  }
  if (bucket === 'bachelor') {
    const hit = validOpts.find((o) => /bachelor/i.test(o))
      || validOpts.find((o) => /undergraduate\s+degree/i.test(o));
    if (hit) return hit;
  }
  if (bucket === 'doctorate') {
    const hit = validOpts.find((o) => /doctor|ph\.?d/i.test(o));
    if (hit) return hit;
  }
  if (bucket === 'associate') {
    const hit = validOpts.find((o) => /associate/i.test(o));
    if (hit) return hit;
  }
  if (bucket === 'high_school') {
    const hit = validOpts.find((o) => /high\s*school|ged|secondary/i.test(o));
    if (hit) return hit;
  }

  return null;
}

export function pickRandomSourceOption() {
  // Explicit user-provided answers are preferred. Do not auto-generate random
  // source values for unknown Workday questions; when the source is not known,
  // the user should answer in terminal and it is persisted for future jobs.
  return WORKDAY_SOURCE_FALLBACK_OPTIONS[0] || null;
}

/** @type {Array<{ question: string, answer: string }>} */
export const WORKDAY_DEFAULT_QA = [
  {
    question: 'Do you have any relatives that are currently employed by ABC Fitness?',
    answer: 'No',
  },
  {
    question: 'Are you currently or have you ever worked at an ABC customer site?',
    answer: 'No',
  },
  {
    question: 'Are you bilingual?',
    answer: 'No',
  },
  {
    question: 'What is your desired start date?',
    answer: getTodayMMDDYYYY('Asia/Kolkata'),
  },
  {
    question: 'Instahire',
    answer: 'Instahire',
  },
  {
    question: 'Are you 18 years of age or older?',
    answer: 'Yes',
  },
  {
    question: 'Have you ever been employed by 3M or a subsidiary? (Current and/or former contract or contingent work at 3M does not apply)',
    answer: 'No',
  },
  {
    question: 'Are you currently, or in the last three (3) years, have you been employed by Pricewater Coopers (PwC)?',
    answer: 'No',
  },
  {
    question: 'Have you signed an agreement with a current/previous employer containing a provision relating to assignment of rights to inventions, confidentiality of information, non-competition or non-solicitation?',
    answer: 'No',
  },
  {
    question: 'Are you or a household member now employed by a State government or the United States government (including Presidential appointments) either as a military member or civilian employee or as a member of the legislative branch?',
    answer: 'No',
  },
  {
    question: 'Have you or a household member at any time in the past been employed by a state government or the United States government (including presidential appointments) either as an active duty military member or civilian employee or as a member of the legislative branch?',
    answer: 'No',
  },
  {
    question: 'Are you currently or have you in the past provided services to 3M as a contract worker or consultant?',
    answer: 'No',
  },
  {
    question: 'Do you have a relative presently employed at or retired from 3M?',
    answer: 'No',
  },
  {
    question: 'Are you currently, or in the last three (3) years, have you been employed by Epic Systems Corporation?',
    answer: 'No',
  },
  {
    question: 'Do you possess deep understanding of data product management principles, domain ownership, data mesh concepts, data contracts, value stream mapping, and Outcome-Driven Metrics for measuring enterprise-wide business value?',
    answer: 'Yes',
  },
  {
    question: 'Do you possess a Bachelor’s degree or higher (completed and verified prior to start)?',
    answer: 'Yes',
  },
  {
    question: 'Do you have a minimum of ten (10) years of combined experience in Sourcing, Procurement, Logistics, Supply Chain, Engineering and/or Manufacturing in a private, public, government or military environment?',
    answer: 'Yes',
  },
  {
    question: 'Do you have experience in Procurement, especially with Molding suppliers, including contract manufacturers and co-packers?',
    answer: 'Yes',
  },
  {
    question: 'Please select your sex.',
    answer: 'Male',
  },
  {
    question: 'Please select your race-ethnicity.',
    answer: 'Asian (United States of America)',
  },
  {
    question: 'Please select the race which most accurately describes how you identify yourself',
    answer: 'Asian',
  },
  {
    question: 'Please indicate whether you are in one or more of the protected veteran categories.',
    answer: 'I am not a protected veteran.',
  },
  {
    question: 'Please select the veteran status which most accurately describes how you identify yourself',
    answer: 'No, I am not a veteran',
  },
  {
    question: 'Yes, I have read and consent to the terms and conditions',
    answer: 'Yes',
  },
  {
    question: WORKDAY_CERTIFY_FOREGOING_STATEMENT.question,
    answer: WORKDAY_CERTIFY_FOREGOING_STATEMENT.answer,
  },
  {
    question: 'Phone Device Type',
    answer: 'Mobile',
  },
  {
    question: 'What work types are you open to?',
    answer: 'Full-time',
  },
  {
    question: 'When are you available to start?',
    answer: getTodayMMDDYYYY('Asia/Kolkata'),
  },
  {
    question: 'Type to Add Skills',
    answer: WORKDAY_DEFAULT_SKILLS.join(', '),
  },
  {
    question: 'Skills',
    answer: WORKDAY_DEFAULT_SKILLS.join(', '),
  },
  {
    question: 'Are you a relative of a current Public Official?',
    answer: 'No',
  },
  {
    question: 'Are you a relative of a current senior level person or senior commercial person for a company other than State Street?',
    answer: 'No',
  },
  {
    question: 'If yes, what is your relationship with this individual? Enter N/A if not applicable.',
    answer: WORKDAY_NA_ANSWER,
  },
  {
    question: 'If yes, please list the institution name and level of the individual. Enter N/A if not applicable.',
    answer: WORKDAY_NA_ANSWER,
  },
  {
    question: 'Please select one of the below options:',
    answer: 'I am completing the application and anti-corruption questions on behalf of myself.',
  },
  {
    question: 'Enter your name (required) and the name of your agency (if applicable) or N/A.',
    answer: WORKDAY_NA_ANSWER,
  },
  {
    question: 'External Career Site Sources',
    answer: ['External Career Site Sources', 'Anthropic'],
  },
  {
    question: 'Have you read and agree to the Non Disclosure Agreement?',
    answer: 'I have read and agree to the Non Disclosure Agreement',
  },
  {
    question: 'Have you read and agree to the Mutual Arbitration Agreement?',
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: 'Mutual Arbitration Agreement',
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: 'To be considered for employment, all applicants must agree to the Mutual Arbitration Agreement. Applicants will not be considered for employment if the Company is not in receipt of the individual’s agreement to the Mutual Arbitration Agreement.',
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: 'To be considered for employment, all applicants must agree to the Mutual Arbitration Agreement. Applicants will not be considered for employment if the Company is not in receipt of the individual’s agreement to the Mutual Arbitration Agreement.',
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: 'Click on the link below to review the Arbitration Agreement. Mutual Arbitration Agreement To be considered for employment, all applicants must agree to the Mutual Arbitration Agreement. Applicants will not be considered for employment if the Company is not in receipt of the individual’s agreement to the Mutual Arbitration Agreement.',
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: "Click on the link below to review the Arbitration Agreement. Mutual Arbitration Agreement To be considered for employment, all applicants must agree to the Mutual Arbitration Agreement. Applicants will not be considered for employment if the Company is not in receipt of the individual’s agreement to the Mutual Arbitration Agreement.",
    answer: 'I have read and agree to the Mutual Arbitration Agreement',
  },
  {
    question: 'Non Disclosure Agreement',
    answer: 'I have read and agree to the Non Disclosure Agreement',
  },
  {
    question: 'Would you consider relocating for this role?',
    answer: 'Yes, I would consider relocating for this role',
  },
  {
    question: 'Are you subject to any non-compete or non-solicitation restrictions at your current or most recent employer?',
    answer: 'No',
  },
  {
    question: 'In your current job, do you use or work on the Workday system?',
    answer: 'No, I do not use the Workday system in my current job',
  },
  {
    question: 'Are you authorized to work in the country where this job is located?',
    answer: 'Yes',
  },
  {
    question: 'Do you now or in the future require any immigration filing or visa sponsorship to maintain work authorization, including sponsorship by Workday, renewal/extension of open work permit, permanent residency, etc.?',
    answer: 'No',
  },
  {
    question: 'Are you a current or former employee of the United States government?',
    answer: 'No',
  },
  {
    question: 'Are you a current citizen, national or resident of any of the following countries/regions: Iran, Cuba, North Korea, Syria, Crimea, Donetsk People\'s Republic (DNR), Luhansk People\'s Republic (LNR) regions of Ukraine?',
    answer: 'No',
  },
  {
    question: 'Are you related to a current Workday employee?',
    answer: 'No',
  },
  {
    question: 'To the best of your knowledge, are you related to an employee of a customer, or a government official, who has direct business interactions with Workday?',
    answer: 'No',
  },
  {
    question: 'Are you (i) a current or recent former (within the preceding 24 months) employee of Ernst & Young, LLP, Workday\'s independent auditors, or (ii) a current or former (at any time) partner or principal of Ernst & Young, LLP?',
    answer: 'No',
  },
  {
    question: 'Please enter "yes" if you acknowledge.',
    answer: 'Yes',
  },
  {
    question: 'I acknowledge that I have read, understood and reviewed the above questions, and I have answered them truthfully and accurately.',
    answer: 'Yes',
  },
  {
    question: 'Please check one of the boxes below:',
    answer: 'No, I do not have a disability and have not had one in the past',
  },
  {
    question: 'Language',
    answer: 'English',
  },
  {
    question: 'I acknowledge that I have read, understood and reviewed the above questions',
    answer: 'Yes',
  },
  {
    question: 'I understand that upon employment, proof of legal right to work in the US and completion of an I-9 form will be required.',
    answer: 'Yes',
  },
  {
    question: 'Do you have the unrestricted right to work in the country to which you\'re applying? (You must answer “No” if you are on any visa or possess any government issued work authorization document that has an expiration date; you should answer “Yes” if you have DACA or TPS authorization in the US)',
    answer: 'No',
  },
  {
    question: 'Will you now or could you in the future require sponsorship to obtain work authorization or to transfer or extend your current visa? (You must answer “Yes” if your current visa is tied to your spouse or partner’s visa.)',
    answer: 'No',
  },
  {
    question: 'Government Employment: In the last 5 years, have you been an employee of a U.S. federal, state, or local government, including a "special Government employee" (defined under 18 U.S.C. §202), or a member of the U.S. Armed Services (including Reserve and Guard components)?',
    answer: 'No',
  },
  {
    question: 'I attest/confirm that I have no post-government employment restrictions currently applicable to me that have not already been addressed or disclosed in the previous questions, OR that if I am aware of any applicable restrictions, I will disclose them to the recruiter if contacted for further processing of my application. If I received written advice from my current or former government employer about work restrictions that are still active, I will provide it to the recruiter if contacted for further processing of my application.',
    answer: 'Yes',
  },
  {
    question: 'Are you currently or have you in the past been debarred, suspended, proposed for debarment or declared ineligible for award of a contract by any federal agency?',
    answer: 'No',
  },
  {
    question: 'Are you a citizen, national or permanent resident of Iran, Cuba, North Korea or Syria?',
    answer: 'No',
  },
  {
    question: 'Regarding future positions at Salesforce, please select one of the following options',
    answer: 'Yes',
  },
  {
    question: 'I acknowledge that I have read, reviewed and answered the above questions truthfully and accurately. I further understand, and agree, that any offer of employment I may receive from Salesforce is conditional on the truth of the above statements and that, in the event it is subsequently determined that any of the above is inaccurate, any such offer of employment can be rescinded and, in the event I have commenced employment, such employment will be terminated, to the extent permitted by applicable law. Please select "yes" if you acknowledge.',
    answer: 'Yes',
  },
  {
    question: 'Do you consent to recorded Workday interviews?',
    answer: 'Yes',
  },
  {
    question: 'Gender',
    answer: 'Male',
  },
  {
    question: 'Are you legally authorized to work in the country to which you are applying?',
    answer: 'Yes',
  },
  {
    question: 'Will you now or in the future require sponsorship for employment visa status?',
    answer: 'No',
  },
  {
    question: 'Notice Period',
    answer: WORKDAY_DEFAULT_NOTICE_PERIOD,
  },
  {
    question: 'Highest level of education completed',
    answer: 'College/University Graduate',
  },
  {
    question: 'Have you worked for Pricewaterhouse Coopers (PwC)?',
    answer: 'No',
  },
  {
    question: 'Are you a Career Returner?  *A Career Returner applies to any individual who has taken career break for 12 months plus*',
    answer: 'No',
  },
  // Common application questions across Workday tenants
  {
    question: 'Have you previously interviewed at this company?',
    answer: 'No',
  },
  {
    question: 'Have you ever filed an application with us before?',
    answer: 'No',
  },
  {
    question: 'Do any of your friends or relatives work here?',
    answer: 'No',
  },
  {
    question: 'May we contact your current or most recent employer?',
    answer: 'Yes',
  },
  {
    question: 'Can you travel if a job requires it?',
    answer: 'Yes',
  },
  {
    question: 'Are you willing to travel?',
    answer: 'Yes',
  },
  {
    question: 'Should the role you are applying to require travel, what percentage of travel are you comfortable with?',
    answer: '50-75%',
  },
  {
    question: 'What percentage of travel are you comfortable with?',
    answer: '50-75%',
  },
  {
    question: 'What percentage of time can you travel?',
    answer: '50-75%',
  },
  {
    question: 'How much travel are you willing to do?',
    answer: '50-75%',
  },
  {
    question: 'Are you local to the area in which this job has been advertised?',
    answer: 'No',
  },
  {
    question: 'Do you hold any FINRA licenses?',
    answer: 'No',
  },
  {
    question: 'Do you have any FINRA licenses?',
    answer: 'No',
  },
  {
    question: 'After reviewing the job description for the position for which you are applying, can you perform the essential functions of the job, with or without a reasonable accommodation?',
    answer: 'Yes',
  },
  {
    question: 'Are you available to work:',
    answer: WORKDAY_DEFAULT_SCHEDULE,
  },
  {
    question: 'Please indicate availability:',
    answer: WORKDAY_DEFAULT_SCHEDULE,
  },
  {
    question: 'Please provide the amount of hours that you have billed this past year. (Timekeepers only. Please enter N/A if not applicable.)',
    answer: WORKDAY_NA_ANSWER,
  },
];

/** Patterns used to fill dropdowns on Application Questions / Voluntary Disclosures steps */
export const WORKDAY_DROPDOWN_DEFAULTS = WORKDAY_DEFAULT_QA.map(({ question, answer }) => ({
  pattern: new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40), 'i'),
  labelHint: question.slice(0, 60),
  answer,
}));

/**
 * Merge default answers into profile.qa_answers (does not overwrite existing).
 * @param {object} profile
 * @returns {object} profile
 */
export function mergeWorkdayDefaultAnswers(profile) {
  if (!profile) return profile;
  if (!profile.qa_answers || typeof profile.qa_answers !== 'object') {
    profile.qa_answers = {};
  }
  // Do not inject invented Yes/No, gender, city, or dates. Those come from
  // Apply Wizz or the LLM analysing the client profile.
  if (!profile.personal) profile.personal = {};
  if (!profile.eeo) profile.eeo = {};
  if (!profile.work_auth) profile.work_auth = {};
  if (!profile.experience) profile.experience = {};
  if (!profile.education) profile.education = {};
  return profile;
}

/**
 * Find the best default answer for a scanned label using fuzzy substring match.
 * @param {string} label
 * @returns {string|null}
 */
export function lookupDefaultAnswer(label) {
  const norm = normalizeLabel(label);
  if (!norm) return null;

  // High-trust fields — must come from profile/Supabase, never from a hardcoded default.
  // Returning null here forces the caller to fall through to resolveField where the
  // provenance gate audits every answer.
  if (
    /sponsor|require.*visa|visa.*sponsor|immigration.*sponsor|visa.*status/i.test(label)
    || /do you have.*relative|relative.*work.*(?:our|this|the)\s+company|relatives.*employed/i.test(label)
    || /high\s*school\s*diploma|g\.e\.d|minimum.*educational.*requirement|possess.*diploma/i.test(label)
    || /available.*to.*start|when.*available.*start|when.*can.*you.*start|earliest.*start|availability.*start|desired.*start.*date/i.test(label)
  ) {
    return null;
  }

  if (/(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(norm)) {
    return null;
  }

  const safeAnswer = lookupSensitiveSafeAnswer(label);
  if (safeAnswer) return safeAnswer;

  if (isShiftAvailabilityQuestion(label)) return WORKDAY_DEFAULT_SHIFTS.join(', ');
  if (isScheduleAvailabilityQuestion(label)) return WORKDAY_DEFAULT_SCHEDULE;
  // Short-label availability questions: "Are you available to work:" / "Please indicate availability:"
  if (/^are\s+you\s+available\s+to\s+work[:\s]*$/i.test(String(label || '').trim())) return WORKDAY_DEFAULT_SCHEDULE;
  if (/^please\s+indicate\s+availability[:\s]*$/i.test(String(label || '').trim())) return WORKDAY_DEFAULT_SCHEDULE;
  if (/indicate\s+(your\s+)?availability[:\s]*$/i.test(String(label || '').trim())) return WORKDAY_DEFAULT_SCHEDULE;

  if (/external\s*career\s*site\s*sources/i.test(norm) || /anthropic/i.test(norm)) {
    return ['External Career Site Sources', 'Anthropic'];
  }
  if (/how\s*did\s*you\s*hear/i.test(norm)) {
    return WORKDAY_DEFAULT_SOURCE;
  }
  if (/^job\s*title$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.current_title;
  if (/^company$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.current_company;
  if (/^location$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.location;
  if (/^city$|^address--city$/i.test(norm)) return WORKDAY_DEFAULT_CITY;
  if (/^address\s*line\s*1$|^address--addressline1$/i.test(norm)) return WORKDAY_DEFAULT_ADDRESS_LINE1;
  if (/^from$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.from_date;
  if (/^to$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.to_date;
  if (/education.*from|^from\s*year$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.from_year;
  if (/school\s*or\s*university|^school$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.university;
  if (/^degree$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.degree;
  if (/field\s*of\s*study/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.major;
  if (/highest\s*level\s*of\s*education/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.highest_level;
  if (/school\s*or\s*university|^school$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.university;
  if (/to\s*\(actual\s*or\s*expected\)/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.to_year;
  if (/^role\s*description/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.description;
  if (/^notice\s*period$/i.test(norm)) return WORKDAY_DEFAULT_NOTICE_PERIOD;
  if (/type to add skills|^skills$/i.test(norm) || /enter a skill below/i.test(norm)) {
    return WORKDAY_DEFAULT_SKILLS.join(', ');
  }
  // Availability / start-date questions: do NOT return today's date here.
  // The profile stores available_to_start (e.g. 09/20/2026). Returning today
  // from a defaults lookup would overwrite it before the profile is consulted.
  // resolveField handles these via isAvailabilityStartDateLabel with profile-first logic.
  if (/desired\s*start\s*date|available\s*to\s*start|when.*available.*start|when.*can.*you.*start|earliest.*start|availability.*start/i.test(norm)) {
    return null;
  }
  if (/work\s*types?|employment\s*types?|schedule\s*preference|shift\s*preference|hours?\s*per\s*week|available\s*for|^full[-\s]?time$/i.test(norm)) {
    return 'Full-time';
  }
  if (/do\s+you\s+have\s+any\s+relatives\s+that\s+are\s+currently\s+employed\s+by\s+abc\s+fitness/i.test(norm)) {
    return 'No';
  }
  if (/are\s+you\s+currently\s+or\s+have\s+you\s+ever\s+worked\s+at\s+an\s+abc\s+customer\s+site/i.test(norm)) {
    return 'No';
  }
  if (isForegoingStatementCertifyLabel(label)) {
    return WORKDAY_CERTIFY_FOREGOING_STATEMENT.answer;
  }
  if (isNaIfApplicableQuestion(label)) {
    return WORKDAY_NA_ANSWER;
  }
  if (/relative of a current public official/i.test(norm)) {
    return 'No';
  }
  if (/relative of a current senior level person or senior commercial person/i.test(norm)) {
    return 'No';
  }
  if (/please select one of the below options/i.test(norm) && !/mass general brigham|affiliate/i.test(norm)) {
    return 'I am completing the application and anti-corruption questions on behalf of myself.';
  }
  if (/i acknowledge that i have read.*above questions.*truthfully and accurately/i.test(norm)) {
    return 'Yes';
  }
  if (/please enter.*yes.*if you acknowledge/i.test(norm)) {
    return 'Yes';
  }
  if (/please select your gender|please select your sex/i.test(norm) || norm === 'gender' || norm === 'sex') {
    return 'Male';
  }
  if (/^hispanic or latino$/i.test(norm) || /hispanic\s*or\s*latino/i.test(norm) || /^hispanic$/i.test(norm)) {
    return 'No';
  }
  if (
    /^race$|^ethnicity$/i.test(norm)
    || /^race\/ethnicity$|^race ethnicity$/i.test(norm)
    || /please select your race-ethnicity|ethnicity single selection/i.test(norm)
  ) {
    return 'Asian (United States of America)';
  }
  if (/^veteran status$/i.test(norm)) {
    return 'I am not a protected veteran';
  }
  if (/yes i have read and consent to the terms and conditions/i.test(norm)) {
    return 'Yes';
  }
  if (/please select yes if hispanic/i.test(norm)) {
    return 'No';
  }
  if (/minimum educational requirements/i.test(norm)) {
    return 'Yes';
  }
  if (/highest level of education completed/i.test(norm)) {
    return "Bachelor's Degree";
  }
  if (/please select the veteran status which most accurately/i.test(norm)) {
    return 'No, I am not a veteran';
  }
  if (/protected veteran categories/i.test(norm)) {
    return 'I am not a protected veteran.';
  }
  if (/please select the race which most accurately/i.test(norm)) {
    return 'Asian';
  }
  if (/prior employment.*contractor|medtronic.*covidien|covidien.*subsidiar/i.test(norm)) {
    return 'No';
  }
  if (/are you 18 years/i.test(norm)) {
    return 'Yes';
  }
  if (/legally authorized to work in the united states/i.test(norm)) {
    return 'Yes';
  }
  if (/authorized to work lawfully in the united states/i.test(norm)) {
    return 'Yes';
  }
  if (/north dakota.*wyoming.*puerto rico|us virgin islands.*employment/i.test(norm)) {
    return 'No';
  }
  if (/mass general brigham affiliate|worked at one of the mass general/i.test(norm)) {
    return 'No';
  }
  // Sponsorship and visa labels must come from the profile/Supabase chain, not
  // from a hardcoded default. The provenance gate blocks them downstream anyway,
  // but returning null here is cleaner and avoids the 'No' assumption.
  if (/require sponsorship for employment visa/i.test(norm)) {
    return null;
  }
  if (/target salary/i.test(norm)) {
    return null;
  }
  if (/would you consider relocating for this role/i.test(norm)) {
    return 'Yes, I would consider relocating for this role';
  }
  if (/non.?compete|non.?solicitation restrictions/i.test(norm)) {
    return 'No';
  }
  if (/use or work on the workday system/i.test(norm)) {
    return 'No, I do not use the Workday system in my current job';
  }
  if (/authorized to work in the country where this job is located/i.test(norm)) {
    return 'Yes';
  }
  if (/require any immigration filing or visa sponsorship/i.test(norm)) {
    return null;
  }
  if (/current or former employee of the united states government/i.test(norm)) {
    return 'No';
  }
  if (/iran.*cuba.*north korea.*syria|export control laws/i.test(norm)) {
    return 'No';
  }
  if (/related to a current workday employee/i.test(norm)) {
    return 'No';
  }
  if (/related to an employee of a customer.*government official/i.test(norm)) {
    return 'No';
  }
  if (/ernst.*young|ey.*auditor/i.test(norm)) {
    return 'No';
  }
  if (/mutual\s*arbitration\s*agreement/i.test(norm) || /to\s+be\s+considered\s+for\s+employment.*mutual\s*arbitration\s*agreement/i.test(norm) || /applicants\s+will\s+not\s+be\s+considered.*mutual\s*arbitration\s*agreement/i.test(norm)) {
    return 'I have read and agree to the Mutual Arbitration Agreement';
  }
  if (/non\s*disclosure\s*agreement/i.test(norm)) {
    return 'I have read and agree to the Non Disclosure Agreement';
  }
  if (isCurrentDateQuestionLabel(label)) {
    return getTodayMMDDYYYY('Asia/Kolkata');
  }
  if (/please\s+check\s+one\s+of\s+the\s+boxes/i.test(norm)) {
    return 'No, I do not have a disability and have not had one in the past';
  }
  if (norm === 'language' || /^language$/i.test(norm)) {
    return 'English';
  }
  if (/enter your name.*agency|name of your agency.*if applicable/i.test(norm)) {
    return WORKDAY_NA_ANSWER;
  }
  if (norm === 'name' || /please\s+enter\s+your\s+name/i.test(norm)) {
    return null;
  }

  const exactMatch = WORKDAY_DEFAULT_QA.find(({ question }) => {
    const qn = normalizeLabel(question);
    return norm === qn || norm.includes(qn) || qn.includes(norm);
  });
  if (exactMatch) return exactMatch.answer;

  // Fuzzy word-overlap fallback: skip for high-trust labels (sponsorship, diploma,
  // relatives, start-date) to prevent them from being answered by a coincidental
  // word match in WORKDAY_DEFAULT_QA.
  const HIGH_TRUST_RE = /sponsor|visa|diploma|high\s*school|g\.e\.d|minimum.*education|educational.*requirement|relative|prior.*worker|start\s*date|available.*start/i;
  for (const { question, answer } of WORKDAY_DEFAULT_QA) {
    const qn = normalizeLabel(question);
    if (qn.length < 12 || norm.length < 12) continue;
    if (/please select one of the below options/i.test(qn) && /affiliate|mass general|18 years|authorized to work/i.test(norm)) {
      continue;
    }
    // Skip any QA pair whose question or label involves high-trust domains.
    if (HIGH_TRUST_RE.test(qn) || HIGH_TRUST_RE.test(norm)) continue;
    const qWords = new Set(qn.split(' ').filter(w => w.length > 4));
    const overlap = [...qWords].filter(w => norm.includes(w)).length;
    if (overlap >= 3 && overlap >= Math.min(3, Math.max(2, Math.ceil(qWords.size * 0.35)))) {
      return answer;
    }
  }
  return null;
}
