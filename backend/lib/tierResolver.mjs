/**
 * tierResolver.mjs — 6-Tier Strict Answer Waterfall
 *
 * Tier 1: Supabase cache (client_questions + clients profile facts)
 * Tier 2: Parsed resume facts (education, work history, skills, dates)
 * Tier 3: Apply Wizz CRM Profile API
 * Tier 4: Universal Q&A Bank (qa_store)
 * Tier 5: Semantic + fuzzy composite context match
 * Tier 6: LLM with bound context (<100K tokens) + auto Q&A bank cache
 */

import { tokenSetRatio, fuzzyScore } from './fields.mjs';
import {
  lookupSupabaseAnswer,
  lookupSupabaseAnswerSync,
  upsertSupabaseAnswer,
  recordSupabaseAnswerInMemory,
  isSupabaseConfigured,
} from './supabaseClient.mjs';
import {
  hydrateProfileFromApplyWizz,
  resolveDomQuestionFromApplyWizz,
  alignAnswerToWorkdayOptions,
  stripWorkdayQuestionLabel,
} from './applyWizzClient.mjs';
import { normalizeLabel, findBestMatch } from './qaStore.mjs';
import { extractDobFromResumeText } from './resumeParser.mjs';
import { trace } from './trace.mjs';

// ─── Tier 5 fuzzy thresholds ─────────────────────────────────────────────────
const QA_BANK_FUZZY_THRESHOLD = 0.75;
const PROFILE_FACT_FUZZY_THRESHOLD = 0.80;
const TOKEN_SET_RATIO_NORMALIZER = 100; // tokenSetRatio returns 0-100, divide to get 0-1

/**
 * Build a compact LLM context string from all data sources.
 * Keeps total tokens under 100K by selecting only relevant profile fields
 * and the top 5 most relevant Q&A bank entries.
 *
 * @param {object} clientProfile - full hydrated client profile
 * @param {object} qaBank - pre-loaded Q&A bank { [normalizedLabel]: answer }
 * @param {string} question - the question label being resolved
 * @param {string[]} options - live DOM options for dropdowns/radios
 * @returns {string} context string for LLM
 */
