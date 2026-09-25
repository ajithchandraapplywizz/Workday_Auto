/**
 * intents.mjs — Stable semantic intent for a Workday question.
 * Do not collapse "have you used X?" with "how many years of X?".
 */

import { matchAnswerConcept } from '../answerConcepts.mjs';
import { isYearsQuantityQuestion, isDescribeExperienceQuestion, isProceedQuestion, isGenericTotalYearsQuestion } from '../experienceAnswer.mjs';
import { isMinimumAgeQuestion } from '../minimumAge.mjs';
import { isYesNoQuestionLabel } from '../workdayDefaults.mjs';
import { isSalaryQuestion, isHourlyWageQuestion, isComplianceSensitive } from '../qaStore.mjs';

const CONCEPT_TO_INTENT = {
  work_auth: 'work_authorization',
  sponsorship: 'sponsorship',
  relocate: 'relocation',
  salary: 'salary',
  hourly_wage: 'salary_hourly',
  start_date: 'availability',
  years_experience: 'years_experience',
  graduation_year: 'education_graduation',
  education_start: 'education_start',
  degree: 'education_degree',
  field_of_study: 'education_field',
  school: 'education_school',
  gpa: 'education_gpa',
  job_title: 'employment_title',
  company: 'employment_company',
  gender: 'eeo_gender',
  hispanic: 'eeo_hispanic',
  race: 'eeo_race',
  veteran: 'eeo_veteran',
  disability: 'eeo_disability',
  city: 'identity_city',
  phone: 'identity_phone',
  email: 'identity_email',
  date_of_birth: 'date_of_birth',
};

const HIGH_RISK = new Set([
  'work_authorization',
  'sponsorship',
  'clearance',
  'criminal_history',
  'salary',
  'salary_hourly',
  'professional_license',
  'language_proficiency',
  'management_years',
  'eeo_gender',
  'eeo_hispanic',
  'eeo_race',
  'eeo_veteran',
  'eeo_disability',
]);

export function isSignatureOrFullNameQuestion(label = '') {
  const s = String(label || '').toLowerCase().trim();
  if (/parent|guardian|representative|supervisor/i.test(s)) return false;
  if (/^(legal\s*)?name$|^full\s*name$|^candidate\s*name$/i.test(s)) return true;
  // Short-form label patterns
  if (/please\s+sign|electronic\s+signature|typed\s+name|sign\s*\(\s*type\s*name\s*\)|type\s+(your\s+)?(full\s+)?name|enter\s+(your\s+)?(full\s+)?name|your\s+typed\s+name|please\s+enter\s+your\s+name|\bsignature\b/i.test(s)) return true;
  // Long-form legal acknowledgement paragraphs that require typing your name as a signature
  if (/sign\s+to\s+acknowledge|sign.*understand|read.*sign.*acknowledge|please\s+read.*sign/i.test(s)) return true;
  if (/\bsign\b.{0,80}\btype\s*(your)?(full\s+)?name\b/i.test(s)) return true;
  return false;
}

/**
 * True for fields that ask the applicant to enter today's date (companion to signature blocks).
 */
