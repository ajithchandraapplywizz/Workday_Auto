/**
 * Smoke-test answer priority without a browser:
 * Apply Wizz / YAML → resume → concept synonyms → optional skip → LLM only if needed.
 *
 * Usage: node scripts/test-answer-priority.mjs
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Minimal .env loader before dynamic imports
try {
  const envText = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch { /* optional */ }

const { loadProfile, resolveField, mapLabelToProfileValue } = await import('../lib/planner.mjs');
const { createQAStore } = await import('../lib/qaStore.mjs');
const { resolveByConcept } = await import('../lib/answerConcepts.mjs');
const { shouldSkipOptionalFill, isMandatoryField } = await import('../lib/scanFieldFilter.mjs');
const { resolveUnknownWithLlm } = await import('../lib/openRouterLlm.mjs');

const REQUIRED = { required: true, hasRequiredMarker: true };
const OPTIONAL = { required: false };

async function main() {
  console.log('=== Answer priority smoke test ===\n');
  const profile = await loadProfile();
  const store = createQAStore();

  console.log(`Apply Wizz hydrated: ${Boolean(profile._applyWizzHydrated)}`);
  console.log(`Apply Wizz QA keys: ${Object.keys(profile._applyWizzQa || {}).length}`);
  console.log(`Name: ${profile.personal?.first_name || ''} ${profile.personal?.last_name || ''}`);
  console.log(`Education to_year: ${profile.education?.to_year || ''}`);
  console.log(`Degree: ${profile.education?.degree || ''}`);
  console.log(`Compensation: ${profile.compensation || ''}\n`);

  const synonymCases = [
    'Graduation year',
    'When did you graduate?',
    'Expected graduation year',
    'Year of graduation',
    'Education end year',
    'What is your desired compensation?',
    'Salary expectation',
    'Field of Study',
    'What did you study?',
    'Highest level of education',
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require visa sponsorship?',
  ];

  console.log('--- Synonym / concept resolve (Tier 1 Apply Wizz / profile) ---');
  let conceptPass = 0;
  for (const label of synonymCases) {
    const concept = resolveByConcept(label, profile);
    const semantic = await resolveField({ label, ...REQUIRED }, profile, store, { skipPrompt: true });
    const ok = Boolean(concept?.answer || semantic);
    if (ok) conceptPass++;
    console.log(
      `${ok ? '✓' : '✗'} "${label}" → ${JSON.stringify(concept?.answer || semantic || null)}`
      + (concept ? ` [${concept.source}/${concept.concept}]` : ''),
    );
  }
  console.log(`Concept/resolve: ${conceptPass}/${synonymCases.length}\n`);

  console.log('--- Required-only filter ---');
  const optionalLabels = [
    { label: 'Cover Letter', field: OPTIONAL },
    { label: 'LinkedIn URL', field: OPTIONAL },
    { label: 'Role Description', field: OPTIONAL },
    { label: 'Middle Name', field: OPTIONAL },
    { label: 'Preferred Name', field: OPTIONAL },
    { label: 'Are you authorized to work in the US? *', field: REQUIRED },
  ];
  let filterPass = 0;
  for (const { label, field } of optionalLabels) {
    const skip = shouldSkipOptionalFill(label, field, profile);
    const shouldSkip = /cover letter|linkedin url|role description|middle name|preferred name/i.test(label);
    const ok = shouldSkip ? skip === true : skip === false;
    if (ok) filterPass++;
    console.log(`${ok ? '✓' : '✗'} skip("${label}")=${skip} (expect skip=${shouldSkip})`);
  }
  console.log(`Filter: ${filterPass}/${optionalLabels.length}\n`);

  console.log('--- Optional field resolveField must return null ---');
  const optAns = await resolveField(
    { label: 'Cover Letter (optional)', required: false },
    profile,
    store,
    { skipPrompt: true },
  );
  console.log(`${optAns == null ? '✓' : '✗'} Cover Letter → ${JSON.stringify(optAns)}\n`);

  console.log('--- Profile map for graduation aliases ---');
  for (const label of ['Graduation year', 'When did you graduate?', 'Expected graduation']) {
    const mapped = mapLabelToProfileValue(label, profile);
    console.log(`map("${label}") → ${JSON.stringify(mapped)}`);
  }

  const novel = 'Briefly describe why you are a good fit for this software engineering role';
  console.log(`\n--- Tier 3 LLM (only if required & unknown) ---`);
  const llmAns = await resolveUnknownWithLlm(novel, { ...REQUIRED, fieldType: 'textarea' }, {
    profile,
    company: 'test',
    tenant: 'test',
  });
  console.log(`LLM novel → ${llmAns ? String(llmAns).slice(0, 160) : null}`);

  const failed = conceptPass < synonymCases.length - 2 || filterPass < optionalLabels.length || optAns != null;
  console.log(`\n=== ${failed ? 'NEEDS ATTENTION' : 'PASS'} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
