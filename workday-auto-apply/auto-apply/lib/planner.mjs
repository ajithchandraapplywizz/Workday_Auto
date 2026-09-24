/**
 * planner.mjs — Auto-generate fill plan from scan + profile
 *
 * Maps scanned field labels to profile YAML keys automatically.
 * Unknown required fields: Apply Wizz client profile → LLM closest match.
 * Terminal Q&A is off unless FORM_ANSWER_TERMINAL=1.
 */

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import readline from 'readline/promises';
import { fuzzyScore, findBestOptionMatch } from './fields.mjs';
import { normalizeLabel, createQAStore, isComplianceSensitive, saveAnswerToYaml, isSalaryQuestion, isHourlyWageQuestion } from './qaStore.mjs';
import { detectControlType } from './scanner.mjs';
import { hydrateProfileFromApplyWizz, isApplyWizzConfigured } from './applyWizzClient.mjs';
import {
  mergeWorkdayDefaultAnswers,
} from './workdayDefaults.mjs';
import { resolveClientAnswer } from './clientAnswer.mjs';
import { resolveDynamicAnswer } from './questionEngine/index.mjs';
import { buildCurrentDateAction, getTodayMMDDYYYY } from './date-utils.mjs';
import { getWorkdayPlatform, getWorkdayTenant } from './discovery.mjs';
import { collectLiveFieldOptions } from './workdayDom.mjs';
import { resolveUnknownWithLlm } from './openRouterLlm.mjs';
import { shouldIncludeInScan, isSkippableUnimportantLabel, isMandatoryField, shouldSkipOptionalFill } from './scanFieldFilter.mjs';
import { resolveMinimumAgeAnswer } from './minimumAge.mjs';
import { ensureUsWorkdayContact } from './clientContact.mjs';
import { normalizePersonalNames, toTitleCase } from './personName.mjs';
import { getResumePathForApply } from './resumeParser.mjs';
import {
  isSignatureOrFullNameQuestion,
  isShiftOrScheduleQuestion,
  isSpecificManagerOrLocationQuestion,
} from './questionEngine/intents.mjs';
import { isApiOnlyAnswerMode, applyApiOnlyProfileGuards } from './apiOnlyProfile.mjs';