export function isTodaysDateField(label = '') {
  const s = String(label || '').toLowerCase();
  // Never steal a label that is a signature field (sign + name) — those stay as identity_name
  if (isSignatureOrFullNameQuestion(label)) return false;
  if (/date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(s)) return false;
  return /enter\s+(the|today'?s?)\s*date|please\s+enter\s+(the\s+)?date|today'?s?\s*date|^date:?\s*\*?$|signature\s*date|date\s*(?:of\s*)?signature|date\s*signed/i.test(s);
}

export function isShiftOrScheduleQuestion(label = '') {
  const s = String(label || '').toLowerCase();
  if (/when|what\s*date|start\s*date/i.test(s)) return false;
  return /\b(shift|shifts|work\s*schedule|hours\s*available|schedule\s*preference|available\s*to\s*work|work\s*types?)\b/i.test(s)
    && !/how\s*many\s*hours/i.test(s);
}

export function pickShiftOption(options = []) {
  if (!options?.length) return '';
  const flexible = options.find((o) => /\b(any|all|flexible|open|no\s*preference)\b/i.test(o));
  if (flexible) return flexible;
  const day = options.find((o) => /\b(day|1st|first|morning|standard|regular)\b/i.test(o));
  if (day) return day;
  const any = options.find((o) => !/prn|per\s*diem|part[\s-]time|night|grave|3rd|third/i.test(o));
  if (any) return any;
  return options[0];
}

export function isSpecificManagerOrLocationQuestion(label = '') {
  const s = String(label || '').toLowerCase();
  return /specific\s+(location|manager|branch|department|facility|shift)\b/i.test(s)
    || /manager\s+(or\s+location\s+)?you\s+would\s+like/i.test(s)
    || /location\s+or\s+manager/i.test(s);
}

/**
 * @param {string} label
 * @param {object} [field]
 * @returns {string}
 */
export function classifyQuestionIntent(label = '', field = {}) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown';

  if (isSignatureOrFullNameQuestion(text)) return 'identity_name';
  if (/date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(text)) return 'date_of_birth';
  if (isTodaysDateField(text)) return 'date';
  if (isShiftOrScheduleQuestion(text)) return 'work_schedule';
  if (/limitation.*(hour|schedule|available)|restriction.*(hour|schedule|available)|limitations?\s+to\s+(the\s+)?hours/i.test(text)) {
    return 'availability_limitations';
  }
  if (/able\s+to\s+commute|commute\s+to\s+(the\s+)?(site|location|office|job)|reliable\s+(transportation|commute)/i.test(text)) {
    return 'commute_ability';
  }
  if (/highest\s*(level|degree).*(education|completed)|education\s*level/i.test(text)) {
    return 'education_degree';
  }
  if (isSpecificManagerOrLocationQuestion(text)) return 'location_preference';

  if (isMinimumAgeQuestion(text)) return 'minimum_age';
  if (isProceedQuestion(text)) return 'proceed_confirmation';
  if (isGenericTotalYearsQuestion(text)) return 'years_experience';
  if (isYearsQuantityQuestion(text)) return 'technology_years_experience';
  if (isHourlyWageQuestion(text)) return 'salary_hourly';
  if (isSalaryQuestion(text)) return 'salary';
  if (/authoriz(ed|ation)\s+to\s+work|legally\s+authoriz|eligible\s+to\s+work|work\s+authorization|right\s+to\s+work/i.test(text)
    && !/sponsor/i.test(text)) {
    return 'work_authorization';
  }
  if (/sponsor|immigration\s+case|visa\s+sponsor/i.test(text)) return 'sponsorship';
  if (/security\s*clearance|secret\s*clearance|ts.?sci/i.test(text)) return 'clearance';
  if (/felony|criminal|conviction|misconduct|disciplin/i.test(text)) return 'criminal_history';
  if (/professional\s*licen[cs]e|are you licensed/i.test(text)) return 'professional_license';
  if (/language\s*proficien|fluent in|native language/i.test(text)) return 'language_proficiency';
  if (/how many years.{0,40}(manag|supervis|lead)/i.test(text)) return 'management_years';

  if (isYearsQuantityQuestion(text)) {
    return isGenericTotalYearsQuestion(text) ? 'years_experience' : 'technology_years_experience';
  }
  if (isHourlyWageQuestion(text)) return 'salary_hourly';
  if (isSalaryQuestion(text)) return 'salary';

  if (/do you have (any )?(experience|expertise|worked).{0,60}(with|in|using|on)\b/i.test(text)
    || /are you (proficient|experienced|familiar) (with|in)\b/i.test(text)
    || /have you (ever )?(used|worked with|built)\b/i.test(text)) {
    return 'technology_experience';
  }
  if (isDescribeExperienceQuestion(text)) return 'describe_experience';

  const concept = matchAnswerConcept(text);
  if (concept?.id && CONCEPT_TO_INTENT[concept.id]) return CONCEPT_TO_INTENT[concept.id];
  if (concept?.id) return concept.id;

  if (isComplianceSensitive(text)) return 'compliance_other';
  if (isYesNoQuestionLabel(text)) return 'yes_no';

  const el = field.elementType || field.controlType || field.fieldType || '';
  if (/email/i.test(el)) return 'identity_email';
  if (/tel|phone/i.test(el)) return 'identity_phone';
  if (/date/i.test(el)) return 'date';
  if (/number/i.test(el)) return 'numeric';
  return 'unknown';
}

export function isHighRiskIntent(intent = '') {
  return HIGH_RISK.has(String(intent || ''));
}

export function intentsAreCompatible(a, b) {
  return Boolean(a && b && a === b);
}

export { HIGH_RISK };
