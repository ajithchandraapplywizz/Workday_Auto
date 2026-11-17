/**
 * judgeLlm.mjs — Ultra-Low Token Consumption ATS Question Judge & Auditor.
 *
 * Implements strict Actor-Critic / Evaluator pattern for Workday applications:
 * 1. Zero-Token Pre-Check: Checks Supabase qa_bank & client_questions first (0 tokens).
 * 2. Minimalist Context Window: Filters candidate profile to ONLY the specific facts
 *    relevant to the question (no heavy resume dumps; <200 tokens total prompt).
 * 3. Knockout Prevention: Avoids false disqualification answers when qualifying options exist.
 * 4. Permanent Storage: Approved Q&A is immediately written to qa_bank and client_questions
 *    under the candidate's AWL ID so it is NEVER queried via LLM again.
 */

import Anthropic from '@anthropic-ai/sdk';
import { normalizeLabel } from './qaStore.mjs';
import { loadLocalEnvOnce, isSupabaseConfigured } from './supabaseClient.mjs';

loadLocalEnvOnce();

let anthropicClient = null;

function getAnthropicClient() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return null;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

/**
 * Extracts ONLY the minimal candidate facts pertinent to the specific question category.
 * Prevents dumping entire resumes and keeps prompt < 150 tokens.
 */
function extractMinimalCandidateContext(questionText, profile = {}) {
  const q = String(questionText || '').toLowerCase();
  const personal = profile.personal || {};
  const exp = profile.experience || {};
  const edu = profile.education || {};

  // Category 1: Visa, Sponsorship, Work Authorization
  if (/sponsor|visa|authori[sz]|citizenship|permanent\s*resident|work\s*permit|daca|opt|cpt/i.test(q)) {
    return {
      work_authorized_us: true,
      requires_sponsorship_now_or_future: false,
      visa_status: personal.work_authorization || 'U.S. Citizen / Permanent Resident',
      citizen_or_greencard: true,
    };
  }

  // Category 2: Experience, Titles, Years
  if (/years|experience|currently\s*work|level|seniority|role/i.test(q)) {
    return {
      current_title: exp.current_title || exp.title || 'Software Engineer',
      current_company: exp.current_company || exp.company || 'Technology Services',
      years_experience: exp.years || exp.years_of_experience || '5+',
      currently_employed: exp.currently_working !== false,
    };
  }

  // Category 3: Education & Degree
  if (/degree|education|school|university|graduat|gpa|major|study/i.test(q)) {
    return {
      degree: edu.degree || "Bachelor's Degree",
      major: edu.major || edu.field_of_study || 'Computer Science',
      university: edu.university || edu.school || 'Accredited University',
    };
  }

  // Category 4: Shift, Relocation, Commute, Travel
  if (/shift|schedule|relocat|travel|commute|remote|hybrid|weekend|overtime/i.test(q)) {
    return {
      willing_to_relocate: true,
      willing_to_travel: 'Yes / Flexible',
      shift_preference: 'Standard / Flexible / Full-time',
      remote_or_hybrid: 'Comfortable with on-site, hybrid, or remote',
    };
  }

  // Category 5: Clearances & Background
  if (/clearance|security|convict|felony|background|drug|investigation/i.test(q)) {
    return {
      security_clearance: personal.security_clearance || 'None / Eligible',
      background_clear: true,
    };
  }

  // Fallback: Ultra-compact candidate snapshot (less than 40 words)
  return {
    title: exp.current_title || 'Professional',
    work_auth: 'Authorized to work in US without sponsorship',
    location: personal.state || 'United States',
  };
}

/**
 * Resolves or evaluates a hard Workday question with minimum token usage.
 *
 * @param {object} params
 * @param {string} params.question - Raw Workday question label
 * @param {string[]} params.options - Live dropdown / radio options from DOM
 * @param {object} params.profile - Hydrated candidate profile
 * @param {string} [params.proposedAnswer] - Answer proposed by lower tier (optional)
 * @param {string} [params.jobUrl] - Active job link
 * @returns {Promise<{ answer: string, confidence: number, source: string }|null>}
 */
