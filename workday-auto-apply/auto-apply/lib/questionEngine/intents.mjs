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

/**
 * @param {string} label
 * @param {object} [field]
 * @returns {string}
 */
export function classifyQuestionIntent(label = '', field = {}) {
  const text = String(label || field.label || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown';

  if (isMinimumAgeQuestion(text)) return 'minimum_age';
  if (isProceedQuestion(text)) return 'proceed_confirmation';
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
