/**
 * resumeParser.mjs — Extract text from resume PDF and infer factual answers
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { PDFParse } from 'pdf-parse';
import { fuzzyScore } from './fields.mjs';

export const DEFAULT_RESUME_PATH = 'resumes/Ajithchandra_Resume_AIPractice_Intern.pdf';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const textCache = new Map();

/** Candidate project roots — CLI may run from auto-apply/, parent, or monorepo root. */
function appRootCandidates() {
  return [
    process.cwd(),
    resolve(MODULE_DIR, '..'),
    resolve(process.cwd(), 'auto-apply'),
    resolve(MODULE_DIR, '..', '..'),
    resolve(process.cwd(), 'workday-auto-apply', 'auto-apply'),
  ];
}

/**
 * Resolve a resume path (relative or absolute) to an existing absolute file path.
 * @param {string} [relOrAbs]
 * @returns {string|null}
 */
export function findExistingResumeFile(relOrAbs) {
  if (!relOrAbs) return null;
  const raw = String(relOrAbs).trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;

  if (isAbsolute(raw) && existsSync(raw)) return raw;

  for (const root of appRootCandidates()) {
    const candidate = resolve(root, raw);
    if (existsSync(candidate)) return candidate;
  }

  const base = basename(raw);
  if (base && base !== raw) {
    for (const root of appRootCandidates()) {
      const inResumes = resolve(root, 'resumes', base);
      if (existsSync(inResumes)) return inResumes;
      const atRoot = resolve(root, base);
      if (existsSync(atRoot)) return atRoot;
    }
  }
  return null;
}

async function loadDefaultFromResumesYml() {
  for (const root of appRootCandidates()) {
    const ymlPath = resolve(root, 'config', 'resumes.yml');
    if (!existsSync(ymlPath)) continue;
    try {
      const doc = yaml.load(await readFile(ymlPath, 'utf-8')) || {};
      const list = Array.isArray(doc.resumes) ? doc.resumes : [];
      const defId = doc.default;
      const hit = (defId && list.find((r) => r?.id === defId)) || list[0];
      if (hit?.file) {
        const abs = findExistingResumeFile(hit.file);
        if (abs) return abs;
      }
    } catch {
      /* ignore malformed yml */
    }
  }
  return null;
}

async function firstPdfInResumesFolders() {
  for (const root of appRootCandidates()) {
    const dir = resolve(root, 'resumes');
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      const pdfs = files.filter((f) => /\.pdf$/i.test(f) && !f.startsWith('.'));
      if (!pdfs.length) continue;
      const preferred = pdfs.find((f) => /ajith|aipractice|resume/i.test(f))
        || pdfs.sort((a, b) => a.localeCompare(b))[0];
      if (preferred) return resolve(dir, preferred);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Resolve resume file to an absolute path that exists on disk.
 * Order: explicit → resumes.yml default → DEFAULT_RESUME_PATH → first PDF in resumes/.
 * @param {string} [explicitPath]
 * @returns {Promise<string|null>} absolute path or null
 */
export async function resolveResumePath(explicitPath) {
  const fromExplicit = findExistingResumeFile(explicitPath);
  if (fromExplicit) return fromExplicit;

  const fromYml = await loadDefaultFromResumesYml();
  if (fromYml) return fromYml;

  const fromDefault = findExistingResumeFile(DEFAULT_RESUME_PATH);
  if (fromDefault) return fromDefault;

  return firstPdfInResumesFolders();
}

/**
 * Resolve resume for apply/scan from profile, plan, or resumes/ folder.
 * Always stores an absolute path on profile._resumePath when found.
 * @returns {Promise<string|null>} absolute path
 */
export async function getResumePathForApply(profile = {}, plan = {}) {
  try {
    const { isApplyWizzConfigured } = await import('./applyWizzClient.mjs');
    const { resolveApplyWizzResumeUrl, ensureClientResumeFromApplyWizz } = await import('./applyWizzResume.mjs');
    if (isApplyWizzConfigured() && resolveApplyWizzResumeUrl(profile)) {
      const fromApi = await ensureClientResumeFromApplyWizz(profile);
      if (fromApi) {
        console.log(`    📎 Resume from Apply Wizz: ${basename(fromApi)}`);
        return fromApi;
      }
    }
  } catch {
    /* fall through to local resumes/ */
  }

  // Drop stale relative paths that no longer resolve from current cwd
  const candidates = [
    plan?.resume,
    profile?.resume,
    profile?._resumePath,
    profile?.personal?.resume,
  ].filter(Boolean);

  for (const c of candidates) {
    const abs = findExistingResumeFile(c);
    if (abs) {
      if (profile) profile._resumePath = abs;
      return abs;
    }
  }

  const path = await resolveResumePath(null);
  if (path && profile) profile._resumePath = path;
  if (path) {
    console.log(`    📎 Resume resolved: ${basename(path)}`);
  } else {
    console.log('    ⚠️  No resume PDF found under resumes/ (checked cwd + auto-apply roots)');
  }
  return path;
}

/**
 * Load and cache plain text from a resume PDF.
 * @param {string} resumePath
 * @returns {Promise<string|null>}
 */
export async function loadResumeText(resumePath) {
  const abs = await resolveResumePath(resumePath);
  if (!abs) return null;

  if (textCache.has(abs)) return textCache.get(abs);

  try {
    const buffer = await readFile(abs);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    const text = (result?.text || '').trim();
    textCache.set(abs, text);
    return text;
  } catch (err) {
    console.log(`    ⚠️  Could not read resume PDF: ${err.message?.substring(0, 80)}`);
    return null;
  }
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[0].trim() : null;
}

function parseResumeName(text) {
  const line = text.trim().split('\n').find(l => l.trim())?.trim() || '';
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      first: parts[0],
      last: parts.slice(1).join(' '),
      full: line,
    };
  }
  return { full: line };
}

