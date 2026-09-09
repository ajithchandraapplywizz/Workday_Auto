/**
 * planner.mjs — Auto-generate fill plan from scan + profile
 *
 * Maps scanned field labels to profile YAML keys automatically.
 * Includes unknown-field fallback to persistent Q&A store and terminal prompt.
 */

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import readline from 'readline/promises';
import { fuzzyScore } from './fields.mjs';
import { normalizeLabel, createQAStore, findBestMatch, isComplianceSensitive, isSalaryQuestion, loadSettings, saveAnswerToYaml } from './qaStore.mjs';
import { inferFromResumeFile, DEFAULT_RESUME_PATH } from './resumeParser.mjs';
import { mergeWorkdayDefaultAnswers, lookupDefaultAnswer } from './workdayDefaults.mjs';
import { buildCurrentDateAction } from './date-utils.mjs';
import { getWorkdayTenant } from './discovery.mjs';

// ─── Field label → profile key mapping ──────────────────────────────────────
// Each entry: [regex to match field label, path in profile.yml, optional transform]
export const FIELD_MAP = [
  // Personal
  [/^(legal\s*)?(first|given)\s*name(\s*local)?(\(s\))?$|^legalName--firstNameLocal$|^legalName--firstName|^Given Name/i, 'personal.first_name'],
  [/^(legal\s*)?(last|family|surname)\s*name(\s*local)?(\(s\))?$|^legalName--lastNameLocal$|^legalName--lastName|^Family Name/i, 'personal.last_name'],
  [/^(full\s*)?name$/i, 'personal.full_name'],  // resolved as first + last
  [/^email/i, 'personal.email'],
  [/phone\s*device\s*type/i, '_static.Mobile'],
  [/are\s*you\s*bilingual\?/i, '_static.No'],
  [/do\s*you\s*have\s*any\s*relatives\s*that\s*are\s*currently\s*employed\s*by\s*abc\s*fitness\?/i, '_static.No'],
  [/are\s*you\s*currently\s*or\s*have\s*you\s*ever\s*worked\s*at\s*an\s*abc\s*customer\s*site\?/i, '_static.No'],
  [/are\s*you\s*18\s*years\s*of\s*age\s*or\s*older\?/i, '_static.Yes'],
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
  [/please\s*select\s*your\s*sex/i, '_static.Male'],
  [/please\s*select\s*your\s*race-ethnicity/i, '_static.Asian \(United States of America\)'],
  [/please\s*indicate\s*whether\s*you\s*are\s*in\s*one\s*or\s*more\s*of\s*the\s*protected\s*veteran\s*categories/i, '_static.I am not a protected veteran.'],
  [/yes,\s*i\s*have\s*read\s*and\s*consent\s*to\s*the\s*terms\s*and\s*conditions/i, '_static.Yes'],
  [/country\s*(\/\s*territory\s*)?phone\s*code|^phoneNumber--countryPhoneCode/i, 'personal.country_phone_code'],
  [/extension|^phoneNumber--extension$/i, 'personal.phone_extension'],
  [/^phone\s*number$|^phoneNumber--phoneNumber$|^phone$/i, 'personal.phone'],
  [/linkedin/i, 'personal.linkedin'],
  [/portfolio|website|url|shared\s*url/i, 'personal.linkedin'],
  [/^city$|^address--city/i, 'personal.city'],
  [/^state$|^address--state/i, 'personal.state'],
  [/^postal\s*code$|^zip|^address--postalCode/i, 'personal.postal_code'],
  [/^address\s*line\s*1$|^address--addressLine1/i, 'personal.address_line1'],
  [/^address\s*line\s*2$|^address--addressLine2/i, 'personal.address_line2'],
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

  // EEO & Disclosures
  [/gender/i, 'eeo.gender'],
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
  [/graduat|year/i, 'education.graduation_year'],
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
  [/prior\s*worker|previously\s*worked|former\s*employee|employed.*in\s*the\s*past|self\s*identify.*prior|candidateIsPreviousWorker|^#?hopz4$/i, '_static.No'],

  // Referral source — filled only via workdaySource.mjs (DOM click, not profile.country_phone_code)
  [/referral|^source(--source)?$|^source$/i, 'personal.source'],

  // Consent & Agreement (including Workday dynamic checkboxes like x34r4)
  [/consent.*terms|terms\s*and\s*conditions|agree.*terms|^x34r4$/i, 'personal.consent_agreement'],
  [/consent.*terms|terms\s*and\s*conditions|agree.*terms|^x34r4$/i, '_static.true'],
];

// ─── Load profile ───────────────────────────────────────────────────────────
export async function loadProfile(profilePath) {
  const raw = await readFile(profilePath || resolve(process.cwd(), 'config', 'profile.yml'), 'utf-8');
  const profile = yaml.load(raw);

  // Resolve full_name from first + last
  if (profile.personal) {
    profile.personal.full_name = `${profile.personal.first_name || ''} ${profile.personal.last_name || ''}`.trim();
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

  if (!profile.personal?.phone) {
    console.warn('⚠️  profile.personal.phone is missing in config/profile.yml — Workday phone fill will stop until it is set.');
  }

  return profile;
}

// ─── Get value from nested path ─────────────────────────────────────────────
export function getNestedValue(obj, path) {
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

  const overrideRules = loadTenantOverrideRules(tenant);
  for (const [regex, path] of overrideRules) {
    if (regex.test(cleanLabel)) {
      if (path.startsWith('_static.')) {
        return path.substring(8);
      }
      const val = getNestedValue(profile, path);
      if (val !== undefined && val !== null && val !== '') {
        return Array.isArray(val) ? val : String(val);
      }
    }
  }

  for (const [regex, path] of FIELD_MAP) {
    if (regex.test(cleanLabel)) {
      if (path.startsWith('_static.')) {
        return path.substring(8);
      }
      const val = getNestedValue(profile, path);
      if (val !== undefined && val !== null && val !== '') {
        return Array.isArray(val) ? val : String(val);
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
  const text = String(label || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  return /facebook|twitter|x\.com|social media|social profile|social link/i.test(lower);
}

function shouldPromptForUnknownField(label = '', field = {}) {
  const text = String(label || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  if (isSkipSocialLinkLabel(text)) return false;
  if (/optional|voluntary|not required|if you would like|if applicable|additional attachment|cover letter|upload a file|drop files here|select files|employee\s*id.*if applicable/i.test(lower)) {
    return false;
  }
  // Unknown Workday questions should always be asked in the terminal one-by-one.
  return true;
}

// ─── Human Terminal Prompt ──────────────────────────────────────────────────
export async function askHuman(questionText, field = {}, { company, compliance } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const fieldType = inferDomFieldType(field);
    const domCode = field?.id || field?.name || field?.automationId || field?.dataAutomationId || 'unknown';
    const options = (field?.options || []).map(o => (typeof o === 'string' ? o : o?.text)).filter(Boolean);
    console.log('\n──────────────────────────────────────────');
    console.log(compliance ? '🔒 Unknown required compliance question' : '⚠ Unknown required question');
    if (company) console.log(`Company:  ${company}`);
    console.log(`Question: "${questionText}"`);
    console.log(`DOM code / id: ${domCode}`);
    console.log(`UI design: ${fieldType}`);
    if (field?.role) console.log(`Role: ${field.role}`);
    if (field?.placeholder) console.log(`Placeholder: ${field.placeholder}`);
    if (options.length > 0) console.log(`Options: [${options.slice(0, 12).join(', ')}]`);
    console.log('Type your answer below and press Enter to paste it into the live Workday page.');
    console.log('──────────────────────────────────────────');
    const answer = await rl.question('> Your answer:\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}

// ─── Phase 2: Resolve field with Q&A store + human fallback ─────────────────
export async function resolveField(field, profile, qaStore, options = {}) {
  const { skipPrompt = false, plan, company, resumePath, url, tenant } = options;
  const store = qaStore || createQAStore();
  const fieldObj = typeof field === 'object' ? field : {};
  const rawLabel = typeof field === 'string' ? field : (field.label || field.id || field.name || '');
  if (!rawLabel) return null;
  if (isSkipSocialLinkLabel(rawLabel)) return null;

  const resolvedTenant = tenant || (url ? getWorkdayTenant(url) : '');
  const normalized = normalizeLabel(rawLabel);
  const settings = await loadSettings();
  const compliance = isComplianceSensitive(rawLabel);

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

  // 1. Q&A cache (profile qa_answers + data/qa-store.json) — fuzzy match, but
  // do not reuse old salary numbers for different salary questions unless they
  // are the same question or an exact tenant-scoped match.
  const exactOnlySalaryQuestion = /(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(rawLabel);
  const cached = await findBestMatch(rawLabel, profile, store, exactOnlySalaryQuestion ? 1 : settings.fuzzy_threshold, resolvedTenant);
  if (cached?.answer) return cached.answer;

  // 1b. Referral source — always from profile/defaults, never terminal
  if (/how\s*did\s*you\s*hear/i.test(normalized)) {
    const fromProfile = profile?.personal?.source
      || profile?.qa_answers?.['how did you hear about us']
      || profile?.qa_answers?.['how did you hear'];
    if (fromProfile) return fromProfile;
    const defaultSource = lookupDefaultAnswer(rawLabel);
    if (defaultSource) return defaultSource;
  }

  // 1c. Workday default application/disclosure answers (never for salary)
  if (!isSalaryQuestion(rawLabel)) {
    const defaultAns = lookupDefaultAnswer(rawLabel);
    if (defaultAns && !/vibe philosophy|recruitment privacy statement.*vibe/i.test(rawLabel)) {
      return defaultAns;
    }
  }

  // 2. Static profile.yml (personal, education, work_auth, eeo) — never guess salary
  if (!compliance && !isSalaryQuestion(rawLabel)) {
    const direct = mapLabelToProfileValue(rawLabel, profile, { tenant: resolvedTenant, url });
    if (direct != null && direct !== '') return direct;
  }

  if (plan?.fills) {
    const match = plan.fills.find(f =>
      f.id === (typeof field === 'object' ? field.id : undefined)
      || (f.label && normalizeLabel(f.label) === normalized)
    );
    if (match?.value != null && match.value !== '' && !compliance) return match.value;
  }

  if (profile?._runtimeAnswers) {
    const runtime = profile._runtimeAnswers[rawLabel] || profile._runtimeAnswers[normalized];
    if (runtime != null && runtime !== '') return runtime;
  }

  // 3. Resume PDF inference (factual fields only — never salary/compensation)
  if (!compliance && !isSalaryQuestion(rawLabel)) {
    const resume = resumePath || plan?.resume || profile?._resumePath || DEFAULT_RESUME_PATH;
    const fromResume = await inferFromResumeFile(rawLabel, resume, typeof field === 'object' ? field : {});
    if (fromResume) {
      console.log(`    📄 Resume answer for "${rawLabel}": "${fromResume.length > 60 ? fromResume.slice(0, 60) + '...' : fromResume}"`);
      return fromResume;
    }
  }

  const shouldPrompt = shouldPromptForUnknownField(rawLabel, fieldObj);
  if (!shouldPrompt || skipPrompt) return null;

  if (isSalaryQuestion(rawLabel)) {
    console.log(`    💰 Salary question with no exact cached answer — asking in terminal before filling.`);
  }

  // 4. Terminal prompt → persist tenant-scoped when applicable
  const answer = await askHuman(rawLabel, fieldObj, { company, compliance });
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
  return answer;
}

// ─── Pick resume based on JD keywords ───────────────────────────────────────
export async function pickResume(jdText, resumesPath) {
  const raw = await readFile(resumesPath || resolve(process.cwd(), 'config', 'resumes.yml'), 'utf-8');
  const config = yaml.load(raw);
  const resumes = config.resumes || [];
  const defaultId = config.default || resumes[0]?.id;

  if (resumes.length <= 1) return resumes[0]?.file || null;

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
    return bestResume.file;
  }

  const fallback = resumes.find(r => r.id === defaultId) || resumes[0];
  console.log(`  📄 Resume: ${fallback.label} (default)`);
  return fallback.file;
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
            value = path.substring(8);
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

    // Check profile.qa_answers then QA store if available
    if (!mapped && label) {
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
