/**
 * One-shot QA report: Workday questions seen in live runs vs Apply Wizz API ONLY.
 * Excludes YAML profile / tenant-overrides.
 *
 * Usage: node scripts/applywizz-api-gap-report.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch { /* optional */ }

const id = process.env.APPLYWIZZ_ID || 'AWL-34133';
const url = process.env.APPLYWIZZ_CLIENT_URL
  || process.env.APPLYWIZZ_API_URL
  || `https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(id)}`;

console.log(`Fetching Apply Wizz API: ${url}`);
const res = await fetch(url, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(20000),
});
if (!res.ok) throw new Error(`Apply Wizz API ${res.status}`);
const api = await res.json();
writeFileSync('data/_applywizz-client-snapshot.json', JSON.stringify(api, null, 2));

const {
  buildApplyWizzQaIndex,
  mapApplyWizzToProfile,
  lookupApplyWizzAnswer,
} = await import('../lib/applyWizzClient.mjs');
const { normalizeLabel } = await import('../lib/qaStore.mjs');
const { resolveByConcept, matchAnswerConcept } = await import('../lib/answerConcepts.mjs');

const client = api.client || {};
const info = api.additional_information || {};
const qaIndex = buildApplyWizzQaIndex(client, info);
const overlay = mapApplyWizzToProfile(client, info);
const profile = { ...overlay, _applyWizzQa: qaIndex, qa_answers: {} };

/** @type {Map<string, { label: string, answers: Set<string>, sources: Set<string> }>} */
const seen = new Map();

function addQ(label, answer, source) {
  const raw = String(label || '').trim();
  if (!raw || raw.length < 3) return;
  const norm = normalizeLabel(raw);
  if (!norm || norm.length < 3) return;
  if (/indicates a required field|application questions \d|save and continue|password|beecatcher|select one|type to add/i.test(raw)) {
    return;
  }
  if (!seen.has(norm)) {
    seen.set(norm, { label: raw, answers: new Set(), sources: new Set() });
  }
  const e = seen.get(norm);
  if (answer != null && String(answer).trim() !== '') {
    e.answers.add(String(answer).trim().slice(0, 220));
  }
  e.sources.add(source);
}

try {
  const qa = JSON.parse(readFileSync('data/qa-store.json', 'utf8'));
  for (const [k, v] of Object.entries(qa)) {
    const label = typeof v === 'object' && v ? (v.raw_label || k) : k;
    const clean = String(label).includes('::') ? String(label).split('::').slice(1).join('::') : label;
    const keyClean = String(k).includes('::') ? String(k).split('::').slice(1).join('::') : k;
    addQ(clean || keyClean, typeof v === 'object' && v ? v.answer : v, 'qa-store');
  }
} catch (e) {
  console.error('qa-store load:', e.message);
}

try {
  const llm = JSON.parse(readFileSync('data/llm-qa-store.json', 'utf8'));
  for (const [k, v] of Object.entries(llm.answers || {})) {
    if (!v || typeof v !== 'object') continue;
    addQ(v.label || k, v.answer, 'llm-qa-store');
  }
} catch (e) {
  console.error('llm-qa-store load:', e.message);
}

const scanDir = 'data/wd5-scans';
if (existsSync(scanDir)) {
  for (const f of readdirSync(scanDir).filter((x) => x.endsWith('.json'))) {
    try {
      const doc = JSON.parse(readFileSync(resolve(scanDir, f), 'utf8'));
      const walk = (arr) => {
        for (const q of arr || []) {
          addQ(q.label || q.question || q.name || '', q.answer || '', 'wd5-scan');
        }
      };
      walk(doc.questions);
      walk(doc.fields);
      walk(doc.scanned_questions);
      if (doc.byStep) {
        for (const arr of Object.values(doc.byStep)) walk(arr);
      }
      if (doc.steps) {
        for (const s of Object.values(doc.steps)) {
          walk(s.questions || s.fields || (Array.isArray(s) ? s : []));
        }
      }
    } catch { /* ignore bad scan files */ }
  }
}

function apiCanAnswer(label) {
  const hit = lookupApplyWizzAnswer(label, profile, { threshold: 0.55 });
  if (hit?.answer) {
    return {
      covered: true,
      via: hit.source,
      answer: hit.answer,
      matchedKey: hit.matchedKey || '',
    };
  }
  const concept = resolveByConcept(label, profile);
  if (concept?.answer) {
    return {
      covered: true,
      via: concept.source,
      answer: concept.answer,
      matchedKey: concept.concept,
    };
  }
  return { covered: false };
}

