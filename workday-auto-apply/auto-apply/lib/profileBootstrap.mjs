/**
 * profileBootstrap.mjs — Load and analyse full client context once per apply run.
 * Apply Wizz API → resume parse → one-time LLM profile brief;
 * used before any Playwright fill loop.
 */

import { hydrateProfileFromApplyWizz } from './applyWizzClient.mjs';
import { getResumePathForApply } from './resumeParser.mjs';
import { analyzeClientProfileOnce } from './openRouterLlm.mjs';
import { ensureWorkdayContactFromClient, mergeResumeContactIntoProfile } from './clientContact.mjs';
import { normalizePersonalNames } from './personName.mjs';
import { applyApiOnlyProfileGuards } from './apiOnlyProfile.mjs';
import { hydrateSupabaseAnswers } from './supabaseClient.mjs';

/**
 * @param {object} profile — mutable profile from loadProfile()
 * @param {object} plan — apply plan (url, company, resume)
 */
export async function bootstrapClientContext(profile = {}, plan = {}) {
  console.log('\n  📋 Stage 1 — Analysing client profile (Apply Wizz API + Supabase + resume)...');

  if (!profile._applyWizzHydrated) {
    await hydrateProfileFromApplyWizz(profile);
  } else {
    console.log('  ✓ Apply Wizz client already loaded (skipped duplicate API call)');
  }
  if (!profile._supabaseHydrated) {
    await hydrateSupabaseAnswers(profile);
  }
  await ensureWorkdayContactFromClient(profile);
  if (profile.personal) profile.personal = normalizePersonalNames(profile.personal);
  applyApiOnlyProfileGuards(profile);

  if (plan?.url) profile._jobUrl = plan.url;
  if (plan?.company) profile._company = plan.company;

  profile.qa_answers = profile.qa_answers || {};
  profile._filledValues = profile._filledValues || {};
  if (!(profile._dynamicSkipNorms instanceof Set)) {
    profile._dynamicSkipNorms = new Set(profile._dynamicSkipNorms || []);
  }
  profile._dynamicRetryNorms = profile._dynamicRetryNorms || new Map();

  profile._resumePath = profile._resumePath || (await getResumePathForApply(profile, plan).catch(() => null));
  if (profile._resumePath && !profile._resumeText) {
    try {
      const { loadResumeText } = await import('./resumeParser.mjs');
      profile._resumeText = await loadResumeText(profile._resumePath);
    } catch { /* optional */ }
  }
  mergeResumeContactIntoProfile(profile);

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
  const supabaseKeys = Object.keys(profile._supabaseQa || {}).length;
  console.log(`  ✓ Answer index: ${supabaseKeys} Supabase keys (Tier 1), ${apiKeys} Apply Wizz keys (Tier 2), resume parsing (Tier 3), LLM fallback (Tier 4)`);
  if (profile._resumePath) {
    console.log(`  ✓ Resume: ${profile._resumePath}`);
  }
  const order = 'Tier 1 (Supabase) → Tier 2 (ApplyWizz API) → Tier 3 (Resume Parsing) → Tier 4 (LLM + DOM live options)';
  console.log(`  ✓ Mandatory resolution: ${order}\n`);

  profile._clientBootstrapped = true;
  return profile;
}
