/**
 * tokenUsage.mjs — Backend module for calculating LLM token costs & persisting usage
 * =================================================================================
 * Native ES module for Workday auto-apply backend workers & queue daemon.
 */

import { httpsJsonWithRetry } from './httpClient.mjs';
import { loadLocalEnvOnce } from './supabaseClient.mjs';

/**
 * OpenRouter & provider pricing matrix (per 1,000,000 tokens in USD).
 */
export const MODEL_PRICING = {
  // OpenAI
  'openai/gpt-4o-mini': {
    prompt: 0.15,
    completion: 0.60,
    cache_read: 0.075,
    cache_write: 0.15,
  },
  'openai/gpt-4o': {
    prompt: 2.50,
    completion: 10.00,
    cache_read: 1.25,
    cache_write: 2.50,
  },
  // Google Gemini
  'google/gemini-2.5-flash-lite': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  'google/gemini-2.0-flash-lite': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  'google/gemini-2.0-flash-001': {
    prompt: 0.10,
    completion: 0.40,
    cache_read: 0.025,
    cache_write: 0.10,
  },
  'google/gemini-flash-1.5': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  // Meta Llama
  'meta-llama/llama-3.3-70b-instruct': {
    prompt: 0.13,
    completion: 0.40,
    cache_read: 0.065,
    cache_write: 0.13,
  },
  // Anthropic Claude
  'anthropic/claude-3-5-haiku': {
    prompt: 0.80,
    completion: 4.00,
    cache_read: 0.08,
    cache_write: 1.00,
  },
  'anthropic/claude-3-haiku': {
    prompt: 0.25,
    completion: 1.25,
    cache_read: 0.03,
    cache_write: 0.30,
  },
  default: {
    prompt: 0.15,
    completion: 0.60,
    cache_read: 0.075,
    cache_write: 0.15,
  },
};

/**
 * Returns pricing rates for a given model.
 */
export function getModelPricing(model = '') {
  const normalized = String(model || '').toLowerCase().trim();

  if (normalized.endsWith(':free') || normalized.includes(':free')) {
    return { prompt: 0.0, completion: 0.0, cache_read: 0.0, cache_write: 0.0 };
  }

  if (MODEL_PRICING[normalized]) {
    return MODEL_PRICING[normalized];
  }

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== 'default' && (normalized.includes(key) || key.includes(normalized))) {
      return pricing;
    }
  }

  if (normalized.includes('gpt-4o-mini')) return MODEL_PRICING['openai/gpt-4o-mini'];
  if (normalized.includes('gpt-4o')) return MODEL_PRICING['openai/gpt-4o'];
  if (normalized.includes('gemini') && normalized.includes('flash')) return MODEL_PRICING['google/gemini-2.5-flash-lite'];
  if (normalized.includes('llama-3.3-70b')) return MODEL_PRICING['meta-llama/llama-3.3-70b-instruct'];

  return MODEL_PRICING.default;
}

/**
 * Calculates dollar cost for prompt, completion, and cache tokens.
 */
export function calculateTokenCost({
  model = '',
  prompt_tokens = 0,
  completion_tokens = 0,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
} = {}) {
  const pricing = getModelPricing(model);

  const promptCost = (Number(prompt_tokens || 0) * pricing.prompt) / 1_000_000;
  const completionCost = (Number(completion_tokens || 0) * pricing.completion) / 1_000_000;
  const cacheReadCost = (Number(cache_read_tokens || 0) * pricing.cache_read) / 1_000_000;
  const cacheWriteCost = (Number(cache_write_tokens || 0) * pricing.cache_write) / 1_000_000;

  const totalCost = promptCost + completionCost + cacheReadCost + cacheWriteCost;
  const totalTokens = Number(prompt_tokens || 0) + Number(completion_tokens || 0);

  return {
    model,
    prompt_tokens: Number(prompt_tokens || 0),
    completion_tokens: Number(completion_tokens || 0),
    cache_read_tokens: Number(cache_read_tokens || 0),
    cache_write_tokens: Number(cache_write_tokens || 0),
    total_tokens: totalTokens,
    prompt_cost: Number(promptCost.toFixed(6)),
    completion_cost: Number(completionCost.toFixed(6)),
    cache_read_cost: Number(cacheReadCost.toFixed(6)),
    cache_write_cost: Number(cacheWriteCost.toFixed(6)),
    total_cost: Number(totalCost.toFixed(6)),
  };
}