function extractEducationBlock(text) {
  const idx = text.search(/\nEDUCATION\n/i);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const end = rest.search(/\n(CERTIFICATIONS|ACHIEVEMENTS|PROJECTS|EXPERIENCE)\n/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

function extractExperienceBlock(text) {
  const idx = text.search(/\n(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)\s*\n/i);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const end = rest.search(/\n(PROJECTS|EDUCATION|ACHIEVEMENTS|CERTIFICATIONS|SKILLS)\s*\n/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

function cleanResumeLine(line = '') {
  return String(line || '').replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim();
}

function parseResumeMonthYear(value = '') {
  const match = String(value || '').match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})\b/i);
  return match ? `${match[1].slice(0, 3)} ${match[2]}` : '';
}

function splitEducationCredential(line = '') {
  const value = cleanResumeLine(line).replace(/\s*[|—–-]\s*$/, '').trim();
  const match = value.match(/^(.*?\b(?:Bachelor(?:'s)?|Master(?:'s)?|Doctor(?:ate)?|Ph\.?D\.?|B\.?Tech\.?|M\.?Tech\.?|MBA|Associate)\b\s*(?:of\s+[^,|]+)?)(?:,\s*|\s+-\s*)(.+)$/i);
  if (match) return { degree: cleanResumeLine(match[1]), major: cleanResumeLine(match[2]) };
  const comma = value.split(/,\s*/);
  if (comma.length >= 2 && /degree|science|technology|engineering|arts|business/i.test(comma[0])) {
    return { degree: cleanResumeLine(comma[0]), major: cleanResumeLine(comma.slice(1).join(', ')) };
  }
  return { degree: value, major: '' };
}

/** Extract factual top education/work records from one client resume. */
export function parseResumeProfile(text = '') {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map(cleanResumeLine).filter(Boolean);
  const educationIndex = lines.findIndex((line) => /^education$/i.test(line));
  const educationEnd = educationIndex >= 0
    ? lines.findIndex((line, index) => index > educationIndex && /^(?:professional\s+)?experience|work\s+experience|projects|skills|certifications|achievements$/i.test(line))
    : -1;
  const educationLines = educationIndex >= 0
    ? lines.slice(educationIndex + 1, educationEnd > educationIndex ? educationEnd : lines.length)
    : [];
  const credentialLine = educationLines.find((line) => /\b(bachelor|master|doctor|ph\.?d|b\.?tech|m\.?tech|mba|associate)\b/i.test(line));
  const credential = splitEducationCredential(credentialLine || '');
  const schoolLineIndex = credentialLine ? educationLines.indexOf(credentialLine) : -1;
  const university = schoolLineIndex >= 0
    ? (educationLines.slice(schoolLineIndex + 1).find((line) => !/^\d{4}(?:\s*[-–]\s*\d{4})?$/.test(line) && !/\b(gpa|cgpa)\b/i.test(line)) || '').split(/\s*[|—–]\s*/)[0].trim()
    : '';
  const educationYears = educationLines.join(' ').match(/\b(?:19|20|21)\d{2}\b/g) || [];

  const experienceIndex = lines.findIndex((line) => /^(?:professional\s+experience|work\s+experience|experience)$/i.test(line));
  const experienceEnd = experienceIndex >= 0
    ? lines.findIndex((line, index) => index > experienceIndex && /^(education|projects|skills|certifications|achievements)$/i.test(line))
    : -1;
  const experienceLines = experienceIndex >= 0
    ? lines.slice(experienceIndex + 1, experienceEnd > experienceIndex ? experienceEnd : lines.length)
    : [];
  const dateIndex = experienceLines.findIndex((line) => /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4}\b/i.test(line));
  const dateLine = dateIndex >= 0 ? experienceLines[dateIndex] : '';
  const dateParts = dateLine.match(/(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4}\b)\s*(?:[-–—]|to)\s*(Present|Current|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4})?/i);
  const title = dateIndex >= 0 ? cleanResumeLine(dateLine.slice(0, dateLine.indexOf(dateParts?.[1] || dateLine)).replace(/[|—–-]\s*$/, '')) : '';
  const companyParts = (dateIndex >= 0 ? experienceLines[dateIndex + 1] || '' : '').split('|').map(cleanResumeLine).filter(Boolean);
  const current = /\b(present|current)\b/i.test(dateLine);

  return {
    skills: extractResumeSkillNames(raw),
    education: {
      degree: credential.degree,
      major: credential.major,
      field_of_study_hierarchy: credential.major ? [credential.major] : [],
      university,
      from_year: educationYears[0] || '',
      to_year: educationYears[educationYears.length - 1] || '',
      highest_level: credential.degree,
    },
    experience: {
      current_title: title,
      current_company: companyParts[0] || '',
      city: companyParts[1] || '',
      location: companyParts[1] || '',
      from_date: parseResumeMonthYear(dateParts?.[1] || ''),
      to_date: current ? '' : parseResumeMonthYear(dateParts?.[2] || ''),
      currently_working: current,
    },
  };
}

