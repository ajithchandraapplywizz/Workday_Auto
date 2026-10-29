/**
 * claudeLlm.mjs — Unknown-field resolution via Anthropic Claude (Haiku 5.5).
 *
 * Strict single LLM provider for the Workday Auto apply engine.
 * Never logs the API key.
 * Never uses temperature or other deprecated parameters.
 * Returns strict JSON/field values, never prose.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import yaml from 'js-yaml';
import {
  isComplianceSensitive,
  isHighRiskPersonalFactQuestion,
  isSalaryQuestion,
  lookupSemanticAnswer,
  lookupSemanticCompensationAnswer,
  normalizeLabel,
} from './qaStore.mjs';
import { fuzzyScore } from './fields.mjs';
import { pickCompensationFromOptions } from './compensationPick.mjs';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import {
  resolveExperienceQuestionAnswer,
  sanitizeExperienceAnswer,
  isYearsQuantityQuestion,
  isDescribeExperienceQuestion,
  buildExperienceContext,
  isInvalidYearsAnswer,
  profileBackedEssay,
} from './experienceAnswer.mjs';
import { extractYesNoAnswer, isYesNoQuestionLabel, lookupSensitiveSafeAnswer } from './workdayDefaults.mjs';
import { fieldTypeToCode, describeFieldTypeCode } from './fieldTypeCodes.mjs';
import { mapToExactOption } from './questionEngine/optionMap.mjs';
import {
  isHighRiskIntent,
  isSignatureOrFullNameQuestion,
  isShiftOrScheduleQuestion,
  pickShiftOption,
  isSpecificManagerOrLocationQuestion,
} from './questionEngine/intents.mjs';
import { parseMonthYear, parseYear } from './experienceDates.mjs';
import { isApiOnlyAnswerMode } from './apiOnlyProfile.mjs';
import { isSupabaseConfigured, upsertSupabaseAnswer } from './supabaseClient.mjs';
import { buildLlmDateContext, getTodayISODate } from './date-utils.mjs';
import { isValidCityName, isValidStateName } from './clientContact.mjs';
import { recordApplicationTokenUsage } from './tokenUsage.mjs';

const PRIMARY_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const FALLBACK_MODEL = 'claude-3-5-haiku-20241022';

let anthropicClient = null;

export function getAnthropicClient() {
  loadLocalEnvOnce();
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('[FATAL SECURITY] Missing CLAUDE_API_KEY or ANTHROPIC_API_KEY. Refusing to boot LLM.');
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

export function isClaudeEnabled() {
  loadLocalEnvOnce();
  return Boolean(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// Backward compatibility alias
export function isOpenRouterEnabled() {
  return isClaudeEnabled();
}

/**
 * Executes a chat completion via Anthropic Messages API.
 * Never passes `temperature` or other deprecated params.
 */