export function buildLlmContext(clientProfile, qaBank, question, options) {
  const p = clientProfile?.personal || {};
  const e = clientProfile?.education || {};
  const x = clientProfile?.experience || {};
  const w = clientProfile?.work_auth || {};
  const eeo = clientProfile?.eeo || {};

  // Compact profile sections — only personal, education, experience, work_auth, eeo
  const profileSection = {
    personal: {
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      phone: p.phone,
      city: p.city,
      state: p.state,
      country: p.country,
      postal_code: p.postal_code,
      linkedin: p.linkedin,
    },
    education: {
      degree: e.degree,
      highest_level: e.highest_level,
      major: e.major,
      university: e.university,
      graduation_year: e.graduation_year,
      gpa: e.gpa,
    },
    experience: {
      current_title: x.current_title,
      current_company: x.current_company,
      years: x.years,
      skills: Array.isArray(x.skills) ? x.skills.slice(0, 20) : x.skills,
      desired_salary: x.desired_salary,
    },
    work_auth: {
      authorized_us: w.authorized_us,
      sponsorship_needed: w.sponsorship_needed,
      visa_type: w.visa_type,
      willing_to_relocate: w.willing_to_relocate,
    },
    eeo: {
      gender: eeo.gender,
      race: eeo.race,
      veteran_status: eeo.veteran_status,
      disability_status: eeo.disability_status,
    },
  };

  // Strip null/undefined keys recursively to save tokens
  const cleanObj = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined && v !== '') {
        result[k] = typeof v === 'object' ? cleanObj(v) : v;
      }
    }
    return result;
  };

  const cleanProfile = cleanObj(profileSection);

  // Pick top-5 most relevant Q&A bank entries by fuzzy score
  const normQuestion = normalizeLabel(question);
  const relevantQa = [];
  if (qaBank && typeof qaBank === 'object') {
    const scored = Object.entries(qaBank)
      .filter(([, ans]) => ans)
      .map(([q, ans]) => ({
        q,
        ans,
        score: Math.max(
          fuzzyScore(normQuestion, normalizeLabel(q)),
          tokenSetRatio(normQuestion, normalizeLabel(q)) / TOKEN_SET_RATIO_NORMALIZER,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const entry of scored) {
      if (entry.score > 0.2) relevantQa.push({ question: entry.q, answer: entry.ans });
    }
  }

  const parts = [
    `CANDIDATE PROFILE:\n${JSON.stringify(cleanProfile, null, 2)}`,
  ];

  if (relevantQa.length > 0) {
    parts.push(`\nRELEVANT Q&A BANK (top ${relevantQa.length}):\n${JSON.stringify(relevantQa, null, 2)}`);
  }

  if (options && options.length > 0) {
    parts.push(`\nAVAILABLE DOM OPTIONS:\n${options.join('\n')}`);
  }

  parts.push(`\nQUESTION TO ANSWER: "${question}"`);

  return parts.join('\n');
}

/**
 * Resolve a postal code given country, state, city context.
 * Uses LLM to generate a valid postal code.
 * Stores result in Supabase client_questions (qa_bank).
 *
 * @param {object} clientProfile - full hydrated client profile
 * @param {string} clientId - applywizz_id
 * @returns {Promise<string|null>} resolved postal code or null
 */
export async function resolvePostalCode(clientProfile, clientId) {
  const p = clientProfile?.personal || {};
  const country = p.country || '';
  const state = p.state || '';
  const city = p.city || '';

  // Quick return if we have it
  if (p.postal_code) return p.postal_code;

  if (!country && !state && !city) return null;

  try {
    const { resolveUnknownWithLlm } = await import('./claudeLlm.mjs');
    const contextLabel = `postal code for ${[city, state, country].filter(Boolean).join(', ')}`;
    const postalAnswer = await resolveUnknownWithLlm(
      'postal code',
      { fieldType: 'text', type: 'text', options: [] },
      {
        profile: {
          ...clientProfile,
          _postalCodeContext: { country, state, city },
        },
      },
    );

    if (postalAnswer && /^\d{4,10}(-\d{4})?$/.test(String(postalAnswer).trim())) {
      const code = String(postalAnswer).trim();
      // Cache result in Supabase
      if (clientId && isSupabaseConfigured()) {
        await upsertSupabaseAnswer({
          applywizzId: clientId,
          question: 'postal code',
          questionNormalized: 'postal code',
          answer: code,
          fieldType: 'text',
          source: 'llm_postal_resolve',
        }).catch(() => {});
        recordSupabaseAnswerInMemory(clientProfile, 'postal code', code);
      }
      return code;
    }
  } catch (err) {
    trace({ stage: 'tier6_postal', clientId, hit: false, error: String(err?.message || err).slice(0, 120) });
  }

  return null;
}

// ─── Internal tier implementations ──────────────────────────────────────────

/**
 * Tier 1: Supabase cache lookup (client_questions table + clients profile facts).
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
async function tier1Supabase(question, clientProfile, options, fieldType) {
  // 1a. Supabase client_questions table (async lookup)
  try {
    const fromSupabase = await lookupSupabaseAnswer(question, clientProfile, { options, fieldType });
    if (fromSupabase?.answer) {
      return { answer: fromSupabase.answer, sourceType: 'supabase_profile', confidence: 1.0 };
    }
  } catch { /* non-fatal */ }

  // 1b. Supabase clients table sync lookup (in-memory _supabaseQa)
  const fromSync = lookupSupabaseAnswerSync(question, clientProfile, { options, fieldType });
  if (fromSync?.answer) {
    return { answer: fromSync.answer, sourceType: 'supabase_profile', confidence: 0.95 };
  }

  return null;
}

