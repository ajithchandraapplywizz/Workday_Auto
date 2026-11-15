/**
 * freeLlmClient.mjs
 * 
 * FreeLLMAPI Gateway Integration Client.
 * Connects Workday Auto to local FreeLLMAPI proxy (http://localhost:3000/v1)
 * aggregating free-tier quotas from 87+ providers (Groq Llama 3.3 70B, Cerebras,
 * Google Gemini Flash, Mistral) for 100% free Tier 4 form resolution.
 */

const FREE_LLM_ENDPOINT = process.env.FREE_LLM_URL || 'http://localhost:3000/v1';
const FREE_LLM_MODEL = process.env.FREE_LLM_MODEL || 'groq/llama-3.3-70b-versatile';

/**
 * Attempt to resolve an ATS form question using the free FreeLLMAPI gateway.
 * Returns the resolved string option or null if unreachable / fallback required.
 * 
 * @param {string} questionText - Workday form question label
 * @param {string[]} options - Available options on the live DOM
 * @param {object} candidateProfile - Hydrated candidate profile data
 * @returns {Promise<string|null>}
 */
export async function resolveQuestionViaFreeLLM(questionText, options, candidateProfile) {
  if (!questionText || !Array.isArray(options) || options.length === 0) {
    return null;
  }

  const prompt = `You are an ATS form resolution assistant. Given the question and options, choose the single best answer for the applicant based strictly on their facts.

Applicant:
${JSON.stringify(candidateProfile || {}, null, 2)}

Question:
"${questionText}"

Options:
${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}

Return ONLY the exact option text. No explanation.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${FREE_LLM_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FREE_LLM_KEY || 'free'}`,
      },
      body: JSON.stringify({
        model: FREE_LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // Validate that returned text matches one of the DOM options
    const normalizedContent = content.toLowerCase().trim();
    const exactMatch = options.find((opt) => opt.toLowerCase().trim() === normalizedContent);
    if (exactMatch) return exactMatch;

    // Substring or fuzzy match among available options
    const partialMatch = options.find((opt) => opt.toLowerCase().includes(normalizedContent) || normalizedContent.includes(opt.toLowerCase()));
    return partialMatch || content;
  } catch (_err) {
    // Graceful fallback to upstream OpenRouter / Claude
    return null;
  }
}