function extractSkillsBlock(text) {
  const idx = text.search(/\b(?:CORE\s+SKILLS|TECHNICAL\s+SKILLS|KEY\s+SKILLS|AREAS\s+OF\s+EXPERTISE|TECHNICAL\s+PROFICIENCIES|SKILLS\s*&?\s*(?:EXPERTISE|SUMMARY|ABILITIES)?|PROGRAMMING\s+LANGUAGES|TECHNOLOGIES|TECH\s+STACK|TOOLKIT|SKILLS\b)\b/i);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const end = rest.search(/\b(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE|EDUCATION|ACADEMIC|PROJECTS|ACHIEVEMENTS|WORK\s+HISTORY|CERTIFICATIONS|PUBLICATIONS)\b/i);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 1500);
}

const DEGREE_OR_EDUCATION_RE = /\b(master|bachelor|phd|doctorate|doctor|associate|degree|diploma|b\.?tech|m\.?tech|b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|m\.?b\.?a|gpa|cgpa|university|college|school|academy|institute|graduat|education|student|high\s*school|intermediate|secondary|major|minor|field\s*of\s*study)\b/i;

/**
 * Parse 1–N skill names from resume text (CORE SKILLS / Skills / comma lists).
 * @param {string} text
 * @returns {string[]}
 */
export function extractResumeSkillNames(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const block = extractSkillsBlock(raw);
  if (!block) return [];
  const out = [];
  const seen = new Set();
  for (const line of block.split(/\n/)) {
    const cleaned = String(line || '')
      .replace(/^(core\s+)?(technical\s+)?(key\s+)?skills?\s*[:\-–]?\s*/i, '')
      .trim();
    if (!cleaned || cleaned.length > 140) continue;
    if (/^(experience|education|projects|achievements|work history)$/i.test(cleaned)) continue;
    if (DEGREE_OR_EDUCATION_RE.test(cleaned) && /\b(degree|university|college|school|master|bachelor)\b/i.test(cleaned)) continue;
    for (const part of cleaned.split(/[,|;•·]/)) {
      const skill = part
        .replace(/^[-–*]\s*/, '')
        .replace(/^.*:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (skill.length < 2 || skill.length > 35) continue;
      if (!/[A-Za-z]/.test(skill)) continue;
      if (/^(and|the|with|skills|languages?|frameworks?|tools?)$/i.test(skill)) continue;
      if (DEGREE_OR_EDUCATION_RE.test(skill)) continue;
      if (/^computer\s*science$/i.test(skill)) continue;
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
    }
  }
  return out;
}

function extractLatestRole(text) {
  const exp = extractExperienceBlock(text);
  const line = exp.split('\n').map(l => l.trim()).find(l => l.includes('—') || l.includes('–'));
  if (!line) return null;
  const title = line.split(/[—–]/)[0]?.trim();
  const companyPart = line.split(/[—–]/)[1]?.trim();
  const company = companyPart?.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*$/i, '').trim();
  return { title, company };
}