/**
 * Tier 2: Resume-parsed facts (education, work history, skills, dates, DOB).
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
async function tier2Resume(question, clientProfile, options, fieldType) {
  try {
    const { resolveExperienceQuestionAnswer, inferAnswerFromResume } = await import('./experienceAnswer.mjs');
    const fromExp = resolveExperienceQuestionAnswer(question, clientProfile, { options, fieldType });
    if (fromExp?.answer) {
      return { answer: fromExp.answer, sourceType: 'resume', confidence: 0.90 };
    }
  } catch { /* optional */ }

  // Resume text direct inference
  if (clientProfile._resumeText) {
    try {
      const { inferAnswerFromResume } = await import('./resumeParser.mjs');
      const direct = inferAnswerFromResume
        ? inferAnswerFromResume(question, clientProfile._resumeText, { options, fieldType })
        : null;
      if (direct) {
        return { answer: direct, sourceType: 'resume', confidence: 0.85 };
      }
    } catch { /* optional */ }

    // DOB extraction from resume text
    if (/date\s*of\s*birth|birth\s*date|\bdob\b|birthday/i.test(question)) {
      const fromResume = extractDobFromResumeText(clientProfile._resumeText);
      if (fromResume) {
        return { answer: fromResume, sourceType: 'resume', confidence: 0.88 };
      }
    }

    // Yes/No inference from resume token presence
    const { isYesNoQuestionLabel } = await import('./workdayDefaults.mjs').catch(() => ({ isYesNoQuestionLabel: () => false }));
    if (isYesNoQuestionLabel(question) && options.length > 0) {
      const lowerResume = clientProfile._resumeText.toLowerCase();
      const topicTokens = (question.toLowerCase().match(/[a-z0-9+#.]{3,}/g) || [])
        .filter((t) => !/^(have|least|years|experience|with|systems|distributed|the|for|you|and|are)\b/i.test(t));
      if (topicTokens.length > 0 && topicTokens.some((t) => lowerResume.includes(t))) {
        const yesOpt = options.find((o) => /^yes\b/i.test(o)) || 'Yes';
        return { answer: yesOpt, sourceType: 'resume', confidence: 0.75 };
      }
    }
  }

  return null;
}

/**
 * Tier 3: Apply Wizz CRM profile API.
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
function tier3Crm(question, clientProfile, options, fieldType) {
  try {
    const fromApi = resolveDomQuestionFromApplyWizz(question, clientProfile, {
      options,
      fieldType,
      threshold: 0.48,
    });
    if (fromApi?.answer) {
      return { answer: fromApi.answer, sourceType: 'crm', confidence: 0.85 };
    }
  } catch { /* optional */ }
  return null;
}

/**
 * Tier 4: Universal Q&A Bank (qa_store / masterYamlManager).
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
async function tier4QaBank(question, qaBank, options, fieldType, tenant) {
  // 4a. Pre-loaded qaBank object from caller
  if (qaBank && typeof qaBank === 'object') {
    const normQ = normalizeLabel(question);
    // Exact normalized lookup first
    const directHit = qaBank[normQ] || qaBank[question] || qaBank[question.toLowerCase()];
    if (directHit) {
      return { answer: String(directHit), sourceType: 'qa_bank', confidence: 1.0 };
    }

    // Fuzzy scan via findBestMatch if available
    if (typeof findBestMatch === 'function') {
      const best = findBestMatch(normQ, Object.keys(qaBank));
      if (best?.score >= QA_BANK_FUZZY_THRESHOLD) {
        const answer = qaBank[best.target];
        if (answer) {
          return { answer: String(answer), sourceType: 'qa_bank', confidence: best.score };
        }
      }
    }
  }

  // 4b. masterYamlManager persistent Q&A bank
  try {
    const { findAnswerFromQaBank } = await import('./masterYamlManager.mjs');
    const qaBankAnswer = await findAnswerFromQaBank({
      questionLabel: question,
      options,
      tenant: tenant || '',
      isSubmission: true,
      isScanOnly: false,
      blockUniversalYaml: false,
    });
    if (qaBankAnswer) {
      return { answer: qaBankAnswer, sourceType: 'qa_bank', confidence: 0.90 };
    }
  } catch { /* optional module */ }

  return null;
}

