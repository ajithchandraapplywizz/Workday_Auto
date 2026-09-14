/**
 * profileBootstrap.mjs — Load and analyse full client context once per apply run.
 * YAML → Apply Wizz API → qa-store index → one-time LLM profile brief;
 * used before any Playwright fill loop.
 */

import { hydrateProfileFromApplyWizz } from './applyWizzClient.mjs';
import { createQAStore } from './qaStore.mjs';
import { getResumePathForApply } from './resumeParser.mjs';
import { analyzeClientProfileOnce } from './openRouterLlm.mjs';

/**
 * @param {object} profile — mutable profile from loadProfile()
 * @param {object} plan — apply plan (url, company, resume)
 */
export async function bootstrapClientContext(profile = {}, plan = {}) {
  console.log('\n  📋 Stage 1 — Analysing client profile (local YAML + Apply Wizz + Q&A cache)...');

  if (!profile._applyWizzHydrated) {
    await hydrateProfileFromApplyWizz(profile);
  } else {
    console.log('  ✓ Apply Wizz client already loaded (skipped duplicate API call)');
  }

  if (plan?.url) profile._jobUrl = plan.url;
  if (plan?.company) profile._company = plan.company;

  const store = createQAStore();
  try {
    await store.load?.();
  } catch {
    /* qa-store optional */
  }

  profile.qa_answers = profile.qa_answers || {};
  profile._filledValues = profile._filledValues || {};
  if (!(profile._dynamicSkipNorms instanceof Set)) {
    profile._dynamicSkipNorms = new Set(profile._dynamicSkipNorms || []);
  }
  profile._dynamicRetryNorms = profile._dynamicRetryNorms || new Map();

  profile._resumePath = profile._resumePath || (await getResumePathForApply(profile, plan).catch(() => null));

  // One LLM pass over the full client profile — reused when top answer tiers miss.
  await analyzeClientProfileOnce(profile, { resumePath: profile._resumePath });

  const personal = profile.personal || {};
  const qaKeys = Object.keys(profile.qa_answers).length;
  const apiKeys = Object.keys(profile._applyWizzQa || {}).length;
  const exp = profile.experience || {};
  const edu = profile.education || {};

  console.log(`  ✓ Identity: ${[personal.first_name, personal.last_name].filter(Boolean).join(' ') || '(name in profile.yml)'}`);
  console.log(`  ✓ Contact: ${personal.email || '—'} | ${personal.phone || '—'} | ${personal.city || '—'}`);
  console.log(`  ✓ Work: ${exp.current_title || '—'} @ ${exp.current_company || '—'} | ${exp.years || profile._applyWizzQa?.['years of experience'] || '—'} yrs`);
  console.log(`  ✓ Education: ${edu.university || 'Other'} / ${edu.degree || "Bachelor's"} / ${edu.major || edu.field_of_study_hierarchy?.[0] || 'Computer Science'}`);
  console.log(`  ✓ Answer index: ${qaKeys} profile Q&A, ${apiKeys} Apply Wizz keys, EEO/work_auth loaded`);
  if (profile._resumePath) {
    console.log(`  ✓ Resume: ${profile._resumePath}`);
  }
  console.log('  ✓ Resolution order: Apply Wizz → YAML → profile/resume → LLM+Playwright labels (auto, no terminal)\n');

  profile._clientBootstrapped = true;
  return profile;
}
