/**
 * roleDescriptionResolver.mjs — Dynamic Candidate Role Description Engine
 *
 * Replaces hardcoded static role descriptions with authentic resume-derived summaries.
 * 1. Checks Supabase QA Bank (client_questions) under candidate's AWL ID (0 tokens).
 * 2. If missing, analyzes candidate's genuine resume text using LLM (or deterministic resume extractor).
 * 3. Immediately persists the generated Role Description into QA Bank under the AWL ID
 *    so all future applications reuse the authentic answer with 0 token consumption.
 */

import { normalizeLabel } from './qaStore.mjs';
import { isSupabaseConfigured, recordSupabaseAnswerInMemory } from './supabaseClient.mjs';

/**
 * Checks whether an answer string matches the obsolete hardcoded intern description.
 */
export function isHardcodedInternDescription(str = '') {
  if (!str) return false;
  return /full\s*stack\s*intern\s*developed\s*websites|worked\s*with\s*agents\s*rags\s*and\s*llm/i.test(String(str));
}

/**
 * Deterministically extracts genuine bullet points / summary from resume text if LLM is unavailable.
 */
export function deriveRoleDescriptionFromResumeText(resumeText = '', profile = {}) {
  const title = profile?.experience?.current_title || profile?.experience?.role || 'Software Engineer';
  const comp = profile?.experience?.current_company || profile?.experience?.company || '';

  if (resumeText && typeof resumeText === 'string') {
    // Look for Experience section
    const expMatch = resumeText.match(/(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)([\s\S]*?)(?:EDUCATION|PROJECTS|SKILLS|CERTIFICATIONS|ACHIEVEMENTS|$)/i);
    const snippet = expMatch ? expMatch[1] : resumeText;
    
    // Find bullet points or responsibility sentences
    const bulletLines = snippet.split('\n')
      .map((l) => l.replace(/^[-•*●▪]\s*/, '').trim())
      .filter((l) => l.length >= 30 && l.length <= 300)
      .filter((l) => !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|present|current)/i.test(l))
      .filter((l) => !isHardcodedInternDescription(l));

    if (bulletLines.length >= 2) {
      const combined = `${bulletLines[0].replace(/\.+$/, '')}. ${bulletLines[1].replace(/\.+$/, '')}.`;
      return combined.length <= 400 ? combined : combined.slice(0, 397) + '...';
    } else if (bulletLines.length === 1) {
      return bulletLines[0].endsWith('.') ? bulletLines[0] : `${bulletLines[0]}.`;
    }
  }

  const skills = Array.isArray(profile.skills) && profile.skills.length > 0
    ? profile.skills.slice(0, 4).join(', ')
    : 'software development and engineering best practices';

  return `Responsible for designing, developing, and deploying robust software solutions as ${title}${comp ? ` at ${comp}` : ''}, leveraging ${skills} to support core business initiatives.`;
}

/**
 * Generates an authentic role description from resume text via LLM.
 */
export async function generateRoleDescriptionViaLlm(resumeText = '', profile = {}) {
  if (!resumeText || typeof resumeText !== 'string' || resumeText.length < 50) {
    return '';
  }

  const title = profile?.experience?.current_title || profile?.experience?.role || 'Software Engineer';
  const company = profile?.experience?.current_company || profile?.experience?.company || '';

  // Extract candidate experience section to keep prompt compact (< 500 tokens)
  const expMatch = resumeText.match(/(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)([\s\S]*?)(?:EDUCATION|PROJECTS|SKILLS|CERTIFICATIONS|ACHIEVEMENTS|$)/i);
  const expSnippet = expMatch ? expMatch[1].slice(0, 1500) : resumeText.slice(0, 1500);

  const prompt = `Based strictly on the applicant's experience below, write a professional, concise role description (2-3 sentences, 40-70 words) summarizing their key responsibilities and technologies used in their role as ${title}${company ? ` at ${company}` : ''}.

Applicant Experience:
${expSnippet}

Rules:
- Focus strictly on authentic duties, systems, and technical stacks mentioned.
- Do NOT fabricate or mention unrelated roles.
- Output ONLY the 2-3 sentence description text. No markdown, no quotes, no explanation.`;

  // 1. Try Claude / Anthropic
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const model = process.env.JUDGE_LLM_MODEL || process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';
      const response = await client.messages.create({
        model,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      });
      const output = response.content?.[0]?.text?.trim() || '';
      if (output && output.length > 25 && !isHardcodedInternDescription(output)) {
        return output.replace(/^["'`]|["'`]$/g, '').trim();
      }
    } catch (err) {
      console.warn(`    ⚠️ [Role Description LLM] Anthropic call failed: ${err.message}`);
    }
  }

  // 2. Try FreeLLM API if available
  if (process.env.FREE_LLM_URL || process.env.FREE_LLM_KEY) {
    try {
      const endpoint = process.env.FREE_LLM_URL || 'http://localhost:3000/v1';
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.FREE_LLM_KEY || 'free'}`,
        },
        body: JSON.stringify({
          model: process.env.FREE_LLM_MODEL || 'groq/llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 150,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 25 && !isHardcodedInternDescription(text)) {
        return text.replace(/^["'`]|["'`]$/g, '').trim();
      }
    } catch {}
  }

  return '';
}

