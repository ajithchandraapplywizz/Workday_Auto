import fs from 'node:fs';
import path from 'node:path';

let traceFilePath = null;

function getTraceFile() {
  if (!traceFilePath) {
    const runsDir = path.resolve(process.cwd(), 'runs');
    try {
      if (!fs.existsSync(runsDir)) {
        fs.mkdirSync(runsDir, { recursive: true });
      }
    } catch {
      // ignore directory creation error
    }
    traceFilePath = path.join(runsDir, `trace-${Date.now()}.jsonl`);
  }
  return traceFilePath;
}

let latestTraceFilePath = null;

export function getTraceFilePath() {
  return getTraceFile();
}

export function getLatestTraceFilePath() {
  if (!latestTraceFilePath) {
    const runsDir = path.resolve(process.cwd(), 'runs');
    latestTraceFilePath = path.join(runsDir, 'latest-trace.jsonl');
  }
  return latestTraceFilePath;
}

/**
 * Normalizes any answer source into its standard tier classification.
 */
export function determineTier(source = '') {
  if (!source) return 'tier_unknown';
  const s = String(source).toLowerCase();
  if (/minimum_age|age/.test(s)) return 'tier0_age_guard';
  if (/sensitive/.test(s)) return 'tier0_sensitive_guard';
  if (/supabase|clients_table|client_fact|client_question/.test(s)) return 'tier1_supabase';
  if (/applywizz|crm/.test(s)) return 'tier2_crm';
  if (/resume|experience/.test(s)) return 'tier3_resume';
  if (/llm|gpt|claude|openrouter/.test(s)) return 'tier4_llm';
  if (/memory|verified/.test(s)) return 'tier1_verified_memory';
  if (/profile|user|contact|personal|education/.test(s)) return 'tier1_profile_fact';
  if (/default|deterministic/.test(s)) return 'tier1_defaults';
  return source;
}

/**
 * Redact sensitive PII and credential patterns from values
 */
export function redactPii(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    return obj
      // Email
      .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]')
      // Phone numbers (US/Intl formatted numbers or 10+ digits)
      .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[REDACTED_PHONE]')
      // Tokens/keys (JWT, Bearer, OpenRouter keys, Supabase keys)
      .replace(/(?:Bearer\s+|ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*|sk-[A-Za-z0-9-_]{20,}|sbp_[A-Za-z0-9]{20,})/gi, '[REDACTED_SECRET]');
  }
  if (Array.isArray(obj)) {
    return obj.map(redactPii);
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/password|secret|token|api_?key|auth|authorization|private/i.test(k)) {
        out[k] = '[REDACTED_SECRET]';
      } else if (/email/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED_EMAIL]';
      } else if (/phone|mobile/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = '[REDACTED_PHONE]';
      } else {
        out[k] = redactPii(v);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Non-invasive, try-catch safe structured JSONL event tracer.
 * Supported stages: 'scan', 'tier1', 'tier2', 'tier3', 'tier4', 'fill', 'verify', 'loop_guard', 'field_trace'
 * 
 * @param {object} event
 */
export function trace(event) {
  try {
    const sanitized = redactPii(event);
    const line = JSON.stringify({ t: new Date().toISOString(), ...sanitized }) + '\n';
    fs.appendFileSync(getTraceFile(), line);
    try {
      fs.appendFileSync(getLatestTraceFilePath(), line);
    } catch {
      // ignore latest mirror error
    }
  } catch (err) {
    // Silent fail so tracing can never break production runtime
  }
}

/**
 * Logs a standardized per-field trace event.
 * Mandatory attributes: automation-id, label text, classified control type, tier, value attempted, success/fail.
 */
export function logFieldTrace({
  automationId = '',
  label = '',
  controlType = '',
  tier = '',
  valueAttempted = '',
  success = false,
  reason = '',
  step = '',
  page = 1,
} = {}) {
  const normTier = determineTier(tier);
  const cleanAid = String(automationId || 'unknown').trim();
  const cleanLabel = String(label || 'unlabeled').replace(/\s+/g, ' ').trim();
  const cleanType = String(controlType || 'unknown').trim();
  const cleanVal = valueAttempted != null ? String(valueAttempted).trim() : '';
  const isSuccess = Boolean(success);

  const event = {
    stage: 'field_trace',
    automationId: cleanAid,
    label: cleanLabel,
    controlType: cleanType,
    tier: normTier,
    valueAttempted: cleanVal,
    success: isSuccess,
    status: isSuccess ? 'success' : 'fail',
    reason: reason || (isSuccess ? 'verified' : 'unverified'),
    step: step || '',
    page: page || 1,
  };

  trace(event);

  const icon = isSuccess ? '✅ SUCCESS' : `❌ FAIL${reason ? ` (${reason})` : ''}`;
  console.log(`  📊 [FIELD TRACE] aid="${cleanAid}" | label="${cleanLabel.slice(0, 45)}" | type=${cleanType} | tier=${normTier} | val="${cleanVal.slice(0, 35)}" | ${icon}`);

  return event;
}
