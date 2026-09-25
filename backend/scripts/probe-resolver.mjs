/**
 * scripts/probe-resolver.mjs
 *
 * Headless offline test probe for the 4-tier answer resolver.
 * Tests Tier 1 (Supabase), Tier 2 (CRM API), Tier 3 (Resume), and Tier 4 (LLM)
 * in strictly read-only / dry-run mode (zero Supabase writes, zero in-memory mutations).
 *
 * Runs across real labels pulled from client_questions + spelling & wording variants,
 * and prints a clean formatted table:
 *   [Label | Tier | Source | Answer | Rejection Reason]
 *
 * Usage:
 *   node scripts/probe-resolver.mjs [clientId] [tenant]
 */

import { resolveClientAnswer } from '../lib/clientAnswer.mjs';
import { hydrateProfileFromApplyWizz } from '../lib/applyWizzClient.mjs';
import { isSupabaseConfigured, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();

const clientId = process.argv[2] || process.env.APPLYWIZZ_ID || 'AWL-26828';
const tenant = process.argv[3] || 'nvidia';

console.log('='.repeat(80));
console.log(`PROBE RESOLVER — PHASE A.2 (Offline Read-Only Dry-Run Mode)`);
console.log(`  Client ID : ${clientId}`);
console.log(`  Tenant    : ${tenant}`);
console.log('='.repeat(80));

// ─── 1. RLS Check (Anon key vs Service-role key) ───────────────────────────
async function checkSupabaseRls(targetClientId) {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

  console.log('\n--- 1. Supabase RLS & Key Audit ---');
  if (!url) {
    console.log('  ⚠️  SUPABASE_URL not configured in .env');
    return [];
  }

  let clientRows = [];
  try {
    const res = await httpsJsonWithRetry({
      url: `${url}/rest/v1/client_questions?applywizz_id=eq.${encodeURIComponent(targetClientId)}&select=question_raw,question_normalized,answer,options,field_type&order=updated_at.desc&limit=100`,
      method: 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      timeoutMs: 15000,
    }, { attempts: 1, label: 'ServiceRoleFetch' });
    if (res.ok) {
      clientRows = res.json() || [];
      console.log(`  🔑 Service-role key: HTTP ${res.status} | Rows retrieved for ${targetClientId}: ${clientRows.length}`);
    } else {
      console.log(`  🔑 Service-role key: HTTP ${res.status} error: ${res.text?.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`  🔑 Service-role key query failed: ${err.message}`);
  }

  if (anonKey) {
    try {
      const resAnon = await httpsJsonWithRetry({
        url: `${url}/rest/v1/client_questions?applywizz_id=eq.${encodeURIComponent(targetClientId)}&select=id&limit=10`,
        method: 'GET',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        timeoutMs: 10000,
      }, { attempts: 1, label: 'AnonKeyCheck' });
      if (resAnon.ok) {
        const anonRows = resAnon.json() || [];
        console.log(`  🔓 Anon key        : HTTP ${resAnon.status} | Rows retrieved: ${anonRows.length}`);
      }
    } catch (err) {
      console.log(`  🔓 Anon key query failed: ${err.message}`);
    }
  } else {
    console.log('  ℹ️  SUPABASE_ANON_KEY is not defined in .env (all server queries use service role key)');
  }

  return clientRows;
}

// ─── 2. Run Comprehensive Probe Suite ──────────────────────────────────────
async function runProbe() {
  const dbRows = await checkSupabaseRls(clientId);

  const profile = {
    _applyWizzId: clientId,
    _tenant: tenant,
    _persistAnswers: false, // strictly dry-run
  };

  console.log('\n--- 2. Hydrating Profile (Dry-Run / Read-Only) ---');
  await hydrateProfileFromApplyWizz(profile, { dryRun: true });
  console.log(`  Profile hydrated: ${profile.personal?.first_name || ''} ${profile.personal?.last_name || ''}`);
  console.log(`  Supabase cached questions: ${Object.keys(profile._supabaseQa || {}).length}`);
  console.log(`  ApplyWizz cached questions: ${Object.keys(profile._applyWizzQa || {}).length}`);

  // Construct a realistic test suite of 35-45 questions:
  // - Real questions from client_questions
  // - Spelling variants (UK vs US)
  // - Punctuation & phrasing variants
  // - Work authorization, EEO, sensitive compliance
  // - Technical skills & experience questions
  const testSuite = [];

  // Seed sample from client_questions (first 20 distinct raw questions)
  const seenRaw = new Set();
  for (const row of dbRows) {
    const raw = String(row.question_raw || row.question_normalized).trim();
    if (!raw || seenRaw.has(raw.toLowerCase()) || raw.length < 5) continue;
    seenRaw.add(raw.toLowerCase());
    testSuite.push({
      label: raw,
      options: Array.isArray(row.options) && row.options.length ? row.options : ['Yes', 'No'],
      category: 'db_seed',
    });
    if (testSuite.length >= 20) break;
  }

  // Add deliberate variants & edge cases
  const variantCases = [
    // Work auth & spelling variants
    { label: 'Are you legally authorized to work in the United States?', options: ['Yes', 'No'], category: 'work_auth' },
    { label: 'Are you authorised to work in the US *', options: ['Yes', 'No'], category: 'work_auth_spelling' },
    { label: 'Are you legally eligible to work within the United States without restriction?', options: ['Yes', 'No'], category: 'work_auth_variant' },
    { label: 'Will you now or in the future require visa sponsorship?', options: ['Yes', 'No'], category: 'sponsorship' },
    { label: 'Will you require sponsorship for an employment visa status (e.g. H-1B, TN)?', options: ['Yes', 'No'], category: 'sponsorship_variant' },
    
    // EEO & Sensitive
    { label: 'What is your gender?', options: ['Male', 'Female', 'Decline to self-identify'], category: 'eeo_gender' },
    { label: 'Please select your race / ethnicity', options: ['Asian', 'White', 'Black or African American', 'Decline to identify'], category: 'eeo_race' },
    { label: 'Are you Hispanic or Latino?', options: ['Yes', 'No', 'Decline to self-identify'], category: 'eeo_hispanic' },
    { label: 'Veteran Status: Are you a protected veteran?', options: ['I am not a protected veteran', 'I identify as a protected veteran', 'I choose not to disclose'], category: 'eeo_veteran' },
    { label: 'Have you ever been disciplined, suspended, or terminated from employment?', options: ['Yes', 'No'], category: 'sensitive_adverse' },
    { label: 'Have you ever been employed by or related to an employee of this company?', options: ['Yes', 'No'], category: 'sensitive_prior' },

    // Education & Identity Facts
    { label: 'What is your highest level of education completed?', options: ["Bachelor's Degree", "Master's Degree", "Doctorate", "Other"], category: 'education' },
    { label: 'University or College Name', options: [], category: 'university' },
    { label: 'Degree / Major', options: [], category: 'degree' },
    { label: 'Legal First Name', options: [], category: 'identity' },
    { label: 'Primary Mobile Phone Number', options: [], category: 'identity' },

    // Experience & Skills
    { label: 'Do you have at least 3 years of experience with distributed backend systems?', options: ['Yes', 'No'], category: 'tech_experience' },
    { label: 'Do you have experience with Python programming?', options: ['Yes', 'No'], category: 'tech_experience' },
    { label: 'Years of experience with React / Frontend frameworks', options: ['0-1 year', '1-3 years', '3-5 years', '5+ years'], category: 'tech_years' },
    // Four Assumed Fields from Video Analysis
    { label: 'Desired Salary / Expected Annual Compensation', options: [], category: 'assumed_salary' },
    { label: 'When are you available to start?', options: [], category: 'assumed_start_date' },
    { label: 'Do you have any relatives that are currently employed by our company?', options: ['Yes', 'No'], category: 'assumed_relatives' },
    { label: 'Do you possess a high school diploma or equivalent?', options: ['Yes', 'No'], category: 'assumed_diploma' },
  ];

  for (const v of variantCases) {
    if (!testSuite.some(t => t.label.toLowerCase() === v.label.toLowerCase())) {
      testSuite.push(v);
    }
  }

  console.log(`\n--- 3. Running Resolver Probes (${testSuite.length} Test Cases) ---`);

  const results = [];

  for (const c of testSuite) {
    const res = await resolveClientAnswer(
      { label: c.label, options: c.options, fieldType: c.options.length ? 'select' : 'text', required: true },
      profile,
      {
        tenant,
        options: c.options,
        fieldType: c.options.length ? 'select' : 'text',
        dryRun: true, // No Supabase upserts, no cache writes
        forceLlm: false,
      }
    );

    let tier = 'Unresolved';
    let source = res?.source || 'none';
    let answer = res?.answer || 'NULL';

    if (source.startsWith('supabase_') || source.startsWith('sensitive_safe') || source.startsWith('minimum_age')) {
      tier = 'Tier 1 (Supabase / Safe)';
    } else if (source.startsWith('applywizz')) {
      tier = 'Tier 2 (CRM API)';
    } else if (source.startsWith('experience') || source.startsWith('resume')) {
      tier = 'Tier 3 (Resume)';
    } else if (source.startsWith('llm')) {
      tier = 'Tier 4 (LLM)';
    }

    results.push({
      label: c.label.length > 50 ? c.label.slice(0, 47) + '...' : c.label,
      tier,
      source,
      answer: String(answer).length > 35 ? String(answer).slice(0, 32) + '...' : String(answer),
      rejectionReason: res ? 'None (Matched)' : 'Blocked / Unanswered',
    });
  }

  console.log('\n--- 4. Final Probe Results Table ---');
  console.table(results);

  console.log('\n' + '='.repeat(80));
  console.log('Probe completed. Check runs/ directory for detailed JSONL trace.');
  console.log('='.repeat(80));
}

runProbe().catch(console.error);