function category(q) {
  const t = String(q || '').toLowerCase();
  if (/authorized|sponsor|visa|citizen|work in|i-9|eligible to work/i.test(t)) {
    return 'Work authorization / visa';
  }
  if (/gender|sex|race|ethnic|hispanic|veteran|disability|eeo|voluntary/i.test(t)) {
    return 'EEO / voluntary disclosure';
  }
  if (/salary|compensation|pay|wage/i.test(t)) return 'Compensation';
  if (/school|university|degree|education|graduat|gpa|field of study|major/i.test(t)) {
    return 'Education';
  }
  if (/job title|company|employer|experience|skills|role description|currently work/i.test(t)) {
    return 'Experience / skills';
  }
  if (/relocat|commute|remote|hybrid|office|location|city|state|address|phone|email|name|linkedin/i.test(t)) {
    return 'Personal / location';
  }
  if (/start|available|notice|schedule|full-?time|part-?time|shift|work type/i.test(t)) {
    return 'Availability / schedule';
  }
  if (/background|drug|felony|criminal|convict|misconduct|discipline|relative|previously (worked|employed)|prior worker|conflict/i.test(t)) {
    return 'Background / compliance';
  }
  if (/how did you hear|source|referral/i.test(t)) return 'Source / referral';
  if (/consent|terms|agree|certify|privacy|acknowledge/i.test(t)) {
    return 'Consent / acknowledgements';
  }
  return 'Other application-specific';
}

const covered = [];
const missing = [];
for (const [, entry] of [...seen.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
  const res = apiCanAnswer(entry.label);
  const row = {
    question: entry.label,
    answers_seen_in_runs: [...entry.answers],
    sources: [...entry.sources],
    api_status: res.covered ? 'COVERED_BY_APPLY_WIZZ_API' : 'NOT_IN_APPLY_WIZZ_API',
    api_answer: res.covered ? res.answer : null,
    api_match_via: res.covered ? res.via : null,
    api_matched_key: res.covered ? (res.matchedKey || null) : null,
    concept_bucket: matchAnswerConcept(entry.label)?.id || null,
    category: category(entry.label),
  };
  (res.covered ? covered : missing).push(row);
}

const missingByCat = {};
for (const m of missing) {
  (missingByCat[m.category] ||= []).push(m);
}

const fieldRecs = {
  'Work authorization / visa': 'eligible_to_work_in_us, require_future_sponsorship, visa_type, work_authorization_details',
  'EEO / voluntary disclosure': 'gender, is_hispanic_latino, race_ethnicity, veteran_status, disability_status',
  'Compensation': 'desired_salary_numeric, salary_currency, salary_range',
  'Education': 'school_name, degree, field_of_study, graduation_year, gpa, education_history[]',
  'Experience / skills': 'work_history[], skills[], years_of_experience, current_title, current_company',
  'Personal / location': 'full_address, city, state, postal_code, phone, linkedin, willing_to_relocate',
  'Availability / schedule': 'desired_start_date, notice_period, work_types[], shift_preference',
  'Background / compliance': 'background_check_consent, drug_screen_consent, felony_conviction, prior_employer_flags, relative_at_company',
  'Source / referral': 'how_heard_default (e.g. LinkedIn)',
  'Consent / acknowledgements': 'usually static Yes — optional in API',
  'Other application-specific': 'tenant-specific freeform Q&A map (question → answer)',
};

const report = {
  generated_at: new Date().toISOString(),
  purpose: 'QA one-shot report: Workday questions from continuous auto-apply vs Apply Wizz API ONLY (YAML excluded)',
  scope: {
    api_url: url,
    applywizz_id: id,
    compared_against: [
      'data/qa-store.json',
      'data/llm-qa-store.json',
      'data/wd5-scans/*.json',
    ],
    excluded: [
      'config/profile.yml',
      'config/tenant-overrides/*.yml',
    ],
  },
  client_from_api: {
    applywizz_id: client.applywizz_id,
    full_name: client.full_name,
    personal_email: client.personal_email || client.company_email,
    company_email: client.company_email,
    salary_range: client.salary_range,
    sponsorship: client.sponsorship,
    visa_type: client.visa_type,
    location_preferences: client.location_preferences,
    job_role_preferences: client.job_role_preferences,
  },
  additional_information_from_api: info,
  summary: {
    workday_unique_questions_seen: seen.size,
    covered_by_apply_wizz_api: covered.length,
    missing_from_apply_wizz_api: missing.length,
    coverage_pct: seen.size ? Math.round((covered.length / seen.size) * 1000) / 10 : 0,
    apply_wizz_derived_qa_keys: Object.keys(qaIndex).length,
    missing_by_category_counts: Object.fromEntries(
      Object.entries(missingByCat).map(([k, v]) => [k, v.length]),
    ),
  },
  apply_wizz_derived_answers_we_can_fetch_today: qaIndex,
  missing_from_apply_wizz_api_by_category: missingByCat,
  missing_from_apply_wizz_api_flat: missing,
  covered_by_apply_wizz_api: covered,
  recommended_api_fields_to_request: Object.entries(missingByCat)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, rows]) => ({
      category: cat,
      missing_count: rows.length,
      suggested_api_fields: fieldRecs[cat] || 'custom_qa_map',
    })),
};

