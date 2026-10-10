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

import {
  loadJobFormSchema,
  upsertJobFormSchema,
  canonicalJobPostingUrl,
  getPendingQueueTasksForUrl,
  updateQueueTaskStatus,
  saveScannedJob,
  saveResolvedAnswers,
  recordNovelQABankAnswer,
} from './supabaseClient.mjs';
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
  const validSchemaFields = schema.fields_schema.filter(
    (f) => !/password/i.test(f.field_type || '') && !/password/i.test(f.automation_id || '') && !/^(password|verify\s*new\s*password)\*?$/i.test((f.label || '').trim())
  );
  if (validSchemaFields.length === 0) {
    return { hit: false, preResolvedCount: 0 };
  }
  schema.fields_schema = validSchemaFields;

  // Invalidate partial schemas (e.g. only 1 step like 'My Information' or under 20 fields)
  const stepCount = (schema.step_names || []).length;
  const isPartial = stepCount <= 1 && validSchemaFields.length < 20;
  if (isPartial) {
    console.log(`   ℹ️ [Partial Schema in Supabase] Cached schema only has ${validSchemaFields.length} fields on ${stepCount} step (${(schema.step_names || []).join(', ')}). Proceeding with full multi-page scan.`);
    return { hit: false, schema, isPartial: true, preResolvedCount: 0 };
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

  // Deduplicate and store all application fields (First Name, Last Name, How did you hear, Questions, etc. - excluding auth passwords)
  const deduped = [];
  const seen = new Set();
  for (const f of fields) {
    const label = f.label || f.id || '';
    const autoId = f.automationId || f.dataAutomationId || f.id || '';
    const fType = f.fieldType || f.type || 'input';
    if (/password/i.test(fType) || /password/i.test(autoId) || /^(password|verify\s*new\s*password)\*?$/i.test(label.trim())) {
      continue;
    }

    const norm = normalizeLabel(label);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    const isRequired = Boolean(f.required || f.is_required);
    deduped.push({
      label,
      normalized_label: norm,
      step: f.step || f.stepName || 'Application',
      field_type: fType,
      is_required: isRequired,
      options: Array.isArray(f.options) ? f.options.slice(0, 40) : [],
      automation_id: autoId,
    });
  }

  if (deduped.length === 0) return false;

  // 1. Save to job_form_schemas table (scanned_jobs is strictly reserved for Review & Submit reached applications)
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
    console.log(`  💾 Saved required job form schema to Supabase scanned_jobs & schemas (${deduped.length} required fields) for candidate reuse.`);
  }

  // 3. Immediately pre-resolve and save for the initiating client if profile is present
  if (applywizzId) {
    try {
      const detailed = await preResolveClientAnswersDetailed({
        jobUrl,
        schema: { fields_schema: deduped, tenant: resolvedTenant, company: resolvedCompany, role_title: resolvedRole },
        profile,
      });
      await saveResolvedAnswers({
        applywizzId,
        jobUrl,
        company: resolvedCompany,
        roleTitle: resolvedRole,
        resolvedAnswersJson: detailed.structuredAnswers,
        isFullyAnswered: detailed.isFullyAnswered,
        unansweredCount: detailed.unansweredCount,
        status: detailed.isFullyAnswered ? 'ready_for_review' : 'needs_answers',
      }).catch(() => {});
    } catch {}
  }

  return success;
}

/**
 * Pre-resolve all required answers for a candidate with full metadata & source tagging.
 */
