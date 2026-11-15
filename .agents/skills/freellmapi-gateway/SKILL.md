---
name: freellmapi-gateway
description: >-
  Connects Workday Auto to FreeLLMAPI (or direct free provider tiers) for 100% free AI inference.
  Aggregates free quotas from 87+ providers (Groq Llama 3.3 70B, Cerebras, Google Gemini Flash, Mistral)
  via an OpenAI-compatible /v1 endpoint (http://localhost:3000/v1). Provides automatic rate-limit failover
  on HTTP 429 errors and slashes monthly LLM API bills to $0 during massive Workday job application runs.
  Activate when configuring free LLM inference, handling rate limits, or optimizing batch question resolution costs.
---

# FreeLLMAPI Gateway Integration

This skill establishes the integration between Workday Auto and FreeLLMAPI, an open-source inference gateway that aggregates free-tier quotas from 87+ AI providers (~10.1 billion tokens/month).

---

## 1. Why FreeLLMAPI for Workday Auto?

In Workday Auto:
- When processing batches of 100+ job links across dozens of candidates, Tier 4 question resolution can consume thousands of paid LLM tokens (OpenRouter, Claude, OpenAI).
- Paid API keys occasionally hit rate limits (`HTTP 429`) or balance depletion, stalling the daemon queue.
- FreeLLMAPI provides a unified, local OpenAI-compatible endpoint (`http://localhost:3000/v1`) that automatically routes requests to free providers and fails over instantly on rate limits.

---

## 2. Architecture & Request Routing

```text
Workday Auto Engine (Tier 4 Live DOM Resolver)
                      │
                      ▼
         POST http://localhost:3000/v1/chat/completions
                      │
                      ▼
           [FreeLLMAPI Smart Router]
           ├─ 1. Groq (Llama 3.3 70B Versatile) ── (Instant, 30 RPM free)
           ├─ 2. Cerebras (Llama 3.3 70B) ───────── (2,000 tok/sec free fallback)
           ├─ 3. Google AI Studio (Gemini 2.5 Flash) (15 RPM free fallback)
           └─ 4. Mistral / Cloudflare Workers AI ── (Resilient backup)
                      │
                      ▼
     Streams Form Resolution Back to Playwright Engine
```

---

## 3. Client Adapter Implementation

In `backend/lib/freeLlmClient.mjs`:
```javascript
import fetch from 'node-fetch';

const FREE_LLM_ENDPOINT = process.env.FREE_LLM_URL || 'http://localhost:3000/v1';
const FREE_LLM_MODEL = process.env.FREE_LLM_MODEL || 'groq/llama-3.3-70b-versatile';

export async function resolveQuestionViaFreeLLM(questionText, options, candidateProfile) {
  const prompt = `You are an ATS form resolution assistant. Given the question and options, choose the single best answer for the applicant based strictly on their facts.

Applicant:
${JSON.stringify(candidateProfile, null, 2)}

Question:
"${questionText}"

Options:
${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}

Return ONLY the exact option text. No explanation.`;

  try {
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
      timeout: 10000,
    });

    if (!res.ok) {
      throw new Error(`FreeLLMAPI HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn(`[FreeLLMAPI] Fallback failed: ${err.message}. Falling back to standard OpenRouter.`);
    return null; // Cascades to OpenRouter / Claude
  }
}
```

---

## 4. Operational Best Practices

1. **Docker Setup for Local Development**:
   - The FreeLLMAPI repository includes a pre-built `docker-compose.yml`.
   - Run `docker-compose up -d` in `ALL_OPEN_SOURCE_REPO'S/freellmapi` to expose `http://localhost:3000/v1`.
2. **Deterministic Pre-Filtering**:
   - Combine with `tiered-answer-resolution`: Always attempt deterministic regex and verified QA bank matches before querying FreeLLMAPI.
3. **Graceful Cascade**:
   - FreeLLMAPI operates as a cost-saving tier between Tier 3 (Resume) and paid OpenRouter/Claude Tier 4. If FreeLLMAPI is unreachable or offline, the engine seamlessly falls back to direct OpenRouter/Claude keys.
