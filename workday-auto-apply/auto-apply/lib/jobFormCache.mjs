/**
 * jobFormCache.mjs — Job Form Schema Caching & Pre-Resolution
 *
 * Facilitates repeatable Workday links:
 * - When Client 1 applies, discovers form questions & fields across wizard steps.
 * - Saves the full form schema to Supabase (job_form_schemas).
 * - When Client 2 (or 3, 4, 5) applies to the same job URL later:
 *   1. Loads the cached schema instantly from Supabase.
 *   2. Pre-resolves answers for Client 2 prior to filling.
 *   3. Fills with zero discovery or LLM delay.
 */

import { loadJobFormSchema, upsertJobFormSchema, canonicalJobPostingUrl } from './supabaseClient.mjs';
import { resolveClientAnswer } from './clientAnswer.mjs';
import { normalizeLabel } from './qaStore.mjs';

/**
 * Checks if a job URL already has a cached form schema in Supabase.
 * If found, pre-resolves answers for the target client.
 *
 * @param {object} params
 * @param {string} params.jobUrl
 * @param {object} params.profile
 * @returns {Promise<{ hit: boolean, schema?: object, preResolvedCount: number }>}
 */
export async function checkAndPreResolveJobForClient({ jobUrl, profile = {} }) {
  if (!jobUrl) return { hit: false, preResolvedCount: 0 };
  const schema = await loadJobFormSchema(jobUrl);
  if (!schema || !Array.isArray(schema.fields_schema) || !schema.fields_schema.length) {
    return { hit: false, preResolvedCount: 0 };
  }

  const clientId = profile?._applyWizzId || profile?.applywizz_id || profile?.personal?.email || 'unknown';
  console.log(`\n📋 [Cache Hit] Found cached form schema for job in Supabase! (${schema.fields_schema.length} fields across steps)`);
  console.log(`   Scanned originally by: ${schema.scanned_by_applywizz_id || 'unknown'} | Role: ${schema.role_title || schema.company || 'Workday posting'}`);
  console.log(`   ⚡ Pre-resolving answers for client ${clientId}...`);

  profile._answerCache = profile._answerCache || new Map();
  profile._supabaseQa = profile._supabaseQa || {};
  profile._preResolvedFields = profile._preResolvedFields || new Map();

  let preResolvedCount = 0;

  for (const field of schema.fields_schema) {
    const rawLabel = field.label || field.question_label || '';
    if (!rawLabel) continue;
    const norm = normalizeLabel(rawLabel);

    // If client already has an answer in memory or supabaseQa, retain it
    if (profile._supabaseQa[norm] || profile._answerCache.has(norm)) {
      preResolvedCount++;
      continue;
    }

    try {
      const resolved = await resolveClientAnswer({
        ...field,
        label: rawLabel,
        required: field.is_required || field.required,
      }, profile, {
        url: jobUrl,
        tenant: schema.tenant,
        company: schema.company,
        forceLlm: false,
      });

      if (resolved?.answer) {
        profile._answerCache.set(norm, resolved.answer);
        profile._supabaseQa[norm] = String(resolved.answer);
        profile._preResolvedFields.set(norm, resolved.answer);
        preResolvedCount++;
      }
    } catch {
      // Non-fatal; will fall back during live interaction if needed
    }
  }

  console.log(`   ✓ Pre-resolved ${preResolvedCount}/${schema.fields_schema.length} fields for ${clientId} prior to browser navigation.\n`);

  return {
    hit: true,
    schema,
    preResolvedCount,
  };
}

/**
 * Saves or updates discovered form schema in Supabase after an application run.
 */
export async function recordDiscoveredJobForm({
  jobUrl,
  profile = {},
  fields = [],
  stepNames = [],
  company = '',
  roleTitle = '',
  tenant = '',
} = {}) {
  if (!jobUrl || !fields.length) return false;

  const resolvedTenant = tenant || profile._tenant || '';
  const resolvedCompany = company || profile._company || '';
  const resolvedRole = roleTitle || profile._roleTitle || profile._jobTitle || '';
  const applywizzId = profile._applyWizzId || profile.applywizz_id || '';

  // Deduplicate fields by normalized label
  const deduped = [];
  const seen = new Set();
  for (const f of fields) {
    const label = f.label || f.id || '';
    const norm = normalizeLabel(label);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    deduped.push({
      label,
      normalized_label: norm,
      step: f.step || f.stepName || 'Application',
      field_type: f.fieldType || f.type || 'input',
      is_required: Boolean(f.required || f.is_required),
      options: Array.isArray(f.options) ? f.options.slice(0, 40) : [],
      automation_id: f.automationId || f.dataAutomationId || f.id || '',
    });
  }

  const success = await upsertJobFormSchema({
    jobUrl,
    tenant: resolvedTenant,
    company: resolvedCompany,
    roleTitle: resolvedRole,
    fieldsSchema: deduped,
    stepNames: Array.isArray(stepNames) && stepNames.length ? stepNames : [...new Set(deduped.map((d) => d.step))],
    scannedByApplywizzId: applywizzId,
  });

  if (success) {
    console.log(`  💾 Saved job form schema to Supabase (${deduped.length} fields) for future candidate reuse.`);
  }

  return success;
}
