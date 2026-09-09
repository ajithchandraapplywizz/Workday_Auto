/**
 * resumeParser.mjs — Extract text from resume PDF and infer factual answers
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { PDFParse } from 'pdf-parse';
import { fuzzyScore } from './fields.mjs';

export const DEFAULT_RESUME_PATH = 'resumes/Ajithchandra_Resume_AIPractice_Intern.pdf';

const textCache = new Map();

/**
 * Resolve resume file path: explicit → default PDF → resumes.yml default.
 * @param {string} [explicitPath]
 * @returns {Promise<string|null>}
 */
export async function resolveResumePath(explicitPath) {
  if (explicitPath && existsSync(resolve(process.cwd(), explicitPath))) {
    return explicitPath;
  }
  const defaultAbs = resolve(process.cwd(), DEFAULT_RESUME_PATH);
  if (existsSync(defaultAbs)) return DEFAULT_RESUME_PATH;
  return null;
}

/**
 * Load and cache plain text from a resume PDF.
 * @param {string} resumePath
 * @returns {Promise<string|null>}
 */
export async function loadResumeText(resumePath) {
  const rel = await resolveResumePath(resumePath);
  if (!rel) return null;

  const abs = resolve(process.cwd(), rel);
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
  const idx = text.search(/\nEXPERIENCE\n/i);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const end = rest.search(/\n(PROJECTS|EDUCATION|ACHIEVEMENTS)\n/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

function extractSkillsBlock(text) {
  const idx = text.search(/\nCORE SKILLS\n/i);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const end = rest.search(/\nEXPERIENCE\n/i);
  return end > 0 ? rest.slice(0, end) : rest;
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
    return firstMatch(resumeText, /\+?\d[\d\s().-]{8,}\d/)?.replace(/\s+/g, ' ') || null;
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
  if (/^city$/i.test(lower)) return firstMatch(resumeText, /([A-Za-z][A-Za-z\s]+),\s*(India|USA|United States)/)?.split(',')[0]?.trim() || null;
  if (/^country$/i.test(lower) && !/phone\s*code/i.test(lower)) {
    if (/india/i.test(resumeText)) return 'India';
    if (/united states|usa/i.test(resumeText)) return 'United States';
  }
  if (/location|address/i.test(lower)) {
    return firstMatch(resumeText, /[A-Za-z][A-Za-z\s]+,\s*(India|USA|United States)/);
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
  if (/major|field\s*of\s*study/i.test(lower)) {
    return firstMatch(education, /Computer Science[^,\n]*/i)
      || firstMatch(education, /Engineering[^,\n]*/i);
  }
  if (/graduat|year/i.test(lower)) {
    return firstMatch(education, /\b(20\d{2})\b/) || firstMatch(resumeText, /graduating\s*(20\d{2})/i)?.match(/\d{4}/)?.[0];
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

  if (/related.*employee|relative.*employee|previously\s*worked|prior\s*worker|conflict/i.test(lower)) {
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
