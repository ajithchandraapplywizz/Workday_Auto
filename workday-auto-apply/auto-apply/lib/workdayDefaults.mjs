/**
 * workdayDefaults.mjs — Default Workday application / disclosure answers
 *
 * Merged into profile.qa_answers on load for fuzzy matching on every application.
 */

import { normalizeLabel } from './qaStore.mjs';
import { getTodayMMDDYYYY, isCurrentDateQuestionLabel } from './date-utils.mjs';

/** Default leaf answer for "How did you hear about us?" — used when profile has no override. */
export const WORKDAY_DEFAULT_SOURCE = 'LinkedIn';

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
  ['Job Sites', 'LinkedIn'],
  ['Job Sites', 'Indeed'],
  ['Job Sites', 'Glassdoor'],
  ['External Career Websites', 'Anthropic'],
  ['External Career Website', 'Anthropic'],
];

/** Default Work Experience (Booz Allen / general Workday My Experience). */
export const WORKDAY_DEFAULT_EXPERIENCE = {
  current_title: 'Full stack Intern',
  current_company: 'Student spot',
  location: 'Hybrid',
  from_date: '06/2025',
  to_date: '08/2025',
  description: "Full stack Intern developed websites and automation worked with agents Rags and LLM's",
  currently_working: false,
};

/** Default answer for Workday address City input fields. */
export const WORKDAY_DEFAULT_CITY = 'Hyderabad';

/** Default Education — searchable school "Other", Bachelor's, Computer Science. */
export const WORKDAY_DEFAULT_EDUCATION = {
  university: 'Other',
  degree: "Bachelor's",
  major: 'Computer Science',
  highest_level: 'Bachelors of Technology',
  from_year: '2022',
  to_year: '2026',
  field_of_study_hierarchy: ['Computer Science'],
};

/** Field of Study parent → child attempts (hierarchical dropdown). */
export const WORKDAY_FIELD_OF_STUDY_HIERARCHY = ['Computer Science'];

export const WORKDAY_FIELD_OF_STUDY_ATTEMPTS = [
  ['Computer Science'],
  ['Engineering', 'Computer Science'],
  ['Engineering', 'Computer Engineering'],
  ['All', 'Computer Science'],
];

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
    question: 'Please indicate whether you are in one or more of the protected veteran categories.',
    answer: 'I am not a protected veteran.',
  },
  {
    question: 'Yes, I have read and consent to the terms and conditions',
    answer: 'Yes',
  },
  {
    question: 'Phone Device Type',
    answer: 'Mobile',
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
    question: 'Please enter your name:',
    answer: 'John Cena',
  },
  {
    question: 'Please check one of the boxes below:',
    answer: 'No, I do not have a disability and have not had one in the past',
  },
  {
    question: 'Name',
    answer: 'John Cena',
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
    answer: '4 Weeks',
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
  for (const { question, answer } of WORKDAY_DEFAULT_QA) {
    const key = normalizeLabel(question);
    if (!profile.qa_answers[key]) {
      profile.qa_answers[key] = answer;
    }
  }
  if (!profile.eeo?.gender) {
    if (!profile.eeo) profile.eeo = {};
    profile.eeo.gender = 'Male';
  }
  if (!profile.work_auth?.willing_to_relocate) {
    if (!profile.work_auth) profile.work_auth = {};
    profile.work_auth.willing_to_relocate = 'Yes, I would consider relocating for this role';
  }
  profile.experience = { ...WORKDAY_DEFAULT_EXPERIENCE, ...(profile.experience || {}) };
  profile.education = { ...WORKDAY_DEFAULT_EDUCATION, ...(profile.education || {}) };
  if (!profile.education.field_of_study_hierarchy?.length) {
    profile.education.field_of_study_hierarchy = [...WORKDAY_FIELD_OF_STUDY_HIERARCHY];
  }
  if (!profile.personal) profile.personal = {};
  if (!profile.personal.city) profile.personal.city = WORKDAY_DEFAULT_CITY;
  if (!profile.qa_answers.city) profile.qa_answers.city = WORKDAY_DEFAULT_CITY;
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

  if (/(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(norm)) {
    return null;
  }

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
  if (/^from$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.from_date;
  if (/^to$/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.to_date;
  if (/school\s*or\s*university|^school$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.university;
  if (/^degree$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.degree;
  if (/field\s*of\s*study/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.major;
  if (/highest\s*level\s*of\s*education/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.highest_level;
  if (/school\s*or\s*university|^school$/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.university;
  if (/to\s*\(actual\s*or\s*expected\)/i.test(norm)) return WORKDAY_DEFAULT_EDUCATION.to_year;
  if (/^role\s*description/i.test(norm)) return WORKDAY_DEFAULT_EXPERIENCE.description;
  if (/desired\s*start\s*date/i.test(norm)) {
    return getTodayMMDDYYYY('Asia/Kolkata');
  }
  if (/do\s+you\s+have\s+any\s+relatives\s+that\s+are\s+currently\s+employed\s+by\s+abc\s+fitness/i.test(norm)) {
    return 'No';
  }
  if (/are\s+you\s+currently\s+or\s+have\s+you\s+ever\s+worked\s+at\s+an\s+abc\s+customer\s+site/i.test(norm)) {
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
  if (norm === 'name' || /please\s+enter\s+your\s+name/i.test(norm)) {
    return null;
  }

  const exactMatch = WORKDAY_DEFAULT_QA.find(({ question }) => {
    const qn = normalizeLabel(question);
    return norm === qn || norm.includes(qn) || qn.includes(norm);
  });
  if (exactMatch) return exactMatch.answer;

  for (const { question, answer } of WORKDAY_DEFAULT_QA) {
    const qn = normalizeLabel(question);
    if (qn.length < 12 || norm.length < 12) continue;
    const qWords = new Set(qn.split(' ').filter(w => w.length > 4));
    const overlap = [...qWords].filter(w => norm.includes(w)).length;
    if (overlap >= 3 && overlap >= Math.min(3, Math.max(2, Math.ceil(qWords.size * 0.35)))) {
      return answer;
    }
  }
  return null;
}