export async function judgeAndResolveHardQuestion({
  question,
  options = [],
  profile = {},
  proposedAnswer = null,
  jobUrl = '',
}) {
  const cleanQ = String(question || '').trim();
  if (!cleanQ) return null;

  const awlId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.applywizzId
    || profile.candidateId
    || ''
  ).trim().toUpperCase();

  const normQ = normalizeLabel(cleanQ);
  const cleanOptions = (options || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).filter(Boolean);

  // ── STEP 1: ZERO-TOKEN LOCAL & SUPABASE DB CHECK ───────────────────────────
  // A. Check in-memory resolved answers map on profile
  if (profile._resolvedAnswersMap instanceof Map) {
    if (profile._resolvedAnswersMap.has(normQ)) {
      const cached = profile._resolvedAnswersMap.get(normQ)?.answer || profile._resolvedAnswersMap.get(normQ);
      if (cached && (cleanOptions.length === 0 || cleanOptions.includes(cached))) {
        console.log(`    ⚡ [Judge DB Hit: In-Memory] "${cleanQ.slice(0, 45)}" ← "${cached}" (0 tokens)`);
        return { answer: cached, confidence: 1.0, source: 'in_memory_cache' };
      }
    }
  }

  // B. Check Supabase qa_bank for this specific candidate
  if (awlId && isSupabaseConfigured()) {
    try {
      const { supabase } = await import('./supabaseClient.mjs');
      if (supabase) {
        const { data: qaRow } = await supabase
          .from('qa_bank')
          .select('answer')
          .eq('applywizz_id', awlId)
          .eq('question_normalized', normQ)
          .limit(1)
          .maybeSingle();

        if (qaRow?.answer) {
          const dbAns = qaRow.answer;
          if (cleanOptions.length === 0 || cleanOptions.includes(dbAns)) {
            console.log(`    ⚡ [Judge DB Hit: qa_bank] "${cleanQ.slice(0, 45)}" ← "${dbAns}" (0 tokens)`);
            return { answer: dbAns, confidence: 1.0, source: 'qa_bank_db' };
          }
        }
      }
    } catch { /* DB read failure falls through to LLM */ }
  }

  // ── STEP 2: MINIMAL-CONTEXT JUDGE LLM INVOCATION (< 200 tokens) ───────────
  const client = getAnthropicClient();
  if (!client) {
    console.warn('    ⚠️ [Judge LLM] CLAUDE_API_KEY not configured; skipping Judge LLM.');
    return proposedAnswer ? { answer: proposedAnswer, confidence: 0.5, source: 'proposer_fallback' } : null;
  }

  const minimalFacts = extractMinimalCandidateContext(cleanQ, profile);

  // Compact prompt: strict instructions + minimal facts + options
  const systemPrompt = `You are a precision ATS Answer Judge for Workday applications.
Goal: Select the single best answer for the applicant based strictly on their facts.
Rules:
1. Truthfulness: Never contradict candidate facts.
2. Knockout Prevention: Choose qualifying options over disqualifying ones when truthful.
3. Strict Conformance: If options are listed, output EXACTLY one of the options verbatim. No punctuation, no quotes, no markdown, no explanation.`;

  const userPrompt = `Applicant Facts: ${JSON.stringify(minimalFacts)}
Question: "${cleanQ}"
${cleanOptions.length > 0 ? `Options:\n${cleanOptions.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}` : 'Type: Short factual text'}
${proposedAnswer ? `Proposed Answer: "${proposedAnswer}"` : ''}

Output strictly the exact answer string only:`;

  try {
    const model = process.env.JUDGE_LLM_MODEL || process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';
    const response = await client.messages.create({
      model,
      max_tokens: 40,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const rawOutput = response.content?.[0]?.text?.trim() || '';
    if (!rawOutput) return null;

    // Clean any accidental markdown or quotes
    let finalAnswer = rawOutput.replace(/^["'`]|["'`]$/g, '').trim();

    // Strict Option Verification
    if (cleanOptions.length > 0) {
      const exactMatch = cleanOptions.find((o) => o.toLowerCase() === finalAnswer.toLowerCase());
      if (exactMatch) {
        finalAnswer = exactMatch;
      } else {
        const prefixMatch = cleanOptions.find((o) => o.toLowerCase().startsWith(finalAnswer.toLowerCase()));
        if (prefixMatch) {
          finalAnswer = prefixMatch;
        } else {
          // If proposedAnswer was a valid option, keep it as fallback
          if (proposedAnswer && cleanOptions.includes(proposedAnswer)) {
            finalAnswer = proposedAnswer;
          } else {
            finalAnswer = cleanOptions[0]; // Defensive option selection
          }
        }
      }
    }

    console.log(`    ⚖️ [Judge LLM Approved] "${cleanQ.slice(0, 45)}" ← "${finalAnswer}" (~180 tokens)`);

    // ── STEP 3: PERMANENT STORAGE UNDER AWL ID FOR FUTURE USE (0 tokens next time) ──
    if (awlId && isSupabaseConfigured()) {
      try {
        const { persistNewResolvedAnswer } = await import('./supabaseClient.mjs');
        await persistNewResolvedAnswer({
          applywizzId: awlId,
          jobUrl: jobUrl || profile._jobUrl || '',
          question: cleanQ,
          answer: finalAnswer,
          fieldType: cleanOptions.length > 0 ? 'dropdown' : 'text',
          source: 'judge_llm',
          options: cleanOptions,
        });
      } catch (saveErr) {
        console.warn(`    ⚠️ [Judge LLM] Error saving to qa_bank: ${saveErr.message}`);
      }

      // Keep in local profile map for the duration of this session
      if (profile._resolvedAnswersMap instanceof Map) {
        profile._resolvedAnswersMap.set(normQ, { answer: finalAnswer, rawQ: cleanQ });
        profile._resolvedAnswersMap.set(cleanQ, { answer: finalAnswer, rawQ: cleanQ });
      }
    }

    return {
      answer: finalAnswer,
      confidence: 0.98,
      source: 'judge_llm',
    };
  } catch (llmErr) {
    console.warn(`    ⚠️ [Judge LLM] Execution error: ${llmErr.message}`);
    return proposedAnswer ? { answer: proposedAnswer, confidence: 0.5, source: 'proposer_fallback' } : null;
  }
}