/**
 * Tier 5: Semantic + fuzzy composite context match.
 * Builds a composite context string from all available data sources and
 * uses tokenSetRatio + fuzzyScore to find answers without LLM calls.
 *
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
function tier5SemanticFuzzy(question, clientProfile, qaBank, options, fieldType) {
  const normQ = normalizeLabel(question);
  let bestScore = 0;
  let bestAnswer = null;

  // 5a. Fuzzy scan across Q&A bank keys
  if (qaBank && typeof qaBank === 'object') {
    for (const [k, ans] of Object.entries(qaBank)) {
      if (!ans) continue;
      const kNorm = normalizeLabel(k);
      const score = Math.max(
        fuzzyScore(normQ, kNorm),
        tokenSetRatio(normQ, kNorm) / TOKEN_SET_RATIO_NORMALIZER,
      );
      if (score > bestScore && score >= QA_BANK_FUZZY_THRESHOLD) {
        bestScore = score;
        bestAnswer = String(ans);
      }
    }
    if (bestAnswer) {
      return { answer: bestAnswer, sourceType: 'semantic_fuzzy', confidence: bestScore };
    }
  }

  // 5b. Fuzzy scan across in-memory Supabase QA
  const supabaseQa = clientProfile?._supabaseQa || {};
  bestScore = 0;
  bestAnswer = null;
  for (const [k, ans] of Object.entries(supabaseQa)) {
    if (!ans) continue;
    const kNorm = normalizeLabel(k);
    const score = Math.max(
      fuzzyScore(normQ, kNorm),
      tokenSetRatio(normQ, kNorm) / TOKEN_SET_RATIO_NORMALIZER,
    );
    if (score > bestScore && score >= PROFILE_FACT_FUZZY_THRESHOLD) {
      bestScore = score;
      bestAnswer = String(ans);
    }
  }
  if (bestAnswer) {
    if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
      const aligned = alignAnswerToWorkdayOptions(bestAnswer, options, fieldType);
      if (aligned) bestAnswer = aligned;
    }
    return { answer: bestAnswer, sourceType: 'semantic_fuzzy', confidence: bestScore };
  }

  // 5c. Apply Wizz QA fuzzy scan
  const awQa = clientProfile?._applyWizzQa || {};
  bestScore = 0;
  bestAnswer = null;
  for (const [k, ans] of Object.entries(awQa)) {
    if (!ans) continue;
    const kNorm = normalizeLabel(k);
    const score = Math.max(
      fuzzyScore(normQ, kNorm),
      tokenSetRatio(normQ, kNorm) / TOKEN_SET_RATIO_NORMALIZER,
    );
    if (score > bestScore && score >= PROFILE_FACT_FUZZY_THRESHOLD) {
      bestScore = score;
      bestAnswer = String(ans);
    }
  }
  if (bestAnswer) {
    if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
      const aligned = alignAnswerToWorkdayOptions(bestAnswer, options, fieldType);
      if (aligned) bestAnswer = aligned;
    }
    return { answer: bestAnswer, sourceType: 'semantic_fuzzy', confidence: bestScore };
  }

  // 5d. Resume keyword token match for yes/no questions
  if (clientProfile?._resumeText) {
    const lowerResume = String(clientProfile._resumeText).toLowerCase();
    const tokens = normQ.split(/\s+/).filter((t) => t.length >= 3 && !/^(have|with|your|this|that|what|when|where|which|years|experience|candidate)\b/i.test(t));
    const matchCount = tokens.filter((t) => lowerResume.includes(t)).length;
    if (tokens.length > 0 && matchCount / tokens.length >= 0.75) {
      if (options.length > 0) {
        const yesOpt = options.find((o) => /^yes\b/i.test(o));
        if (yesOpt) {
          return { answer: yesOpt, sourceType: 'semantic_fuzzy', confidence: matchCount / tokens.length };
        }
      }
    }
  }

  return null;
}

/**
 * Tier 6: LLM fallback (Claude via claudeLlm.mjs) with compact bound context.
 * After resolution, saves answer to Supabase client_questions for future Tier 1/4 lookup.
 *
 * @returns {{ answer: string, sourceType: string, confidence: number }|null}
 */