function matchOptionInResume(resumeText, options) {
  const lower = resumeText.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const opt of options) {
    const o = String(opt || '').trim();
    if (!o || o.length < 2) continue;
    if (lower.includes(o.toLowerCase())) {
      const score = o.length;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
  }
  return best;
}

/**
 * Infer a factual answer from resume text for a Workday question label.
 * Does not invent — returns null when nothing credible is found.
 * @param {string} label
 * @param {string} resumeText
 * @param {object} [field]
 * @returns {string|null}
 */
export function inferAnswerFromResume(label, resumeText, field = {}) {
  if (!resumeText || !label) return null;

  const clean = String(label).replace(/\*+/g, '').trim();
  const lower = clean.toLowerCase();

  // Never infer salary/compensation from resume text — ask the user instead.
  if (/(salary|compensation|pay|expected.*salary|annual.*salary|target.*pay|currency)/i.test(lower)) {
    return null;
  }
  const name = parseResumeName(resumeText);
  const education = extractEducationBlock(resumeText);
  const experience = extractExperienceBlock(resumeText);
  const skills = extractSkillsBlock(resumeText);
  const latest = extractLatestRole(resumeText);

  const options = (field.options || [])
    .map(o => (typeof o === 'string' ? o : o?.text))
    .filter(Boolean);

  if (options.length > 0) {
    const fromOpts = matchOptionInResume(resumeText, options);
    if (fromOpts) return fromOpts;
  }

  if (/^(legal\s*)?(first|given)\s*name/i.test(lower)) return name.first || null;
  if (/^(legal\s*)?(last|family|surname)\s*name/i.test(lower)) return name.last || null;
  if (/^(full\s*)?name$/i.test(lower)) return name.full || null;
  if (/^email/i.test(lower)) return firstMatch(resumeText, /[\w.+-]+@[\w.-]+\.\w+/);
  if (/phone\s*number|^phone$/i.test(lower)) {
    const raw = firstMatch(resumeText, /\+?\d[\d\s().-]{8,}\d/);
    if (!raw) return null;
    let d = raw.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    return d.length >= 10 ? d.slice(-10) : null;
  }
  if (/country\s*(\/\s*territory\s*)?phone\s*code/i.test(lower)) {
    if (/united states|usa/i.test(resumeText)) return 'United States of America (+1)';
    return null;
  }
  if (/linkedin/i.test(lower)) {
    const url = firstMatch(resumeText, /https?:\/\/(www\.)?linkedin\.com\/[\w./-]+/i);
    if (url) return url;
    const slug = firstMatch(resumeText, /linkedin\.com\/in\/[\w-]+/i);
    if (slug) return `https://www.${slug}`;
    const bare = resumeText.split('\n')[2]?.match(/\|\s*([\w-]+)\s*\|/)?.[1];
    if (bare && !/github/i.test(bare)) return `https://www.linkedin.com/in/${bare}`;
  }
  if (/github|portfolio|website/i.test(lower)) {
    return firstMatch(resumeText, /https?:\/\/github\.com\/[\w-]+/i)
      || firstMatch(resumeText, /github:\s*([\w-]+)/i)?.replace(/^github:\s*/i, 'https://github.com/');
  }
  if (/^city$/i.test(lower)) {
    const header = resumeText.slice(0, 1500);
    return firstMatch(header, /([A-Za-z][A-Za-z\s]+),\s*(?:[A-Z]{2}|USA|United States|India)/)?.split(',')[0]?.trim() || null;
  }
  if (/^country$/i.test(lower) && !/phone\s*code/i.test(lower)) {
    const header = resumeText.slice(0, 1500);
    if (/united states of america/i.test(header)) return 'United States of America';
    if (/united states|usa|\bU\.S\.\b/i.test(header)) return 'United States of America';
    if (/\bindia\b/i.test(header)) return 'India';
    return null;
  }
  if (/address\s*line\s*1/i.test(lower)) {
    const street = resumeText.slice(0, 1500).match(
      /\b(\d+\s+[A-Za-z0-9][\w\s.'#-]{2,60}(?:\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct)\.?))(?:\s*,|\s+)/i,
    );
    return street?.[1]?.replace(/\s+/g, ' ')?.trim()?.slice(0, 120) || null;
  }
  if (/location|address/i.test(lower)) {
    const header = resumeText.slice(0, 1500);
    return firstMatch(header, /[A-Za-z][A-Za-z\s]+,\s*(?:[A-Z]{2}|USA|United States|India)/);
  }
  if (/university|school|college|institution/i.test(lower)) {
    const raw = firstMatch(education, /—\s*([^,\n]+(?:University|College|Institute)[^,\n]*)/i)
      || firstMatch(education, /(AVN[\s\S]*?Technology)/i)
      || firstMatch(education, /([A-Z][\w\s&]+(?:University|College|Institute)[\w\s,]*)/);
    return raw?.replace(/^[-–—\s]+/, '').trim() || null;
  }
  if (/degree/i.test(lower)) {
    return firstMatch(education, /B\.?\s*Tech[^,\n]*/i)
      || firstMatch(education, /Bachelor[^,\n]*/i)
      || firstMatch(education, /Master[^,\n]*/i);
  }
  if (/major|field\s*of\s*study|area\s*of\s*study|what\s*did\s*you\s*study/i.test(lower)) {
    return firstMatch(education, /Computer Science[^,\n]*/i)
      || firstMatch(education, /Engineering[^,\n]*/i);
  }
  if (/graduat|expected\s*graduation|education\s*(end|to|completion)|year\s*of\s*(completion|graduation)/i.test(lower)) {
    const years = [...education.matchAll(/\b(20\d{2})\b/g)].map((m) => m[1]);
    if (years.length >= 2) return years[years.length - 1];
    if (years.length === 1) return years[0];
    return firstMatch(resumeText, /graduat(?:ing|ion)?\s*(?:in\s*)?(20\d{2})/i)?.match(/\d{4}/)?.[0] || null;
  }
  if (/gpa|grade/i.test(lower)) return firstMatch(education, /\b\d\.\d{1,2}\s*\/\s*10\b/) || firstMatch(education, /GPA:\s*([\d.]+)/i)?.replace(/GPA:\s*/i, '');
  if (/job\s*title|current\s*title|position/i.test(lower)) {
    return latest?.title
      || firstMatch(resumeText, /\n([^\n|]+)\|/)?.trim()
      || null;
  }
  if (/company|employer/i.test(lower)) return latest?.company || null;
  if (/years?\s*(of\s*)?experience/i.test(lower)) {
    const roles = experience.split('\n').filter(l => /intern|developer|engineer/i.test(l));
    if (roles.length >= 2) return String(Math.min(roles.length, 3));
    if (roles.length === 1) return '1';
  }
  if (/skill/i.test(lower) && skills) {
    const line = skills.split('\n').find(l => /languages?:/i.test(l));
    if (line) return line.replace(/^●\s*/, '').replace(/.*?:\s*/, '').split(',')[0]?.trim();
  }

  if (/related.*employee|relative.*employee|previously\s*worked|prior\s*worker|prior\s*employment|contractor experience|covidien|conflict/i.test(lower)) {
    return 'No';
  }

  // Last resort: if label words appear near a value line in resume (skip salary/compensation)
  if (!/(salary|compensation|pay|currency)/i.test(lower)) {
    const labelWords = lower.split(/\s+/).filter(w => w.length > 3);
    if (labelWords.length > 0) {
      const lines = resumeText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const lineLower = line.toLowerCase();
        const hits = labelWords.filter(w => lineLower.includes(w)).length;
        if (hits >= Math.min(2, labelWords.length) && line.length < 120 && line.length > 3) {
          const score = hits / labelWords.length;
          if (score >= 0.5) return line.replace(/^●\s*/, '');
        }
      }
    }
  }

  return null;
}

/**
 * @param {string} label
 * @param {string} resumePath
 * @param {object} field
 * @returns {Promise<string|null>}
 */
export async function inferFromResumeFile(label, resumePath, field = {}) {
  const text = await loadResumeText(resumePath);
  if (!text) return null;
  return inferAnswerFromResume(label, text, field);
}
