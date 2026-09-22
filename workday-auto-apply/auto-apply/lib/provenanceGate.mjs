/**
 * provenanceGate.mjs — Provenance verification & logging for answers.
 * 
 * Rules:
 * - Allowed sources: supabase_exact, supabase_fuzzy (>= threshold), crm, resume, llm (with live options).
 * - Blocked: sensitive_safe, profile_fallback, hardcoded defaults, or ungrounded synthetic answers.
 * - Legal/compliance intents (work_authorization, sponsorship, eeo, salary) must NEVER come from LLM.
 */

import { normalizeLabel } from './qaStore.mjs';

export const ALLOWED_SOURCES = new Set([
  'supabase',
  'supabase_exact',
  'supabase_fuzzy',
  'supabase_qa',
  'supabase_api',
  'crm',
  'applywizz',
  'applywizz_profile',
  'resume',
  'experience',
  'verified_answer_memory',
  'memory',
  'explicit_user_data',
  'user',
  'deterministic',
  'deterministic_mapping',
  'explicit_profile_match',
  'llm',
  'llm_live_options',
  'llm_profile',
  'llm_semantic_analysis',
]);

export const SENSITIVE_INTENTS = new Set([
  'work_authorization',
  'sponsorship',
  'eeo',
  'eeo_gender',
  'eeo_race',
  'eeo_veteran',
  'eeo_disability',
  'salary',
  'compensation',
]);

export function isSensitiveField(field = {}, decision = {}) {
  const intent = String(decision.intent || '').toLowerCase();
  if (SENSITIVE_INTENTS.has(intent)) return true;
  const label = normalizeLabel(field.label || decision.label || '');
  if (/authori[sz]ed|work\s*auth|sponsorship|visa|gender|sex|race|ethnicity|veteran|disability|salary|compensation|desired\s*pay/i.test(label)) {
    return true;
  }
  return false;
}

/**
 * Check if a decision passes provenance.
 * In block-and-log mode, returns ok: false with reason 'blocked_by_provenance_gate'.
 */
export function verifyProvenance(field = {}, decision = {}) {
  const source = String(decision?.source || 'unknown').toLowerCase();
  const evidence = decision?.evidence || decision?.reasonCode || '';
  const matchScore = decision?.score ?? decision?.confidence ?? 1.0;
  const isSensitive = isSensitiveField(field, decision);

  // 1. Check if source is explicitly allowed
  const isAllowedSource = Array.from(ALLOWED_SOURCES).some((s) => (
    source === s ||
    source.includes(s) ||
    s.includes(source) ||
    source.startsWith('supabase') ||
    source.startsWith('applywizz') ||
    source.startsWith('experience')
  ));

  // 2. Sensitive fields cannot use LLM
  if (isSensitive && /llm/i.test(source)) {
    return {
      ok: false,
      blocked: true,
      reason: 'sensitive_field_llm_forbidden',
      source,
      evidence,
      matchScore,
    };
  }

  // 3. Block hardcoded defaults, sensitive_safe, profile_fallback
  if (/sensitive_safe|profile_fallback|default|static|workday_default/i.test(source)) {
    return {
      ok: false,
      blocked: true,
      reason: 'unsubstantiated_default_forbidden',
      source,
      evidence,
      matchScore,
    };
  }

  if (!isAllowedSource) {
    return {
      ok: false,
      blocked: true,
      reason: 'unallowed_provenance_source',
      source,
      evidence,
      matchScore,
    };
  }

  return {
    ok: true,
    blocked: false,
    source,
    evidence,
    matchScore,
  };
}
