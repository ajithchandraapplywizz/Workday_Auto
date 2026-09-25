import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';
import * as fuzzball from 'fuzzball';

const EXCLUDED_CATEGORIES = [
  'work_auth', 'sponsorship', 'salary', 'eeo', 'veteran', 'disability', 'criminal', 'why_this_company'
];

let callCount = 0;

const fallbackResponseSchema = z.object({
  answer: z.union([z.string(), z.null()]),
  supporting_fact_ids: z.array(z.string()).optional().default([]),
  reason: z.string()
});

export async function askLlmFallback(candidateId, tenant, intentKey, field, liveOptions, candidateFacts) {
  // Hard exclusion
  if (EXCLUDED_CATEGORIES.some(cat => intentKey.toLowerCase().includes(cat))) {
    return { ok: false, reason: 'Excluded category: requires human approval', answer: null };
  }

  const budget = parseInt(process.env.LLM_MAX_CALLS_PER_RUN || '10', 10);
  if (callCount >= budget) {
    return { ok: false, reason: 'LLM budget cap exceeded', answer: null };
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
  });

  const prompt = `You are a rigid AI assistant filling out a job application.
Question: "${field.label}"
Control Type: ${field.controlType || field.elementType}
${liveOptions && liveOptions.length > 0 ? `Live Options:\n${liveOptions.map(o => `- ${o}`).join('\n')}` : ''}

Candidate Facts:
${candidateFacts.map(f => `[${f.id}] ${f.text}`).join('\n')}

Output strict JSON matching this schema:
{
  "answer": "your answer or null if no facts support it",
  "supporting_fact_ids": ["fact_id_1"],
  "reason": "short explanation"
}`;

  callCount++;
  
  let resultStr = '';
  try {
    const msg = await anthropic.messages.create({
      model: process.env.LLM_FALLBACK_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    
    resultStr = msg.content[0].text;
    const jsonStr = resultStr.substring(resultStr.indexOf('{'), resultStr.lastIndexOf('}') + 1);
    const parsed = fallbackResponseSchema.parse(JSON.parse(jsonStr));

    if (parsed.answer === null) {
      return { ok: false, reason: parsed.reason || 'LLM returned null answer', answer: null };
    }

    // Verify 1: fact IDs exist
    const factIds = new Set(candidateFacts.map(f => f.id));
    for (const id of parsed.supporting_fact_ids) {
      if (!factIds.has(id)) {
        return { ok: false, reason: `LLM hallucinated fact ID: ${id}`, answer: null };
      }
    }

    // Verify 2: Dropdown snapping
    let adjustedAnswer = parsed.answer;
    const controlType = field.controlType || field.elementType;
    if (['dropdown', 'radio', 'checkbox'].includes(controlType) && liveOptions && liveOptions.length > 0) {
      let bestMatch = null;
      let highestScore = 0;
      for (const opt of liveOptions) {
        const score = fuzzball.token_set_ratio(String(adjustedAnswer).toLowerCase(), String(opt).toLowerCase());
        if (score > highestScore) {
          highestScore = score;
          bestMatch = opt;
        }
      }
      if (highestScore >= 80 && bestMatch) {
        adjustedAnswer = bestMatch;
      } else {
        return { ok: false, reason: `Could not snap LLM answer "${parsed.answer}" to live options`, answer: null };
      }
    }

    console.log(`[LLM Fallback] Answered "${adjustedAnswer}" based on facts [${parsed.supporting_fact_ids.join(',')}]`);
    return { ok: true, answer: adjustedAnswer, reason: parsed.reason };
    
  } catch (error) {
    console.error('[LLM Fallback] Failed:', error.message);
    return { ok: false, reason: `LLM execution failed: ${error.message}`, answer: null };
  }
}

export function resetLlmBudget() {
  callCount = 0;
}