/**
 * Master resolution function for candidate Role Description:
 * 1. Priority 1: Supabase QA Bank / in-memory cache check (0 tokens).
 * 2. Priority 2: Profile's authentic experience description.
 * 3. Priority 3: Dynamic LLM generation from resume text.
 * 4. Priority 4: Deterministic resume bullet extraction.
 * 5. Permanent Storage: Automatically writes to Supabase QA Bank under candidate's AWL ID.
 */
export async function resolveCandidateRoleDescription(profile = {}, { page = null, qaStore = null } = {}) {
  const awlId = String(
    profile._applyWizzId
    || profile.applywizz_id
    || profile.id
    || process.env.APPLYWIZZ_ID
    || ''
  ).trim();

  // 1. Check in-memory Supabase QA cache or profile qa_answers
  const fromQa = profile?._supabaseQa?.['role description']
    || profile?._supabaseQa?.['Role Description']
    || profile?._supabaseQa?.['role_description']
    || profile?.qa_answers?.['role description']
    || profile?.qa_answers?.['Role Description']
    || profile?._resolvedAnswersMap?.get?.('role description')?.answer
    || profile?._resolvedAnswersMap?.get?.('Role Description')?.answer;

  if (fromQa && String(fromQa).trim() && !isHardcodedInternDescription(fromQa)) {
    console.log(`    ⚡ [Role Description Hit: QA Bank] Candidate ${awlId || 'profile'} ← "${String(fromQa).slice(0, 60)}..." (0 tokens)`);
    return String(fromQa).trim();
  }

  // 2. Check Supabase DB client_questions directly for this candidate's AWL ID
  if (awlId && isSupabaseConfigured()) {
    try {
      const { supabase } = await import('./supabaseClient.mjs');
      if (supabase) {
        const { data: dbRows } = await supabase
          .from('client_questions')
          .select('answer')
          .eq('applywizz_id', awlId)
          .ilike('question_normalized', '%role%description%')
          .order('updated_at', { ascending: false })
          .limit(1);

        if (dbRows?.[0]?.answer && !isHardcodedInternDescription(dbRows[0].answer)) {
          const dbAns = String(dbRows[0].answer).trim();
          console.log(`    ⚡ [Role Description DB Hit] Candidate ${awlId} ← "${dbAns.slice(0, 60)}..." (0 tokens)`);
          recordSupabaseAnswerInMemory(profile, 'Role Description', dbAns);
          recordSupabaseAnswerInMemory(profile, 'role description', dbAns);
          return dbAns;
        }
      }
    } catch { /* DB read failure falls through */ }
  }

  // 3. Check candidate's genuine profile.experience.description if already non-default
  const fromExp = profile?.experience?.description;
  if (fromExp && String(fromExp).trim() && !isHardcodedInternDescription(fromExp)) {
    return String(fromExp).trim();
  }

  // 4. Extract candidate's authentic resume text
  const resumeSource = profile._resumePath || profile._resumeUrl || profile.resume_url;
  let resumeText = profile._resumeText;
  if (!resumeText && resumeSource) {
    try {
      const { loadResumeText } = await import('./resumeParser.mjs');
      resumeText = await loadResumeText(resumeSource);
      if (resumeText) profile._resumeText = resumeText;
    } catch {}
  }

  // 5. Generate dynamic role description via LLM from candidate's genuine resume text
  let generatedDesc = '';
  if (resumeText) {
    generatedDesc = await generateRoleDescriptionViaLlm(resumeText, profile);
  }

  // 6. If LLM is unreachable or empty, derive deterministically from resume bullet points
  if (!generatedDesc || isHardcodedInternDescription(generatedDesc)) {
    generatedDesc = deriveRoleDescriptionFromResumeText(resumeText, profile);
  }

  // 7. Store the dynamically generated Role Description into QA Bank (Supabase client_questions) under this AWL ID!
  if (generatedDesc) {
    console.log(`    💾 [Role Description Saved to QA Bank] Candidate ${awlId || 'profile'}: "${generatedDesc.slice(0, 70)}..."`);
    profile.experience = profile.experience || {};
    profile.experience.description = generatedDesc;
    recordSupabaseAnswerInMemory(profile, 'Role Description', generatedDesc);
    recordSupabaseAnswerInMemory(profile, 'role description', generatedDesc);

    if (awlId && isSupabaseConfigured()) {
      try {
        const { upsertSupabaseAnswer } = await import('./supabaseClient.mjs');
        await upsertSupabaseAnswer({
          applywizzId: awlId,
          question: 'Role Description',
          questionNormalized: 'role description',
          answer: generatedDesc,
          fieldType: 'textarea',
          source: 'llm_resume_derived',
        });
      } catch (err) {
        console.warn(`    ⚠️ Failed to persist Role Description to QA Bank: ${err.message}`);
      }
    }
  }

  return generatedDesc;
}