async function tier6Llm(question, clientProfile, qaBank, options, fieldType, clientId, opts) {
  // Block compliance-sensitive questions from LLM
  if (/authorized to work|authori[sz]ed|work auth|visa|sponsor|veteran|disability|gender|sex|race|ethnicity|hispanic|latino|eeo/i.test(question)) {
    trace({
      stage: 'tier6',
      clientId,
      query: normalizeLabel(question),
      hit: false,
      rejectionReason: 'llm_blocked_for_compliance',
    });
    console.log(`    🛑 [Tier 6 LLM blocked] Compliance question skipped: "${question.slice(0, 55)}"`);
    return null;
  }

  try {
    const { resolveUnknownWithLlm } = await import('./claudeLlm.mjs');

    const llmAnswer = await resolveUnknownWithLlm(
      question,
      {
        fieldType,
        type: fieldType,
        options,
        required: opts?.required || false,
      },
      {
        page: opts?.page || null,
        profile: clientProfile,
        tenant: opts?.tenant || clientProfile?._tenant || '',
        company: opts?.company || clientProfile?._company || '',
        step: opts?.step || '',
        resumePath: opts?.resumePath || clientProfile?._resumePath,
      },
    );

    if (!llmAnswer) return null;

    // Align to DOM options if available
    let finalAnswer = llmAnswer;
    if (options.length > 0 && /dropdown|select|combobox|radio/i.test(fieldType)) {
      const aligned = alignAnswerToWorkdayOptions(llmAnswer, options, fieldType);
      if (aligned) finalAnswer = aligned;
    }

    // Auto-save to Supabase client_questions for future Tier 1 lookups
    const awlId = clientId || clientProfile?._applyWizzId || clientProfile?.applywizz_id || '';
    if (awlId && isSupabaseConfigured() && opts?.dryRun !== true) {
      try {
        const { persistNewResolvedAnswer } = await import('./supabaseClient.mjs');
        await persistNewResolvedAnswer({
          applywizzId: awlId,
          distributionId: clientProfile?._distributionId || null,
          jobUrl: opts?.jobUrl || clientProfile?._jobUrl || '',
          question,
          answer: finalAnswer,
          fieldType,
          options,
          source: 'llm_tier6',
        });
        recordSupabaseAnswerInMemory(clientProfile, question, finalAnswer);
        if (clientProfile?._resolvedAnswersMap instanceof Map) {
          clientProfile._resolvedAnswersMap.set(question, { answer: finalAnswer, rawQ: question });
          clientProfile._resolvedAnswersMap.set(normalizeLabel(question), { answer: finalAnswer, rawQ: question });
        }
      } catch (e) {
        console.log(`    ⚠️  [Tier 6] Persist Q&A error: ${String(e?.message || e).slice(0, 80)}`);
      }
    }

    trace({
      stage: 'tier6',
      clientId,
      query: normalizeLabel(question),
      hit: true,
      llmChoice: finalAnswer,
      allowedOptions: options,
    });

    return { answer: finalAnswer, sourceType: 'llm_tier6', confidence: 0.72 };
  } catch (err) {
    trace({
      stage: 'tier6',
      clientId,
      query: normalizeLabel(question),
      hit: false,
      error: String(err?.message || err).slice(0, 120),
    });
    return null;
  }
}

// ─── Main 6-Tier Resolver ────────────────────────────────────────────────────

/**
 * Main 6-tier resolver. Returns { answer, sourceType, tier, confidence, answerIsQuestionTrue }
 *
 * @param {object} params
 * @param {string} params.question         - question label text
 * @param {string} params.fieldType        - 'text'|'dropdown'|'radio'|'checkbox'|'spinbutton'
 * @param {string[]} params.options        - live DOM options (for dropdowns/radios)
 * @param {object} params.clientProfile    - full hydrated client profile from Supabase+CRM+Resume
 * @param {string} params.clientId         - applywizz_id
 * @param {object} params.qaBank           - pre-loaded Q&A bank for this client
 * @param {object} [params.opts]           - extra options (page, tenant, company, dryRun, required, etc.)
 * @returns {Promise<{answer: string|null, sourceType: string, tier: number|null, confidence: number, answerIsQuestionTrue: boolean}>}
 */