export async function preResolveClientAnswersDetailed({ jobUrl, schema, profile = {} }) {
  if (!schema?.fields_schema?.length) {
    return { answersMap: {}, structuredAnswers: [], unansweredQuestions: [], isFullyAnswered: false, unansweredCount: 0, status: 'needs_answers' };
  }
  const answersMap = {};
  const structuredAnswers = [];
  const unansweredQuestions = [];
  let unansweredCount = 0;
  const awlId = profile?._applyWizzId || profile?.applywizz_id || '';

  for (const field of schema.fields_schema) {
    const rawLabel = field.label || field.question_label || '';
    const norm = field.normalized_label || normalizeLabel(rawLabel);
    if (!norm) continue;

    let ansVal = null;
    let sourceTag = '[API]';
    let rawSource = 'api';
    let tier = 0;

    try {
      const resolved = await resolveClientAnswer({
        ...field,
        label: rawLabel,
        required: true,
      }, profile, {
        url: jobUrl,
        tenant: schema.tenant,
        company: schema.company,
        forceLlm: false,
      });

      if (resolved?.answer != null) {
        ansVal = String(resolved.answer);
        rawSource = String(resolved.source || '').toLowerCase();
        if (rawSource.includes('supabase') || rawSource.includes('sensitive_safe') || rawSource.includes('minimum_age')) {
          sourceTag = 'Tier 1: Supabase DB';
          tier = 1;
          rawSource = 'supabase';
        } else if (rawSource.includes('resume') || rawSource.includes('experience')) {
          sourceTag = 'Tier 2: Resume Extraction';
          tier = 2;
          rawSource = 'resume';
        } else if (rawSource.includes('applywizz') || rawSource.includes('api')) {
          sourceTag = 'Tier 3: CRM API';
          tier = 3;
          rawSource = 'api';
        } else if (rawSource.includes('llm') || rawSource.includes('ai') || rawSource.includes('openrouter')) {
          sourceTag = 'Tier 4: AI / LLM';
          tier = 4;
          rawSource = 'llm';
          if (awlId && ansVal) {
            recordNovelQABankAnswer({
              applywizzId: awlId,
              question: rawLabel,
              questionNormalized: norm,
              answer: ansVal,
              fieldType: field.field_type || 'text',
              source: 'llm',
            }).catch(() => {});
          }
        } else {
          sourceTag = 'Tier 3: CRM API';
          tier = 3;
          rawSource = 'api';
        }
      }
    } catch {}

    const isRequired = Boolean(field.is_required || field.required);
    const isAnswered = Boolean(ansVal && ansVal.trim().length > 0);
    if (!isAnswered && isRequired) {
      unansweredCount++;
      unansweredQuestions.push({
        question: rawLabel,
        field_type: field.field_type || 'text',
        step: field.step || 'Application Questions',
        options: Array.isArray(field.options) ? field.options : [],
        is_required: true,
        reason: 'missing_required_answer',
      });
    }

    if (isAnswered) {
      answersMap[norm] = ansVal;
    }

    structuredAnswers.push({
      question: rawLabel,
      question_normalized: norm,
      answer: ansVal || '',
      tier,
      source: sourceTag,
      raw_source: rawSource,
      field_type: field.field_type || 'text',
      options: field.options || [],
      step: field.step || 'Application',
      is_required: isRequired,
      is_answered: isAnswered,
    });
  }

  const isFullyAnswered = unansweredCount === 0;
  const status = isFullyAnswered ? 'ready_for_review' : 'needs_answers';

  return {
    answersMap,
    structuredAnswers,
    unansweredQuestions,
    isFullyAnswered,
    unansweredCount,
    status,
  };
}

/**
 * Pre-resolve all required answers for a candidate and return as a single JSON object.
 */
export async function preResolveClientAnswersMap({ jobUrl, schema, profile = {} }) {
  if (!schema?.fields_schema?.length) return {};
  const detailed = await preResolveClientAnswersDetailed({ jobUrl, schema, profile });
  return detailed.answersMap;
}

/**
 * Pre-resolve answers for ALL remaining 'pending' tasks sharing the same job URL.
 * Called immediately after Client 1 saves the form schema (first-scan only).
 */
export async function bulkPreResolveForJobUrl({ jobUrl, schema, loadProfileFn, allowedCandidateIds = null, tasks = null }) {
  if (!jobUrl || !schema?.fields_schema?.length || typeof loadProfileFn !== 'function') return;

  let pendingTasks = [];
  if (Array.isArray(tasks) && tasks.length > 0) {
    pendingTasks = tasks;
  } else {
    try {
      pendingTasks = await getPendingQueueTasksForUrl(jobUrl, allowedCandidateIds);
    } catch (err) {
    console.log(`  ⚠️  bulkPreResolveForJobUrl: Could not fetch pending tasks — ${err.message}`);
    return;
    }
  }

  if (!pendingTasks.length) {
    console.log(`  ℹ️  bulkPreResolveForJobUrl: No other pending tasks found for this URL.`);
    return;
  }

  console.log(`\n  🔄 Bulk pre-resolving across 4-tier engine for ${pendingTasks.length} pending task(s)...`);

  for (const row of pendingTasks) {
    const awlId = row.applywizz_id;
    try {
      const profile = await loadProfileFn(awlId);
      const detailed = await preResolveClientAnswersDetailed({ jobUrl, schema, profile });
      const count = Object.keys(detailed.answersMap).length;

      // Update resolved_answers table (with zero-incomplete check)
      await saveResolvedAnswers({
        applywizzId: awlId,
        scannedJobId: schema.id || null,
        jobUrl,
        company: schema.company || row.company || 'Workday',
        roleTitle: schema.role_title || row.role_title || 'Application',
        resolvedAnswersJson: detailed.structuredAnswers,
        isFullyAnswered: detailed.isFullyAnswered,
        unansweredCount: detailed.unansweredCount,
        status: detailed.isFullyAnswered ? 'ready_for_review' : 'needs_answers',
      }).catch(() => {});

      // Keep batch_job_queue synchronized
      await updateQueueTaskStatus(row.id, {
        status: detailed.isFullyAnswered ? 'pre_resolved' : 'pending',
        preResolvedAnswers: detailed.answersMap,
      });

      console.log(`  ✅ [${awlId}] Pre-resolved ${count}/${detailed.structuredAnswers.length} fields (${detailed.isFullyAnswered ? '100% COMPLETE' : detailed.unansweredCount + ' UNANSWERED'}). Status: ${detailed.isFullyAnswered ? 'ready_for_review' : 'incomplete'}`);
    } catch (err) {
      console.log(`  ⚠️  Failed to pre-resolve for ${awlId}: ${err.message}`);
    }
  }

  console.log(`  ✅ Bulk 4-tier pre-resolution complete for ${pendingTasks.length} queued task(s).\n`);
}