// ─── Field label → profile key mapping ──────────────────────────────────────
// Each entry: [regex to match field label, path in profile.yml, optional transform]
export const FIELD_MAP = [
  // Personal
  [/^(legal\s*)?(first|given)\s*name(\s*local)?(\s*\(?s?\)?)?$|^legalName--firstNameLocal$|^legalName--firstName|^given name/i, 'personal.first_name'],
  [/^(legal\s*)?(last|family|surname)\s*name(\s*local)?(\s*\(?s?\)?)?$|^legalName--lastNameLocal$|^legalName--lastName|^family name/i, 'personal.last_name'],
  [/local\s*given\s*name/i, 'personal.first_name'],
  [/local\s*family\s*name/i, 'personal.last_name'],
  [/^(full\s*)?name$/i, 'personal.full_name'],  // resolved as first + last
  [/^email/i, 'personal.email'],
  [/phone\s*device\s*type/i, '_static.Mobile'],
  [/are\s*you\s*bilingual\?/i, '_static.No'],
  [/do\s*you\s*have\s*any\s*relatives\s*that\s*are\s*currently\s*employed\s*by\s*abc\s*fitness\?/i, '_static.No'],
  [/are\s*you\s*currently\s*or\s*have\s*you\s*ever\s*worked\s*at\s*an\s*abc\s*customer\s*site\?/i, '_static.No'],
  [/are\s*you\s*18\s*years\s*(of\s*age\s*)?or\s*older/i, '_static.Yes'],
  [/legally\s*authorized\s*to\s*work\s*in\s*the\s*united\s*states/i, '_static.Yes'],
  [/reside.*north\s*dakota.*wyoming.*puerto\s*rico|us\s*virgin\s*islands.*employment/i, '_static.No'],
  [/mass\s*general\s*brigham\s*affiliate|worked\s*at\s*one\s*of\s*the\s*mass\s*general/i, '_static.No'],
  [/require\s*sponsorship\s*for\s*employment\s*visa/i, '_static.No'],
  [/have\s*you\s*ever\s*been\s*employed\s*by\s*3m\s*or\s*a\s*subsidiary/i, '_static.No'],
  [/have\s*you\s*been\s*employed\s*by\s*pricewater\s*coopers\s*\(pwc\)\?/i, '_static.No'],
  [/have\s*you\s*signed\s*an\s*agreement\s*with\s*a\s*current\/previous\s*employer.*non-competition|non-solicitation/i, '_static.No'],
  [/are\s*you\s*or\s*a\s*household\s*member.*state\s*government.*united\s*states\s*government/i, '_static.No'],
  [/have\s*you\s*or\s*a\s*household\s*member.*state\s*government.*united\s*states\s*government.*past/i, '_static.No'],
  [/are\s*you\s*currently\s*or\s*have\s*you\s*in\s*the\s*past\s*provided\s*services\s*to\s*3m\s*as\s*a\s*contract\s*worker\s*or\s*consultant\?/i, '_static.No'],
  [/do\s*you\s*have\s*a\s*relative\s*presently\s*employed\s*at\s*or\s*retired\s*from\s*3m\?/i, '_static.No'],
  [/are\s*you\s*currently.*employed\s*by\s*epic\s*systems\s*corporation\?/i, '_static.No'],
  [/do\s*you\s*possess\s*deep\s*understanding\s*of\s*data\s*product\s*management\s*principles.*domain\s*ownership.*data\s*mesh.*data\s*contracts.*value\s*stream\s*mapping.*outcome-driven\s*metrics.*enterprise-wide\s*business\s*value/i, '_static.Yes'],
  [/do\s*you\s*possess\s*a\s*bachelor['’]?s\s*degree\s*or\s*higher/i, '_static.Yes'],
  [/do\s*you\s*have\s*a\s*minimum\s*of\s*ten\s*\(10\)\s*years.*sourcing.*procurement.*logistics.*supply\s*chain.*engineering.*manufacturing/i, '_static.Yes'],
  [/do\s*you\s*have\s*experience\s*in\s*procurement.*molding\s*suppliers/i, '_static.Yes'],
  [/please\s*select\s*your\s*sex|^sex$/i, '_static.Male'],
  [/^gender$|^sex$/i, 'eeo.gender'],
  [/hispanic\s*or\s*latino|^hispanic$/i, 'eeo.hispanic_latino'],
  [/race\/ethnicity|^race ethnicity$|^race$|^ethnicity$/i, 'eeo.race'],
  [/^veteran status$/i, 'eeo.veteran_status'],
  [/please\s*select\s*your\s*race-ethnicity/i, '_static.Asian \(United States of America\)'],
  [/please\s*indicate\s*whether\s*you\s*are\s*in\s*one\s*or\s*more\s*of\s*the\s*protected\s*veteran\s*categories/i, '_static.I am not a protected veteran.'],
  [/i confirm that i understand and agree.*privacy statement/i, '_static.Yes'],
  [/yes,\s*i\s*have\s*read\s*and\s*consent\s*to\s*the\s*terms\s*and\s*conditions/i, '_static.Yes'],
  [/i\s*certify\s*that\s*i\s*have\s*read.*foregoing\s*statement/i, '_static.Yes'],
  [/type to add skills|enter a skill below/i, 'skills'],
  [/relative of a current public official/i, '_static.No'],
  [/relative of a current senior level person or senior commercial person/i, '_static.No'],
  [/if yes.*relationship with this individual/i, '_static.N/A'],
  [/if yes.*institution name and level/i, '_static.N/A'],
  [/enter\s*n\/?a\s*if\s*not\s*applicable/i, '_static.N/A'],
  [/please select one of the below options(?!\s*['']?\s*yes)/i, '_static.I am completing the application and anti-corruption questions on behalf of myself.'],
  [/enter your name.*agency.*n\/?a/i, '_static.N/A'],
  [/country\s*(\/\s*territory\s*)?phone\s*code|^phoneNumber--countryPhoneCode/i, 'personal.country_phone_code'],
  [/^phone\s*number|^phoneNumber--phoneNumber$|^phone$/i, 'personal.phone'],
  [/phone\s*extension|^phoneNumber--extension$/i, 'personal.phone_extension'],
  [/linkedin/i, 'personal.linkedin'],
  [/portfolio|website|url|shared\s*url/i, 'personal.linkedin'],
  [/^state$|^address--state/i, 'personal.state'],
  [/^postal\s*code$|^zip|^address--postalCode/i, 'personal.postal_code'],
  [/^address\s*line\s*1(\s*-\s*local)?$|^address--addressLine1/i, 'personal.address_line1'],
  [/^address\s*line\s*2(\s*-\s*local)?$|^address--addressLine2/i, 'personal.address_line2'],
  [/^city(\s*-\s*local)?$|^address--city/i, 'personal.city'],
  [/^location$/i, 'experience.location'],
  [/^country$/i, 'personal.country'],
  [/^(?!.*phone).*address/i, 'personal.address_line1'],

  // Work auth & eligibility
  [/conflict\s*of\s*interest/i, '_static.No'],
  [/current\s*contractor/i, '_static.No'],
  [/i\s+understand\s+that\s+upon\s+employment.*legal\s+right\s+to\s+work.*i-9/i, '_static.Yes'],
  [/do\s+you\s+have\s+the\s+unrestricted\s+right\s+to\s+work\s+in\s+the\s+country\s+to\s+which\s+you('re| are)\s+applying/i, '_static.No'],
  [/will\s+you\s+now\s+or\s+could\s+you\s+in\s+the\s+future\s+require\s+sponsorship/i, '_static.No'],
  [/government\s+employment.*last\s+5\s+years.*u\.s\.?\s*(federal|state|local)\s+government|u\.s\.\s*armed\s+services/i, '_static.No'],
  [/post-government\s+employment\s+restrictions|i\s+attest.*no\s+post-government\s+employment\s+restrictions/i, '_static.Yes'],
  [/debarred|suspended|proposed\s+for\s+debarment|ineligible\s+for\s+award\s+of\s+a\s+contract/i, '_static.No'],
  [/citizen.*iran.*cuba.*north\s*korea.*syria|iran.*cuba.*north\s*korea.*syria/i, '_static.No'],
  [/regarding\s+future\s+positions\s+at\s+salesforce.*select\s+one.*following\s+options/i, '_static.Yes'],
  [/i\s+acknowledge\s+that\s+i\s+have\s+read.*above\s+questions.*truthfully\s+and\s+accurately/i, '_static.Yes'],
  [/sponsor|visa/i, 'work_auth.sponsorship_needed'],
  [/authorized.*work|legally.*work|eligible.*work|work.*authorization/i, 'work_auth.authorized_us'],

  // Availability & work type
  [/when.*available.*start|available.*to.*start|when.*can.*you.*start|desired.*start.*date|earliest.*start/i, '_dynamic.today'],
  [/work\s*types?|employment\s*types?|what.*schedule|shift\s*preference|available\s*for|^full[-\s]?time$/i, '_static.Full-time'],

  // EEO & Disclosures
  [/please\s*select\s*your\s*gender/i, '_static.Male'],
  [/please\s*select\s*your\s*sex/i, '_static.Male'],
  [/please\s*select\s*your\s*race-ethnicity/i, 'eeo.race'],
  [/ethnicity\s*single\s*selection/i, 'eeo.race'],
  [/yes,\s*i\s*have\s*read\s*and\s*consent\s*to\s*the\s*terms\s*and\s*conditions/i, '_static.Yes'],
  [/please\s*select\s*yes\s*if\s*hispanic/i, '_static.No'],
  [/minimum\s*educational\s*requirements/i, '_static.Yes'],
  [/highest\s*level\s*of\s*education\s*completed/i, '_static.Bachelor\'s Degree'],
  [/please\s*select\s*the\s*veteran\s*status\s*which\s*most\s*accurately/i, 'eeo.veteran_status'],
  [/please\s*select\s*the\s*race\s*which\s*most\s*accurately/i, 'eeo.race'],
  [/^gender\s*$/i, 'eeo.gender'],
  [/hispanic|latino/i, 'eeo.hispanic_latino'],
  [/race|ethnicity/i, 'eeo.race'],
  [/veteran/i, 'eeo.veteran_status'],
  [/disability/i, 'eeo.disability_status'],
  [/consent.*recorded.*interview|recorded\s*workday\s*interview/i, '_static.Yes'],
  [/non.?compete|non.?solicitation/i, '_static.No'],
  [/use.*work on.*workday\s*system|workday\s*system.*current\s*job/i, '_static.No, I do not use the Workday system in my current job'],
  [/united\s*states\s*government|us\s*government\s*employee/i, '_static.No'],
  [/iran.*cuba.*north\s*korea|export\s*control/i, '_static.No'],
  [/related.*workday\s*employee/i, '_static.No'],
  [/related.*customer.*government\s*official/i, '_static.No'],
  [/ernst.*young|ey.*auditor/i, '_static.No'],
  [/enter.*yes.*acknowledge|answered\s*them\s*truthfully/i, '_static.Yes'],
  [/vibe\s*philosophy|recruitment\s*privacy\s*statement.*vibe/i, '_static.Yes'],
  [/please\s+enter\s+your\s+name/i, 'personal.full_name'],
  [/^name$/i, 'personal.full_name'],
  [/please\s+check\s+one\s+of\s+the\s+boxes\s+below/i, 'eeo.disability_status'],
  [/have you read and agree.*non\s*disclosure|non\s*disclosure\s*agreement/i, '_static.I have read and agree to the Non Disclosure Agreement'],
  [/click on the link below to review the.*non disclosure agreement|non disclosure agreement.*do not agree/i, '_static.I have read and agree to the Non Disclosure Agreement'],
  [/have you read and agree.*mutual\s*arbitration|mutual\s*arbitration\s*agreement/i, '_static.I have read and agree to the Mutual Arbitration Agreement'],
  [/click on the link below to review the.*arbitration agreement|to be considered for employment, all applicants must agree to the mutual arbitration agreement.*applicants will not be considered for employment|to be considered for employment.*mutual arbitration agreement.*not in receipt.*agreement/i, '_static.I have read and agree to the Mutual Arbitration Agreement'],

  // Education
  [/degree/i, 'education.degree'],
  [/major|field\s*of\s*study/i, 'education.major'],
  [/university|school|college|institution/i, 'education.university'],
  [/graduation\s*year|year\s*of\s*graduation|graduat(?:ion)?\s*(?:year|date)|when\s*(did|do|will)\s*you\s*(expect\s*to\s*)?graduat|expected\s*graduation|education\s*(end|to|completion)\s*(year|date)/i, 'education.to_year'],
  [/gpa|grade/i, 'education.gpa'],

  // Experience
  [/years?\s*(of\s*)?experience/i, 'experience.years'],
  [/^job\s*title$/i, 'experience.current_title'],
  [/^company$/i, 'experience.current_company'],
  [/current\s*(company|employer)/i, 'experience.current_company'],
  [/current\s*(title|role|position)/i, 'experience.current_title'],
  [/^from$/i, 'experience.from_date'],
  [/^to$/i, 'experience.to_date'],
  [/currently\s*work\s*here/i, '_static.false'],
  [/role\s*description|job\s*description/i, 'experience.description'],
  [/^notice\s*period/i, 'experience.notice_period'],
  [/desired\s*start\s*date|start\s*date|available|earliest/i, 'experience.start_date'],
  [/highest\s*level\s*of\s*education/i, 'education.highest_level'],
  [/to\s*\(actual\s*or\s*expected\)/i, 'education.to_year'],
  [/career\s*returner/i, '_static.No'],

  // Office / hybrid / location
  [/office|on-?site|in-?person|hybrid|come\s*into/i, 'work_auth.office_willing'],
  [/consider\s*relocat|relocat.*for\s*this\s*role/i, 'work_auth.willing_to_relocate'],
  [/^remote\s*only/i, 'work_auth.remote_preference'],
  [/currently\s*(located|based)\s*(in\s*the)?\s*US/i, 'work_auth.authorized_us'],
  [/preferred\s*(first\s*)?name/i, 'personal.first_name'],

  // Prior worker / employed before / candidateIsPreviousWorker (#hopz4)
  [/prior\s*employment.*contractor|medtronic.*covidien|covidien.*subsidiar/i, '_static.No'],
  [/prior\s*worker|previously\s*worked|former\s*employee|employed.*in\s*the\s*past|self\s*identify.*prior|candidateIsPreviousWorker|^#?hopz4$/i, '_static.No'],

  // Referral source — filled only via workdaySource.mjs (DOM click, not profile.country_phone_code)
  [/referral|^source(--source)?$|^source$/i, 'personal.source'],

  // Consent & Agreement (including Workday dynamic checkboxes like x34r4)
  [/consent.*terms|terms\s*and\s*conditions|agree.*terms|^x34r4$/i, 'personal.consent_agreement'],
  [/consent.*terms|terms\s*and\s*conditions|agree.*terms|^x34r4$/i, '_static.true'],
];

// ─── Load profile ───────────────────────────────────────────────────────────
async function loadProfileFromApiOnly() {
  const profile = applyApiOnlyProfileGuards({
    personal: {},
    work_auth: {},
    eeo: {},
    education: {},
    experience: {},
    skills: [],
    qa_answers: {},
  });
  console.log('  🌐 Profile mode: API-only (Apply Wizz → resume → LLM). Local YAML/Q&A DB disabled.');
  await hydrateProfileFromApplyWizz(profile);
  if (!profile._applyWizzHydrated && !isApplyWizzConfigured()) {
    console.warn('  ⚠️  Apply Wizz not configured — set APPLYWIZZ_ID in .env; using resume + LLM only.');
  }
  if (profile.personal) profile.personal = normalizePersonalNames(profile.personal);
  await ensureUsWorkdayContact(profile);
  profile._mandatoryOnlyFill = true;
  profile._resumePath = await getResumePathForApply(profile).catch(() => null);
  return profile;
}

export async function loadProfile(profilePath) {
  if (isApiOnlyAnswerMode()) {
    return loadProfileFromApiOnly();
  }

  const raw = await readFile(profilePath || resolve(process.cwd(), 'config', 'profile.yml'), 'utf-8');
  const profile = yaml.load(raw);

  if (profile.personal) {
    profile.personal = normalizePersonalNames(profile.personal);
    // If city isn't explicitly set, extract from location
    if (!profile.personal.city && profile.personal.location) {
      profile.personal.city = profile.personal.location.split(',')[0].trim();
    }
    // If state isn't explicitly set, extract from location
    if (!profile.personal.state && profile.personal.location) {
      const parts = profile.personal.location.split(',');
      if (parts.length > 1) profile.personal.state = parts[1].trim();
    }
  }

  if (!profile.qa_answers || typeof profile.qa_answers !== 'object') {
    profile.qa_answers = {};
  }

  mergeWorkdayDefaultAnswers(profile);
  await hydrateProfileFromApplyWizz(profile);
  if (profile.personal) profile.personal = normalizePersonalNames(profile.personal);
  await ensureUsWorkdayContact(profile);

  // Default: only fill mandatory (*) fields unless profile explicitly opts in
  if (profile._fillOptionalFields !== true) {
    profile._mandatoryOnlyFill = true;
  }

  if (!profile.personal?.phone) {
    console.warn('⚠️  No phone on file after Apply Wizz + contact bootstrap — My Information phone may fail.');
  }

  return profile;
}

// ─── Get value from nested path ─────────────────────────────────────────────
export function getNestedValue(obj, path) {
  // graduation_year alias → to_year (Apply Wizz stores end year as to_year)
  if (path === 'education.graduation_year' && obj?.education) {
    const g = obj.education.graduation_year || obj.education.to_year;
    if (g != null && g !== '') return g;
  }
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

const TENANT_OVERRIDE_CACHE = new Map();

function parseTenantOverrideEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (Array.isArray(entry) && entry.length >= 2) {
    return [new RegExp(String(entry[0]), 'i'), entry[1]];
  }
  if (typeof entry.regex === 'string' && entry.path) {
    return [new RegExp(entry.regex, entry.flags || 'i'), entry.path];
  }
  return null;
}

function loadTenantOverrideRules(tenant = '') {
  if (isApiOnlyAnswerMode()) return [];
  const resolvedTenant = String(tenant || '').trim().toLowerCase();
  if (!resolvedTenant || resolvedTenant === 'unknown') return [];
  if (TENANT_OVERRIDE_CACHE.has(resolvedTenant)) return TENANT_OVERRIDE_CACHE.get(resolvedTenant);

  const overridePath = resolve(process.cwd(), 'config', 'tenant-overrides', `${resolvedTenant}.yml`);
  try {
    const source = readFileSync(overridePath, 'utf-8');
    const doc = yaml.load(source) || {};
    const rawEntries = Array.isArray(doc.field_overrides) ? doc.field_overrides : Array.isArray(doc.field_map) ? doc.field_map : [];
    const parsed = rawEntries
      .map(parseTenantOverrideEntry)
      .filter(Boolean);
    TENANT_OVERRIDE_CACHE.set(resolvedTenant, parsed);
    return parsed;
  } catch {
    TENANT_OVERRIDE_CACHE.set(resolvedTenant, []);
    return [];
  }
}

// ─── Map label to profile value ─────────────────────────────────────────────
export function mapLabelToProfileValue(label, profile, options = {}) {
  if (!label || !profile) return null;
  const cleanLabel = label.replace(/\*+/g, '').trim();
  const tenant = options.tenant || (options.url ? getWorkdayTenant(options.url) : '');

  if (isSkipSocialLinkLabel(cleanLabel)) return null;

  if (/how\s*did\s*you\s*hear/i.test(cleanLabel)) {
    return null;
  }

  if (/field\s*of\s*study/i.test(cleanLabel)) {
    const hier = profile.education?.field_of_study_hierarchy;
    if (Array.isArray(hier) && hier.length >= 2) return hier;
    if (profile.education?.major) return profile.education.major;
  }

  if (/external\s*career\s*site\s*sources/i.test(cleanLabel) || /anthropic/i.test(cleanLabel)) {
    return ['External Career Site Sources', 'Anthropic'];
  }

  if (isSignatureOrFullNameQuestion(cleanLabel)) {
    const p = profile.personal || {};
    const fullName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || profile.name || '';
    if (fullName) return toTitleCase(fullName);
  }

  if (isShiftOrScheduleQuestion(cleanLabel)) {
    return 'Flexible';
  }

  if (isSpecificManagerOrLocationQuestion(cleanLabel)) {
    return 'N/A';
  }

  const overrideRules = loadTenantOverrideRules(tenant);
  for (const [regex, path] of overrideRules) {
    if (regex.test(cleanLabel)) {
      if (path.startsWith('_dynamic.today')) {
        // Prefer the stored profile date (available_to_start or experience.start_date)
        // over today's date. Today is only a fallback when the profile has no date.
        const storedDate =
          getNestedValue(profile, 'experience.available_to_start')
          || getNestedValue(profile, 'experience.start_date');
        if (storedDate) return String(storedDate);
        return getTodayMMDDYYYY('Asia/Kolkata');
      }
      if (path.startsWith('_static.')) {
        // Invented Yes/No/Male answers — never use. Apply Wizz or LLM must decide.
        continue;
      }
      const val = getNestedValue(profile, path);
      if (val !== undefined && val !== null && val !== '') {
        const res = Array.isArray(val) ? val : String(val);
        if (typeof res === 'string' && (path.includes('first_name') || path.includes('last_name') || path.includes('middle_name') || path.includes('full_name'))) {
          return toTitleCase(res);
        }
        return res;
      }
    }
  }

  for (const [regex, path] of FIELD_MAP) {
    if (regex.test(cleanLabel)) {
      if (path.startsWith('_dynamic.today')) {
        // Prefer the stored profile date (available_to_start or experience.start_date)
        // over today's date. _dynamic.today is an assumption, not a fact.
        const storedDate =
          getNestedValue(profile, 'experience.available_to_start')
          || getNestedValue(profile, 'experience.start_date');
        if (storedDate) return String(storedDate);
        return getTodayMMDDYYYY('Asia/Kolkata');
      }
      if (path.startsWith('_static.')) {
        continue;
      }
      const val = getNestedValue(profile, path);
      if (val !== undefined && val !== null && val !== '') {
        const res = Array.isArray(val) ? val : String(val);
        if (typeof res === 'string' && (path.includes('first_name') || path.includes('last_name') || path.includes('middle_name') || path.includes('full_name'))) {
          return toTitleCase(res);
        }
        return res;
      }
    }
  }
  return null;
}

function inferDomFieldType(field = {}) {
  const rawType = String(field.type || '').toLowerCase();
  const role = String(field.role || '').toLowerCase();
  const automationId = String(field.automationId || field.dataAutomationId || '').toLowerCase();
  const tag = String(field.tag || '').toLowerCase();
  const inputType = String(field.inputType || '').toLowerCase();

  if (rawType === 'select' || rawType === 'custom-select' || role === 'combobox' || automationId.includes('select') || automationId.includes('prompt')) return 'dropdown/select';
  if (rawType === 'checkbox-group') return 'multi-select (checkboxes)';
  if (rawType === 'checkbox' || role === 'checkbox' || inputType === 'checkbox') return 'checkbox';
  if (rawType === 'radio' || role === 'radio' || inputType === 'radio') return 'radio';
  if (rawType === 'file' || inputType === 'file') return 'file upload';
  if (rawType === 'textarea' || tag === 'textarea') return 'textarea';
  if (rawType === 'email' || rawType === 'tel' || rawType === 'text' || tag === 'input' || inputType === 'text' || inputType === 'email' || inputType === 'tel') return 'input';
  if (role.includes('listbox')) return 'dropdown/select';
  if (field.id || field.name) return 'input';
  return String(rawType || 'text' || 'input');
}

function isRequiredQuestionText(label = '', field = {}) {
  const text = String(label || '');
  const lower = text.toLowerCase();
  if (field.required || field.ariaRequired || field.required === true) return true;
  if (/\*/.test(text)) return true;
  if (/\brequired\b/i.test(lower) || /\bmandatory\b/i.test(lower) || /\bmust\s+be\s+filled\b/i.test(lower)) return true;
  return false;
}

function isSkipSocialLinkLabel(label = '') {
  return isSkippableUnimportantLabel(label);
}

function shouldPromptForUnknownField(label = '', field = {}, profile = null, step = '') {
  const text = String(label || '').trim();
  if (!text) return false;
  if (isMandatoryField(text, field) || field?.required === true) return true;
  if (isSkipSocialLinkLabel(text)) return false;

  // Optional/non-required fields are never filled or escalated (unless opt-in).
  if (profile?._fillOptionalFields === true) {
    if (isSkippableUnimportantLabel(text, field)) return false;
    return true;
  }

  return shouldIncludeInScan(text, field);
}

function normalizeOptionList(options = []) {
  return options
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function formatPromptFieldType(field = {}, inferredType = '') {
  const raw = String(field?.fieldType || field?.type || '').toLowerCase();
  const inferred = String(inferredType || '').toLowerCase();
  if (raw === 'checkbox-group' || inferred.includes('multi-select')) {
    return 'CHECKBOX (select all that apply)';
  }
  if (raw === 'radio' || inferred.includes('radio')) return 'RADIO';
  if (raw === 'dropdown' || inferred.includes('dropdown') || inferred.includes('select')) return 'DROPDOWN';
  if (raw === 'date' || inferred.includes('date')) return 'DATE INPUT';
  if (raw === 'file' || inferred.includes('file')) return 'FILE UPLOAD';
  if (raw === 'textarea' || inferred.includes('textarea')) return 'TEXT INPUT';
  return 'INPUT (type your answer)';
}

function resolvePromptAnswer(rawAnswer, options = [], { multiSelect = false } = {}) {
  const trimmed = String(rawAnswer || '').trim();
  if (!trimmed) return '';

  if (multiSelect && /[,;|]/.test(trimmed)) {
    const parts = trimmed.split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
    const resolved = parts.map((part) => resolvePromptAnswer(part, options));
    return resolved.filter(Boolean).join(', ');
  }

  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  const lower = trimmed.toLowerCase();
  const exact = options.find((opt) => opt.toLowerCase() === lower);
  if (exact) return exact;
  const partial = options.find((opt) => opt.toLowerCase().includes(lower) || lower.includes(opt.toLowerCase()));
  return partial || trimmed;
}

/** Opt-in only: FORM_ANSWER_TERMINAL=1 restores stdin prompts for form answers. */
export function isFormAnswerTerminalEnabled() {
  return process.env.FORM_ANSWER_TERMINAL === '1' || process.env.OPENROUTER_FALLBACK_TERMINAL === '1';
}

function rememberResolvedAnswer(profile, key, value) {
  if (!profile || value == null || value === '') return value;
  if (!(profile._answerCache instanceof Map)) profile._answerCache = new Map();
  profile._answerCache.set(key, value);
  return value;
}

// ─── Human Terminal Prompt ──────────────────────────────────────────────────
/** LLM first; never blocks on stdin unless FORM_ANSWER_TERMINAL=1. */
export async function safeAskHuman(questionText, field = {}, opts = {}) {
  try {
    const llmAnswer = await resolveUnknownWithLlm(questionText, field, opts);
    if (llmAnswer) return llmAnswer;
    if (!isFormAnswerTerminalEnabled()) {
      console.log(`    ⚠️  UNRESOLVED "${String(questionText).slice(0, 70)}" — Apply Wizz/YAML/profile/LLM miss (no terminal)`);
      return null;
    }
    return await askHuman(questionText, field, opts);
  } catch (err) {
    console.log(`    ⚠️  Unknown-field fallback skipped (${err.message?.slice(0, 70) || 'stdin unavailable'}) — continuing apply...`);
    return null;
  }
}

export async function askHuman(questionText, field = {}, { company, compliance, page, step } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const inferredType = inferDomFieldType(field);
    const displayType = formatPromptFieldType(field, inferredType);
    const domCode = field?.id || field?.name || field?.automationId || field?.dataAutomationId || 'unknown';
    let options = normalizeOptionList(field?.options || []);
    const isMultiSelect = displayType.includes('CHECKBOX');

    if (page && (options.length === 0 || displayType === 'DROPDOWN')) {
      const liveType = field?.fieldType || field?.type || inferredType;
      const liveOptions = await collectLiveFieldOptions(page, questionText, liveType);
      if (liveOptions.length > 0) options = liveOptions;
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(compliance ? '🔒 LIVE COMPLIANCE QUESTION' : '❓ WORKDAY QUESTION (terminal)');
    if (company) console.log(`Company:   ${company}`);
    if (step) console.log(`Step:      ${step}`);
    console.log(`Question:\n  ${questionText}`);
    console.log(`Type:      ${displayType}`);
    if (field?.required) console.log(`Required:  yes`);
    if (field?.placeholder) console.log(`Hint:      ${field.placeholder}`);

    if (options.length > 0) {
      if (displayType === 'RADIO') {
        console.log('Options (pick one):');
      } else if (isMultiSelect) {
        console.log('Options (checkbox — pick one or more, comma-separated):');
      } else if (displayType === 'DROPDOWN') {
        console.log('Dropdown options (includes submenu items when visible):');
      } else {
        console.log('Options:');
      }
      options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
      if (isMultiSelect) {
        console.log('(Enter: 1,3 or type labels — e.g. Remote, Full-time)');
      } else {
        console.log('(Enter option number or type exact label text)');
      }
    } else {
      console.log('Input:     type your answer below');
    }

    console.log(`DOM id:    ${domCode}`);
    console.log('Saved to: profile.yml + qa-store + tenant YAML');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const answer = await rl.question('> Your answer:\n');
    return resolvePromptAnswer(answer, options, { multiSelect: isMultiSelect });
  } finally {
    rl.close();
  }
}

/**
 * Pre-fill validity check: validates resolved value against what the field can actually accept.
 * Returns { valid: boolean, reason?: string, bestScore?: number }
 */
export function validateResolvedValue(field = {}, resolvedValue, options = {}) {
  if (resolvedValue === undefined || resolvedValue === null || resolvedValue === '') {
    return { valid: false, reason: 'empty_value' };
  }

  const controlType = field.controlType || detectControlType(field);
  const label = String(field.label || field.id || field.name || '');
  const threshold = options.threshold ?? 85;

  // 1. Dropdown / Checkbox / Radio: if visible options were scraped, resolvedValue must match one >= 85
  if (controlType === 'custom-dropdown' || controlType === 'native-select' || controlType === 'radio-group' || controlType === 'checkbox-group') {
    const rawOptions = field.options || [];
    if (Array.isArray(rawOptions) && rawOptions.length > 0) {
      if (controlType === 'checkbox-group') {
        const parts = (Array.isArray(resolvedValue) ? resolvedValue : String(resolvedValue).split(/[,;\n]/))
          .map(p => String(p).trim()).filter(Boolean);
        const hasAnyMatch = parts.some(p => findBestOptionMatch(p, rawOptions, threshold).matched);
        if (!hasAnyMatch) {
          return { valid: false, reason: 'checkbox_value_not_in_visible_options' };
        }
      } else {
        const match = findBestOptionMatch(resolvedValue, rawOptions, threshold);
        if (!match.matched) {
          return { valid: false, reason: 'option_not_in_visible_options', bestScore: match.bestScore };
        }
      }
    }
  }

  // 2. Date-picker: resolved value must parse as a real date
  if (controlType === 'date-picker') {
    const strVal = String(resolvedValue).trim();
    const isDatePattern = /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(strVal) || /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(strVal);
    const parsedTimestamp = Date.parse(strVal);
    if (!isDatePattern && isNaN(parsedTimestamp)) {
      return { valid: false, reason: 'invalid_date_format' };
    }
  }

  // 3. Free-text with implied numeric / salary / percentage check
  if (controlType === 'free-text' || !controlType) {
    if (isSalaryQuestion(label)) {
      const isHourly = isHourlyWageQuestion(label);
      const strVal = String(resolvedValue).trim();
      const numClean = strVal.replace(/[$,\s]/g, '');
      const num = parseFloat(numClean);

      if (isNaN(num)) {
        return { valid: false, reason: 'non_numeric_salary' };
      }

      if (isHourly) {
        if (num < 10 || num > 500) {
          return { valid: false, reason: 'implausible_hourly_wage' };
        }
      } else {
        // Expected annual salary: at least 4 digits, magnitude >= 1000 (catches "43")
        if (num < 1000 || numClean.length < 4) {
          return { valid: false, reason: 'implausible_salary_magnitude' };
        }
      }
    }

    if (/%|percent/i.test(label)) {
      const num = parseFloat(String(resolvedValue).replace(/[%\s]/g, ''));
      if (!isNaN(num) && (num < 0 || num > 100)) {
        return { valid: false, reason: 'implausible_percentage' };
      }
    }
  }

  return { valid: true };
}

// ─── Phase 2: Resolve field with Q&A store + human fallback ─────────────────
export async function resolveField(field, profile, qaStore, options = {}) {
  const { skipPrompt = true, plan, company, resumePath, url, tenant, page } = options;
  const store = qaStore || createQAStore();
  const fieldObj = typeof field === 'object' ? field : {};
  const rawLabel = typeof field === 'string' ? field : (field.label || field.id || field.name || '');
  if (!rawLabel) return null;
  if (isSkipSocialLinkLabel(rawLabel)) return null;
  if (shouldSkipOptionalFill(rawLabel, fieldObj, profile)) return null;

  const resolvedTenant = tenant || (url ? getWorkdayTenant(url) : '');
  if (url && profile && !profile._workdayPlatform) {
    profile._workdayPlatform = getWorkdayPlatform(url);
  }
  const normalized = normalizeLabel(rawLabel);
  if (profile && !(profile._answerCache instanceof Map)) profile._answerCache = new Map();
  if (profile?._answerCache?.has(normalized)) {
    return profile._answerCache.get(normalized);
  }
  const compliance = isComplianceSensitive(rawLabel);

  // For availability/start-date fields: check the profile for a stored date FIRST.
  // buildCurrentDateAction returns today's date, which would overwrite the stored
  // available_to_start (e.g. 09/20/2026) — so we must gate it.
  const { isAvailabilityStartDateLabel } = await import('./date-utils.mjs');
  if (isAvailabilityStartDateLabel(rawLabel, { label: rawLabel, question: rawLabel })) {
    const storedDate =
      profile?.experience?.available_to_start
      || profile?.experience?.start_date
      || (profile?.personal && profile.personal.available_to_start);
    if (storedDate) {
      return rememberResolvedAnswer(profile, normalized, String(storedDate));
    }
    // No profile date — fall through to the dynamic-date fallback below.
  }

  const dynamicDateAction = buildCurrentDateAction(rawLabel, {
    label: rawLabel,
    placeholder: fieldObj?.placeholder,
    name: fieldObj?.name,
    automationId: fieldObj?.automationId || fieldObj?.dataAutomationId || fieldObj?.id,
    question: rawLabel,
    timeZone: 'Asia/Kolkata',
  });
  if (dynamicDateAction) {
    return dynamicDateAction.value;
  }

  const stepName = options.step || profile?._currentStep || '';
  const requiredUnknown = shouldPromptForUnknownField(rawLabel, fieldObj, profile, stepName)
    || isMandatoryField(rawLabel, fieldObj)
    || fieldObj.required === true;

  // Centralized 4-Tier Architecture:
  // Tier 1 (Supabase) -> Tier 2 (ApplyWizz CRM) -> Tier 3 (Resume) -> Tier 4 (LLM + live options)
  const resolved = await resolveClientAnswer({
    ...fieldObj,
    label: rawLabel,
    required: requiredUnknown,
  }, profile, {
    page,
    plan,
    company,
    resumePath,
    url,
    tenant: resolvedTenant,
    step: stepName,
    required: requiredUnknown,
    forceLlm: requiredUnknown,
  });
  if (resolved?.answer) {
    const validity = validateResolvedValue(fieldObj, resolved.answer);
    if (!validity.valid) {
      console.log(`    ⚠️  Pre-fill validity check rejected "${String(resolved.answer)}" for "${rawLabel}": ${validity.reason}`);
      return null;
    }
    return rememberResolvedAnswer(profile, normalized, resolved.answer);
  }

  if (options.useQuestionEngine !== false) {
    const engineHit = await resolveDynamicAnswer(
      {
        ...fieldObj,
        label: rawLabel,
        required: requiredUnknown,
      },
      profile,
      {
        stepName,
        resumePath: resumePath || plan?.resume || profile._resumePath,
        allowLlm: requiredUnknown,
        qaStore: store,
      },
    );
    if (engineHit?.answer) {
      const validity = validateResolvedValue(fieldObj, engineHit.answer);
      if (!validity.valid) {
        console.log(`    ⚠️  Pre-fill validity check rejected "${String(engineHit.answer)}" for "${rawLabel}": ${validity.reason}`);
        return null;
      }
      return rememberResolvedAnswer(profile, normalized, engineHit.answer);
    }
  }

  if (!requiredUnknown) return null;

  if (isFormAnswerTerminalEnabled()) {
    const answer = await safeAskHuman(rawLabel, fieldObj, {
      company,
      compliance,
      page,
      profile,
      tenant: resolvedTenant,
      step: stepName,
      required: true,
    });
    if (answer && store && normalized) {
      await store.set(normalized, {
        normalized_label: normalized,
        raw_label: rawLabel,
        answer,
        source: 'user_provided',
        compliance_sensitive: compliance,
      }, resolvedTenant);
      if (!profile.qa_answers) profile.qa_answers = {};
      profile.qa_answers[normalized] = answer;
      await saveAnswerToYaml(rawLabel, answer).catch(() => {});
    }
    return rememberResolvedAnswer(profile, normalized, answer);
  }

  return null;
}

// ─── Pick resume based on JD keywords ───────────────────────────────────────
export async function pickResume(jdText, resumesPath) {
  const { findExistingResumeFile } = await import('./resumeParser.mjs');
  const raw = await readFile(resumesPath || resolve(process.cwd(), 'config', 'resumes.yml'), 'utf-8');
  const config = yaml.load(raw);
  const resumes = config.resumes || [];
  const defaultId = config.default || resumes[0]?.id;

  const toAbs = (file) => findExistingResumeFile(file) || file;

  if (resumes.length <= 1) {
    const file = resumes[0]?.file || null;
    return file ? toAbs(file) : null;
  }

  const jdLower = (jdText || '').toLowerCase();
  let bestResume = null;
  let bestScore = 0;

  for (const resume of resumes) {
    let score = 0;
    for (const kw of (resume.keywords || [])) {
      if (jdLower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestResume = resume;
    }
  }

  if (bestResume && bestScore >= 2) {
    console.log(`  📄 Resume picked: ${bestResume.label} (${bestScore} keyword matches)`);
    return toAbs(bestResume.file);
  }

  const fallback = resumes.find(r => r.id === defaultId) || resumes[0];
  console.log(`  📄 Resume: ${fallback.label} (default)`);
  return toAbs(fallback.file);
}

// ─── Generate fill plan from scan + profile ─────────────────────────────────
export async function generatePlan(scan, profile, { resumePath, jdText, url, qaStore } = {}) {
  const store = qaStore || createQAStore();
  const fills = [];
  const skipped = [];
  const unmapped = [];

  for (const field of (scan.fields || [])) {
    let label = (field.label || '').replace(/\*+/g, '').trim();
    const type = field.type;

    const dynamicDateAction = buildCurrentDateAction(label, {
      label,
      placeholder: field.placeholder,
      name: field.name,
      automationId: field.automationId || field.dataAutomationId || field.id,
      question: label,
      timeZone: 'Asia/Kolkata',
    });
    if (dynamicDateAction) {
      fills.push({
        ...field,
        value: dynamicDateAction.value,
        action: dynamicDateAction,
        payload: dynamicDateAction.payload,
      });
      continue;
    }

  const special = (() => {
    if (/external\s*career\s*site\s*sources/i.test(label) || /anthropic/i.test(label)) {
      return ['External Career Site Sources', 'Anthropic'];
    }
    return null;
  })();

    // Skip recaptcha
    if (/recaptcha/i.test(field.id) || /recaptcha/i.test(field.name) || /g-recaptcha/i.test(field.id)) {
      skipped.push({ label: label || field.id, reason: 'Cannot auto-solve reCAPTCHA' });
      continue;
    }

    // Skip duplicate radio entries (Workday scans each radio as a separate field)
    if (type === 'radio' && field.id && /\.(true|false)$/.test(field.id)) {
      const baseId = field.id.replace(/\.(true|false)$/, '');
      if (fills.some(f => f.id?.startsWith(baseId)) || skipped.some(f => f.id?.startsWith(baseId))) continue;
      field.id = baseId;
      field.name = baseId;
      const idLabel = baseId.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      if (label === 'Yes' || label === 'No') {
        field.label = idLabel;
        label = idLabel;
      }
    }

    // Skip hidden/search inputs or internal token hashes
    if (/search|select__input/i.test(field.id) || /search|select__input/i.test(field.name)) continue;
    if (!label && field.value && /^[a-f0-9]{16,}$/i.test(field.value)) {
      skipped.push({ label: field.id || 'internal_token', reason: 'Internal session token' });
      continue;
    }

    // Resume file field
    if (type === 'file') {
      const accept = field.accept || '';
      const isResume = /resume|cv/i.test(label) || /resume/i.test(field.id) || accept.includes('pdf');
      if (isResume && resumePath && !fills.some(f => f.type === 'file')) {
        fills.push({
          ...field,
          value: resumePath,
        });
      }
      continue;
    }

    // Yes/No button (Ashby pattern)
    if (type === 'yes-no-button') {
      let value = null;
      for (const [regex, path] of FIELD_MAP) {
        if (regex.test(label)) {
          value = getNestedValue(profile, path);
          break;
        }
      }
      if (value) {
        fills.push({ ...field, value });
      } else {
        unmapped.push({ label, type, reason: 'No profile mapping for yes/no question' });
      }
      continue;
    }

    // Checkbox
    if (type === 'checkbox') {
      if (/agree|consent|acknowledge|terms|privacy|x34r4/i.test(label) || /agree|consent/i.test(field.name) || /x34r4/i.test(field.id)) {
        const val = profile?.personal?.consent_agreement ?? true;
        fills.push({ ...field, value: val });
      }
      continue;
    }

    // Try to map label to profile value
    let mapped = false;
    if (special) {
      fills.push({ ...field, value: special });
      mapped = true;
    } else {
      for (const [regex, path] of FIELD_MAP) {
        if (regex.test(label)) {
          let value;
          if (path.startsWith('_static.')) {
            continue;
          } else {
            value = getNestedValue(profile, path);
          }
          if (value !== undefined && value !== null && value !== '') {
            fills.push({ ...field, value: Array.isArray(value) ? value : String(value) });
            mapped = true;
            break;
          }
        }
      }
    }

    if (!mapped && label) {
      const ageYes = resolveMinimumAgeAnswer(label, profile);
      if (ageYes) {
        fills.push({ ...field, value: ageYes });
        mapped = true;
      }
      if (!mapped && !isApiOnlyAnswerMode()) {
        const normalized = normalizeLabel(label);
        const fromProfile = profile?.qa_answers?.[normalized];
        if (fromProfile != null && fromProfile !== '') {
          fills.push({ ...field, value: Array.isArray(fromProfile) ? fromProfile : String(fromProfile) });
          mapped = true;
        } else if (store) {
          const stored = await store.get(normalized);
          if (stored != null) {
            const val = typeof stored === 'object' && stored.answer !== undefined ? stored.answer : String(stored);
            if (val) {
              fills.push({ ...field, value: Array.isArray(val) ? val : String(val) });
              mapped = true;
            }
          }
        }
      }
    }

    // Select options fuzzy matching
    if (mapped && fills.length > 0 && (type === 'select' || type === 'select-one') && field.options?.length > 0) {
      const lastFill = fills[fills.length - 1];
      const val = Array.isArray(lastFill.value) ? lastFill.value[lastFill.value.length - 1] : lastFill.value;
      const exactMatch = field.options.some(o => o.value === val || o.text === val);
      if (!exactMatch) {
        let bestOpt = null, bestScore = 0;
        for (const opt of field.options) {
          const score = fuzzyScore(String(val), opt.text);
          if (score > bestScore) { bestScore = score; bestOpt = opt; }
        }
        if (bestOpt && bestScore >= 0.3) {
          lastFill.value = Array.isArray(lastFill.value) ? [lastFill.value[0], bestOpt.text] : bestOpt.text;
        }
      }
    }

    if (!mapped && label) {
      unmapped.push({ label, type, id: field.id });
    }
  }

  // Determine company/role from scan title
  const title = scan.title || '';
  const company = title.split(/[@|–—-]/).pop()?.trim() || '';
  const role = title.split(/[@|–—-]/)[0]?.trim() || '';

  const plan = {
    url: url || scan.original_url || scan.url,
    company,
    role,
    resume: resumePath,
    fills,
    dynamic_fills: [],
    skipped,
    unmapped,
    auto_generated: true,
    generated_at: new Date().toISOString(),
  };

  return plan;
}