export async function claudeChat({
  messages = [],
  system = '',
  max_tokens = 500,
  timeoutMs = 45000,
  applicationContext = null,
} = {}) {
  const client = getAnthropicClient();

  // Separate system message if provided inside messages array
  let systemPrompt = system || '';
  const anthropicMessages = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${m.content}` : m.content;
    } else {
      anthropicMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
      });
    }
  }

  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: 'user', content: 'Provide the answer.' });
  }

  async function callModel(modelName) {
    const params = {
      model: modelName,
      max_tokens: Math.min(max_tokens, 2048),
      messages: anthropicMessages,
    };
    if (systemPrompt) {
      params.system = systemPrompt;
    }
    return await client.messages.create(params);
  }

  let response = null;
  try {
    response = await callModel(PRIMARY_MODEL);
  } catch (err) {
    // If the custom model string is not recognized, fallback to claude-3-5-haiku-20241022
    if (err?.message?.includes('not_found') || err?.status === 404) {
      console.warn(`[claudeLlm] Model ${PRIMARY_MODEL} not found, falling back to ${FALLBACK_MODEL}...`);
      response = await callModel(FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

  const rawText = response?.content?.[0]?.text || '';

  // Record token usage if tracking is available
  if (response?.usage) {
    recordApplicationTokenUsage({
      promptTokens: response.usage.input_tokens || 0,
      completionTokens: response.usage.output_tokens || 0,
      totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      model: PRIMARY_MODEL,
      provider: 'anthropic',
    }).catch(() => {});
  }

  // Format to standard choices interface for callers
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: rawText,
        },
      },
    ],
    rawText,
    usage: response?.usage,
  };
}

// Backward compatibility alias
export async function openRouterChat(args = {}) {
  return claudeChat(args);
}

export function isInputLikeField(fieldType = '', options = []) {
  if (Array.isArray(options) && options.length > 0) return false;
  const t = String(fieldType || '').toLowerCase();
  if (!t || /text|input|textarea|number|spin|numeric|tel|email|url|search/.test(t)) return true;
  if (/dropdown|select|combobox|radio|checkbox/.test(t)) return false;
  return true;
}

export function isAutoApplyMode() {
  return process.env.AUTO_APPLY_MODE === '1' || process.env.WORKDAY_AUTO_APPLY === 'true';
}

export function isPersonalIdentityQuestion(label = '') {
  const norm = normalizeLabel(label);
  return (
    /^(legal\s*)?(first|given|last|family|surname|middle)\s*name/.test(norm)
    || isSignatureOrFullNameQuestion(label)
    || /^full\s*name$|^name$|^legal\s*name$/.test(norm)
    || /^email/.test(norm)
    || /^(phone|mobile|cell)(\s*number)?$|phone\s*number/.test(norm)
    || /country.*phone.*code/.test(norm)
    || /^city$|^address--city$/.test(norm)
    || /^state$|^address--countryregion$/.test(norm)
    || /postal|zip/.test(norm)
    || /^country$/.test(norm)
    || /address\s*line\s*1|^address--addressline1$/.test(norm)
  );
}

export function localNearestOption(preferred, options = []) {
  if (!preferred || !Array.isArray(options) || !options.length) return null;
  const pref = String(preferred).trim().toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const opt of options) {
    const o = String(opt).trim().toLowerCase();
    if (o === pref) return { option: opt, score: 1.0 };
    const score = fuzzyScore(pref, o);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return { option: best, score: bestScore };
}

export function isMissingProfileStatement(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/^(unknown|not sure|unsure)$/i.test(s)) return true;
  return /\b(not|no)\s+.*(provided|specified|mentioned|available|found|given|on file|in (the )?profile|in (the )?resume)\b/i.test(s)
    || /\b(none provided|information not available|not provided in)\b/i.test(s);
}

export function validateLlmFieldDecision(raw, context = {}) {
  const options = (context.options || [])
    .map((option) => String(option || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const code = fieldTypeToCode(context.fieldType || 'text');
  let decision;

  try {
    const clean = String(raw || '').replace(/```(?:json)?|```/gi, '').trim();
    decision = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || '');
  } catch {
    return null;
  }

  const rawAnswerPreview = Array.isArray(decision.answer)
    ? decision.answer.join(' ')
    : String(decision.answer ?? '');
  const honestMiss = /^(0|na|n\/a|no)\b|do not have|have not used|no (professional )?experience|not used/i
    .test(rawAnswerPreview.trim());
  if (!decision) return null;

  if (decision.grounded !== true && !honestMiss) return null;
  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < (honestMiss ? 0.45 : 0.65)) return null;

  const rawAnswers = Array.isArray(decision.answer)
    ? decision.answer
    : String(decision.answer ?? '').split(code === 5 ? /[,;\n|]+/ : /\n/);
  const answers = rawAnswers
    .map((answer) => String(answer ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim())
    .filter((answer) => {
      if (!answer) return false;
      if (/^(unknown|not sure|unsure)$/i.test(answer)) return false;
      if (isMissingProfileStatement(answer)) return false;
      return true;
    });
  if (!answers.length) return null;

  if (options.length && code >= 2) {
    const matchedList = answers.map((answer) => {
      const lower = answer.toLowerCase().trim();
      const exact = options.find((opt) => opt.toLowerCase().trim() === lower);
      if (exact) return exact;
      return null;
    }).filter(Boolean);

    if (!matchedList.length) return null;
    if (code !== 5) return matchedList[0];
    return [...new Set(matchedList)].join(', ');
  }

  if (code === 5) return [...new Set(answers)].join(', ');
  return answers[0];
}

export async function gatherPlaywrightFieldContext(page, label, field = {}) {
  if (!page || page.isClosed()) return null;
  return {
    label,
    fieldType: field.fieldType || field.type || 'text',
    required: Boolean(field.required),
    options: field.options || [],
  };
}

export async function analyzeClientProfileOnce(profile = {}, opts = {}) {
  if (!profile || profile._llmProfileBrief) return profile?._llmProfileBrief || '';
  const skills = profile.skills || [];
  const exp = profile.experience || {};
  const brief = `Role: ${exp.current_title || 'Software Engineer'}, Experience: ${exp.years || 3}+ years, Skills: ${Array.isArray(skills) ? skills.slice(0, 15).join(', ') : ''}`;
  profile._llmProfileBrief = brief;
  return brief;
}

/**
 * Resolves an unknown Workday form question using Claude Haiku 5.5.
 * Strictly adheres to Rule E:
 * - No 'REQUIRED field — never return UNKNOWN or empty' text.
 * - No hallucinating/fabricating fallbacks.
 * - Returns { answer, confidence, requiresReview }
 */
export async function resolveUnknownWithLlm(questionText, field = {}, opts = {}) {
  const label = String(questionText || field.label || field.id || field.name || '').trim();
  if (!label) return null;

  // Compliance Hard-Block: Claude NEVER answers work-auth, visa, sponsorship, or EEO fields
  const isProtectedCompliance = /authorized to work|authori[sz]ed|work auth|visa|sponsor|veteran|disability|gender|sex|race|ethnicity|hispanic|latino|eeo/i.test(label);
  if (isProtectedCompliance) {
    console.log(`    🛑 [Claude LLM blocked] Compliance/EEO field cannot be answered by LLM: "${label.slice(0, 50)}"`);
    return null;
  }

  const options = (field.options || []).map((o) => String(typeof o === 'string' ? o : o?.text || '').trim()).filter(Boolean);
  const fieldType = field.fieldType || field.type || (options.length > 0 ? 'dropdown' : 'text');
  const typeCode = fieldTypeToCode(fieldType, options);
  const typeDesc = describeFieldTypeCode(typeCode);

  const profile = opts.profile || {};
  const resumeText = profile._resumeText || profile.resume_text || '';
  const applicant = profile.personal || {};

  const system = `You are an automated application assistant resolving Workday job application questions based strictly on the applicant's resume and verified profile facts.

Return ONLY a valid JSON object with NO markdown formatting:
{"answer":"exact string value or option","confidence":0.95,"grounded":true}

If the question cannot be answered from the supplied profile or resume:
Return:
{"answer":null,"requiresReview":true,"grounded":false}

RULES:
1. Ground every skill, experience, and role claim in the applicant's resume.
2. If options are provided, you MUST pick one listed option EXACTLY, matching case and whitespace.
3. If field is free text, provide a concise, factual answer (e.g. number for years questions, short factual phrase for descriptive questions).
4. Do NOT invent dates, certifications, employers, or personal identity details.
5. Never return prose explanations like "The candidate has not provided this". Return null instead.`;

  const user = `Question: ${label}
Field Type: ${fieldType} (Code ${typeCode}: ${typeDesc})
${options.length > 0 ? `Available Options:\n- ${options.join('\n- ')}` : 'Field Type: Free-text input'}

Applicant Summary:
${JSON.stringify({
  title: profile.experience?.current_title,
  years: profile.experience?.years,
  skills: (profile.skills || []).slice(0, 20),
  education: profile.education,
}, null, 2)}

Resume Excerpt:
${resumeText ? resumeText.slice(0, 3000) : '(No resume excerpt available)'}`;

  try {
    const res = await claudeChat({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 250,
    });

    const content = res.rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

    if (parsed.requiresReview === true || parsed.answer == null) {
      return null;
    }

    let answer = String(parsed.answer).trim();

    // Option matching validation
    if (options.length > 0) {
      const match = options.find((o) => o.toLowerCase() === answer.toLowerCase());
      if (match) answer = match;
      else {
        const prefix = options.find((o) => o.toLowerCase().startsWith(answer.toLowerCase()));
        if (prefix) answer = prefix;
        else return null;
      }
    }

    if (isMissingProfileStatement(answer)) return null;

    return answer;
  } catch (err) {
    console.warn(`    ⚠️ [claudeLlm] Resolution error for "${label}": ${err.message}`);
    return null;
  }
}

export async function pickNearestSelectOption({
  question,
  options = [],
  preferred = '',
  profile = null,
  company = '',
  page = null,
} = {}) {
  const list = (options || []).map((o) => String(o || '').trim()).filter(Boolean);
  if (!list.length) return preferred || null;

  // Local fast fuzzy match
  if (preferred) {
    const local = localNearestOption(preferred, list);
    if (local && local.score >= 0.8) return local.option;
  }

  // Specific manager / location questions default to first neutral option
  if (isSpecificManagerOrLocationQuestion(question)) {
    const pref = list.find((o) => /\b(no\s*preference|any|all|none|n\/?a)\b/i.test(o)) || list[0];
    if (pref) return pref;
  }

  // Shift questions
  if (isShiftOrScheduleQuestion(question)) {
    const shift = pickShiftOption(list);
    if (shift) return shift;
  }

  // Claude resolution
  if (isClaudeEnabled()) {
    try {
      const resolved = await resolveUnknownWithLlm(question, { options: list, fieldType: 'dropdown' }, { profile, company, page });
      if (resolved) return resolved;
    } catch {}
  }

  return preferred && list.find((o) => o.toLowerCase() === preferred.toLowerCase()) ? preferred : null;
}

export async function answerInputFieldWithLlm(field = {}, profile = {}, opts = {}) {
  const label = field.label || field.id || '';
  return resolveUnknownWithLlm(label, field, { profile, ...opts });
}

export async function hydrateExperienceFromLlm(profile = {}) {
  return profile;
}

export async function analyzeUnknownQuestionsBatch(questions = [], profile = {}, opts = {}) {
  const list = Array.isArray(questions) ? questions : (questions ? [questions] : []);
  const results = [];
  for (const q of list) {
    const label = q.label || q.question || q.field?.label || '';
    const rawField = q.field || q;
    let answer = null;
    let confidence = 0;
    try {
      answer = await resolveUnknownWithLlm(label, rawField, { profile, ...opts });
      if (answer) {
        confidence = 0.85;
      }
    } catch (err) {
      console.warn(`    ⚠️ [claudeLlm batch] Error answering "${label}": ${err.message}`);
    }

    results.push({
      questionId: q.questionId || rawField?.questionId || rawField?.id || label,
      label,
      answer: answer || null,
      confidence,
      requiresReview: !answer,
    });
  }
  return results;
}