/**
 * Persists token usage directly via Supabase REST client.
 */
export async function recordApplicationTokenUsage({
  applywizz_id,
  job_url,
  role = 'Candidate',
  application_id = null,
  model = 'openai/gpt-4o-mini',
  prompt_tokens = 0,
  completion_tokens = 0,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
  metadata = {},
  date = null,
  tableName = 'workday_application_token_usage',
} = {}) {
  loadLocalEnvOnce();
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !key) {
    console.warn('[TokenUsage] Supabase not configured. Skipping remote persistence.');
    return null;
  }

  const today = date || new Date().toISOString().split('T')[0];
  const calculated = calculateTokenCost({
    model,
    prompt_tokens,
    completion_tokens,
    cache_read_tokens,
    cache_write_tokens,
  });

  try {
    // 1. Check existing record
    const selectUrl = `${url}/rest/v1/${tableName}?applywizz_id=eq.${encodeURIComponent(applywizz_id)}&job_url=eq.${encodeURIComponent(job_url)}&date=eq.${today}&select=*`;
    const checkRes = await httpsJsonWithRetry({
      url: selectUrl,
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }, { attempts: 2, label: `CheckTokenUsage:${tableName}` });

    const existingRows = checkRes.ok && checkRes.text ? checkRes.json() : [];
    const existing = Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;

    if (existing) {
      const updatedPrompt = (existing.prompt_tokens || 0) + calculated.prompt_tokens;
      const updatedCompletion = (existing.completion_tokens || 0) + calculated.completion_tokens;
      const updatedCacheRead = (existing.cache_read_tokens || 0) + calculated.cache_read_tokens;
      const updatedCacheWrite = (existing.cache_write_tokens || 0) + calculated.cache_write_tokens;
      const updatedTotal = (existing.total_tokens || 0) + calculated.total_tokens;
      const updatedCost = Number((Number(existing.token_cost || 0) + calculated.total_cost).toFixed(6));

      const mergedMetadata = {
        ...(existing.metadata || {}),
        ...metadata,
        last_updated_at: new Date().toISOString(),
        call_count: ((existing.metadata?.call_count || 1) + 1),
      };

      const updateUrl = `${url}/rest/v1/${tableName}?id=eq.${existing.id}`;
      const updateRes = await httpsJsonWithRetry({
        url: updateUrl,
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: {
          prompt_tokens: updatedPrompt,
          completion_tokens: updatedCompletion,
          cache_read_tokens: updatedCacheRead,
          cache_write_tokens: updatedCacheWrite,
          total_tokens: updatedTotal,
          token_cost: updatedCost,
          metadata: mergedMetadata,
          updated_at: new Date().toISOString(),
        },
      }, { attempts: 2, label: `UpdateTokenUsage:${tableName}` });

      return updateRes.ok ? updateRes.json() : null;
    }

    // 2. Insert fresh row
    const insertUrl = `${url}/rest/v1/${tableName}`;
    const insertRes = await httpsJsonWithRetry({
      url: insertUrl,
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: {
        applywizz_id,
        job_url,
        role,
        application_id,
        model,
        prompt_tokens: calculated.prompt_tokens,
        completion_tokens: calculated.completion_tokens,
        cache_read_tokens: calculated.cache_read_tokens,
        cache_write_tokens: calculated.cache_write_tokens,
        total_tokens: calculated.total_tokens,
        token_cost: calculated.total_cost,
        date: today,
        metadata: {
          ...metadata,
          first_call_at: new Date().toISOString(),
          call_count: 1,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }, { attempts: 2, label: `InsertTokenUsage:${tableName}` });

    return insertRes.ok ? insertRes.json() : null;
  } catch (err) {
    console.error(`[TokenUsage ERROR] Failed to record token usage in ${tableName}:`, err.message);
    return null;
  }
}