export async function resolveAnswer(params) {
  const {
    question,
    fieldType = 'text',
    options = [],
    clientProfile = {},
    clientId = '',
    qaBank = {},
    opts = {},
  } = params;

  if (!question) {
    return { answer: null, sourceType: 'unresolved', tier: null, confidence: 0, answerIsQuestionTrue: false };
  }

  const unresolved = () => ({
    answer: null,
    sourceType: 'unresolved',
    tier: null,
    confidence: 0,
    answerIsQuestionTrue: false,
  });

  const resolved = (answer, sourceType, tier, confidence) => ({
    answer,
    sourceType,
    tier,
    confidence,
    answerIsQuestionTrue: confidence > 0.5 && Boolean(answer),
  });

  // ─── Tier 1: Supabase ─────────────────────────────────────────────────────
  const t1 = await tier1Supabase(question, clientProfile, options, fieldType);
  if (t1?.answer) {
    console.log(`    🗄️  [Tier 1 Supabase] "${question.slice(0, 55)}" ← "${String(t1.answer).slice(0, 45)}"`);
    return resolved(t1.answer, t1.sourceType, 1, t1.confidence);
  }
  trace({ stage: 'tier1', clientId, query: normalizeLabel(question), hit: false });

  // ─── Tier 2: Resume ───────────────────────────────────────────────────────
  const t2 = await tier2Resume(question, clientProfile, options, fieldType);
  if (t2?.answer) {
    console.log(`    📄 [Tier 2 Resume] "${question.slice(0, 55)}" ← "${String(t2.answer).slice(0, 45)}"`);
    return resolved(t2.answer, t2.sourceType, 2, t2.confidence);
  }
  trace({ stage: 'tier2', clientId, query: normalizeLabel(question), hit: false });

  // ─── Tier 3: Apply Wizz CRM ───────────────────────────────────────────────
  const t3 = tier3Crm(question, clientProfile, options, fieldType);
  if (t3?.answer) {
    console.log(`    🌐 [Tier 3 CRM] "${question.slice(0, 55)}" ← "${String(t3.answer).slice(0, 45)}"`);
    return resolved(t3.answer, t3.sourceType, 3, t3.confidence);
  }
  trace({ stage: 'tier3', clientId, query: normalizeLabel(question), hit: false });

  // ─── Tier 4: Q&A Bank ────────────────────────────────────────────────────
  const tenant = opts?.tenant || clientProfile?._tenant || '';
  const t4 = await tier4QaBank(question, qaBank, options, fieldType, tenant);
  if (t4?.answer) {
    console.log(`    🏦 [Tier 4 QA Bank] "${question.slice(0, 55)}" ← "${String(t4.answer).slice(0, 45)}"`);
    return resolved(t4.answer, t4.sourceType, 4, t4.confidence);
  }
  trace({ stage: 'tier4', clientId, query: normalizeLabel(question), hit: false });

  // ─── Tier 5: Semantic + Fuzzy ─────────────────────────────────────────────
  const t5 = tier5SemanticFuzzy(question, clientProfile, qaBank, options, fieldType);
  if (t5?.answer) {
    console.log(`    🔍 [Tier 5 Semantic/Fuzzy] "${question.slice(0, 55)}" ← "${String(t5.answer).slice(0, 45)}" (score=${t5.confidence.toFixed(2)})`);
    return resolved(t5.answer, t5.sourceType, 5, t5.confidence);
  }
  trace({ stage: 'tier5', clientId, query: normalizeLabel(question), hit: false });

  // ─── Tier 6: LLM ─────────────────────────────────────────────────────────
  const t6 = await tier6Llm(question, clientProfile, qaBank, options, fieldType, clientId, opts);
  if (t6?.answer) {
    console.log(`    🤖 [Tier 6 LLM → Saved] "${question.slice(0, 55)}" ← "${String(t6.answer).slice(0, 45)}"`);
    return resolved(t6.answer, t6.sourceType, 6, t6.confidence);
  }
  trace({ stage: 'tier6', clientId, query: normalizeLabel(question), hit: false, allowedOptions: options });

  return unresolved();
}