writeFileSync('data/APPLYWIZZ-API-GAP-REPORT.json', JSON.stringify(report, null, 2));

let md = '';
md += '# Apply Wizz API Gap Report (QA)\n\n';
md += `Generated: ${report.generated_at}\n\n`;
md += '## Scope\n\n';
md += '- Answer source of truth: **Apply Wizz API only** (YAML excluded)\n';
md += `- Client ID: **${id}** — ${client.full_name || 'n/a'}\n`;
md += '- Questions compared from live agent runs: `qa-store.json`, `llm-qa-store.json`, `wd5-scans`\n\n';
md += '## Executive summary\n\n';
md += '| Metric | Value |\n|---|---:|\n';
md += `| Unique Workday questions seen | ${report.summary.workday_unique_questions_seen} |\n`;
md += `| Covered by Apply Wizz API | ${report.summary.covered_by_apply_wizz_api} |\n`;
md += `| **Missing from Apply Wizz API** | **${report.summary.missing_from_apply_wizz_api}** |\n`;
md += `| Coverage | ${report.summary.coverage_pct}% |\n`;
md += `| API-derived Q&A keys available today | ${report.summary.apply_wizz_derived_qa_keys} |\n\n`;

md += '## Apply Wizz API — answers we CAN fetch today\n\n';
md += '### Client payload\n\n```json\n';
md += `${JSON.stringify(report.client_from_api, null, 2)}\n`;
md += '```\n\n### additional_information\n\n```json\n';
md += `${JSON.stringify(info, null, 2)}\n`;
md += '```\n\n### Derived bot answer keys (from API mapping)\n\n';
for (const [k, v] of Object.entries(qaIndex)) {
  md += `- **${k}** → ${v}\n`;
}
md += '\n';

md += '## Gaps — Workday questions NOT available from Apply Wizz API\n\n';
md += 'These need another API / CRM fields / answer bank for future auto-fetch.\n\n';
md += '### Missing by category\n\n';
md += '| Category | Missing count |\n|---|---:|\n';
for (const [cat, rows] of Object.entries(missingByCat).sort((a, b) => b[1].length - a[1].length)) {
  md += `| ${cat} | ${rows.length} |\n`;
}
md += '\n';

for (const [cat, rows] of Object.entries(missingByCat).sort((a, b) => b[1].length - a[1].length)) {
  md += `### ${cat} (${rows.length})\n\n`;
  md += '| # | Workday question (as seen in runs) | Answer used in runs (NOT from API) |\n|---:|---|---|\n';
  rows.forEach((r, i) => {
    const ans = (r.answers_seen_in_runs.join(' | ') || '_(no stored answer)_').replace(/\|/g, '\\|');
    const q = r.question.replace(/\|/g, '\\|');
    md += `| ${i + 1} | ${q} | ${ans} |\n`;
  });
  md += '\n';
}

md += '## Recommended fields for next API\n\n';
for (const rec of report.recommended_api_fields_to_request) {
  md += `- **${rec.category}** (${rec.missing_count} gaps): \`${rec.suggested_api_fields}\`\n`;
}
md += '\n## Deliverables\n\n';
md += '- `data/APPLYWIZZ-API-GAP-REPORT.md` (this file)\n';
md += '- `data/APPLYWIZZ-API-GAP-REPORT.json` (machine-readable)\n';
md += '- `data/_applywizz-client-snapshot.json` (raw API response)\n';

writeFileSync('data/APPLYWIZZ-API-GAP-REPORT.md', md);
console.log(JSON.stringify(report.summary, null, 2));
console.log('Wrote data/APPLYWIZZ-API-GAP-REPORT.md and data/APPLYWIZZ-API-GAP-REPORT.json');
