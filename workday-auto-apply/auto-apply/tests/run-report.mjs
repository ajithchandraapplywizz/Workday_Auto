#!/usr/bin/env node
/**
 * Run the agent test suite and write an honest metrics report.
 * Does not open live Workday URLs and does not submit applications.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMetrics, FAILURE } from './helpers/metrics.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = resolve(ROOT, '..');
const REPORT_DIR = resolve(ROOT, 'reports');
const METRICS = resolve(REPORT_DIR, 'metrics.ndjson');
const REPORT = resolve(REPORT_DIR, 'latest.md');

mkdirSync(REPORT_DIR, { recursive: true });
if (existsSync(METRICS)) unlinkSync(METRICS);

const files = readdirSync(ROOT)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => resolve(ROOT, name));

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: APP,
  env: { ...process.env, AGENT_METRICS_PATH: METRICS },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  const rows = readMetrics(METRICS);
  const text = renderReport(rows, code);
  writeFileSync(REPORT, text);
  writeFileSync(resolve(REPORT_DIR, 'latest.json'), JSON.stringify(summarize(rows, code), null, 2));
  process.stdout.write(`\n${text}\n`);
  process.stdout.write(`Wrote ${REPORT}\n`);
  process.exit(code === 0 ? 0 : 1);
});

function named(rows, name) {
  return rows.filter((r) => r.name === name);
}

function ratio(rows, name) {
  const hits = named(rows, name);
  if (!hits.length) return null;
  return hits.filter((r) => r.ok).length / hits.length;
}

function pct(value) {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function countOk(rows, name) {
  return named(rows, name).filter((r) => r.ok).length;
}

function countAll(rows, name) {
  return named(rows, name).length;
}

function lastCount(rows, name) {
  const hits = named(rows, name);
  const withCount = [...hits].reverse().find((r) => r.count != null);
  return withCount?.count ?? hits.length;
}

function failures(rows) {
  return rows.filter((r) => !r.ok && r.code);
}

function phasePass(rows, phase, keys) {
  const subset = rows.filter((r) => r.phase === phase && keys.includes(r.name));
  if (!subset.length) return 'FAIL';
  const rate = subset.filter((r) => r.ok).length / subset.length;
  if (rate >= 0.85) return 'PASS';
  if (rate >= 0.5) return 'PARTIAL';
  return 'FAIL';
}

function summarize(rows, exitCode) {
  const fieldDetection = ratio(rows, 'field_detected');
  const interaction = ratio(rows, 'interaction');
  const understanding = ratio(rows, 'question_understood');
  const truthful = ratio(rows, 'fabricated_answer');
  const optionMap = ratio(rows, 'option_mapping');
  const verification = ratio(rows, 'verification');
  const pageComplete = ratio(rows, 'page_completed');
  const e2e = ratio(rows, 'end_to_end');
  return {
    exitCode,
    rates: {
      field_detection_rate: fieldDetection,
      interaction_success_rate: interaction,
      question_understanding_rate: understanding,
      truthful_answer_rate: truthful,
      option_mapping_rate: optionMap,
      verification_rate: verification,
      page_completion_rate: pageComplete,
      end_to_end_success_rate: e2e,
    },
    failures: failures(rows),
  };
}

function verdict(summary) {
  const critical = summary.failures.filter((f) => ['F6', 'F12'].includes(f.code) || /submit/i.test(f.detail || ''));
  const rates = Object.values(summary.rates).filter((v) => v != null);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  if (critical.length) return 'FAIL';
  if (summary.exitCode !== 0) return avg >= 0.5 ? 'PARTIAL' : 'FAIL';
  if (avg >= 0.85) return 'PASS';
  if (avg >= 0.5) return 'PARTIAL';
  return 'FAIL';
}

function renderReport(rows, exitCode) {
  const summary = summarize(rows, exitCode);
  const p1 = phasePass(rows, 'phase1', ['field_detected', 'interaction', 'verification', 'schema_field', 'label_association', 'multipage_page1_isolated']);
  const p2 = phasePass(rows, 'phase2', ['profile_to_engine', 'question_understood', 'known_answered', 'unknown_analyzed', 'option_mapping', 'fabricated_answer']);
  const p3 = phasePass(rows, 'phase3', ['operation_order', 'page_completed', 'dynamic_detected', 'recovered_failure', 'end_to_end', 'no_external_submit']);
  const overall = verdict(summary);
  const crit = summary.failures.filter((f) => ['F1', 'F6', 'F8', 'F11', 'F12'].includes(f.code));
  const noncrit = summary.failures.filter((f) => !crit.includes(f));

  const recs = [];
  if ((summary.rates.field_detection_rate ?? 1) < 0.9) {
    recs.push('Production discoverPage still classifies many native email/tel/number inputs as generic text and often omits radio/dropdown option lists — keep fixture + live DOM verification.');
  }
  if (noncrit.some((f) => f.code === 'F7')) {
    recs.push('Year-bucket option mapping does not invent a range from a bare number; keep that refusal.');
  }
  if (crit.some((f) => f.code === 'F9')) {
    recs.push('Dynamic fields must be merged from the post-fill rescan before Next.');
  }
  recs.push('Production discoverFormFieldQuestions still flattens email/tel/number to text and often returns empty radio/dropdown option lists.');
  recs.push('Retest the same contracts on a live Workday URL before treating Local Phase as done. Do not submit from automated tests.');

  return `========================================
WORKDAY AI AGENT TEST REPORT
============================

PHASE 1 — PLAYWRIGHT
${p1}
Fields: expected ${lastCount(rows, 'total_fields') || 19}, detected ${lastCount(rows, 'fields_detected_count')} (label hits ${countOk(rows, 'field_detected')}/${countAll(rows, 'field_detected')})
Interactions: ${countOk(rows, 'interaction')}/${countAll(rows, 'interaction')}
Verification: ${countOk(rows, 'verification')}/${countAll(rows, 'verification')}
Dynamic detection: ${countOk(rows, 'dynamic_detection') + countOk(rows, 'dynamic_optional_appear')}/${countAll(rows, 'dynamic_detection') + countAll(rows, 'dynamic_optional_appear')}
Multipage: ${countOk(rows, 'multipage_page1_isolated') + countOk(rows, 'multipage_page2_isolated')}/${countAll(rows, 'multipage_page1_isolated') + countAll(rows, 'multipage_page2_isolated')}

PHASE 2 — PROFILE + LLM
${p2}
Profile retrieval: fetched=${yn(rows, 'profile_fetched')} parsed=${yn(rows, 'profile_parsed')} normalized=${yn(rows, 'profile_normalized')}
Question understanding: ${countOk(rows, 'question_understood')}/${countAll(rows, 'question_understood')}
Known answers: ${countOk(rows, 'known_answered')}/${countAll(rows, 'known_answered')}
Unknown questions: ${countOk(rows, 'unknown_analyzed')}/${countAll(rows, 'unknown_analyzed')}
Option mapping: ${countOk(rows, 'option_mapping')}/${countAll(rows, 'option_mapping')}
Truthfulness: no-fabricate ${countOk(rows, 'fabricated_answer')}/${countAll(rows, 'fabricated_answer')}
Safety: review flags ${countOk(rows, 'requires_review')}/${countAll(rows, 'requires_review')}

PHASE 3 — ORCHESTRATOR
${p3}
Page processing: ${countOk(rows, 'page_processed')}/${countAll(rows, 'page_processed')}
Answer execution: filled=${lastCount(rows, 'fields_filled')} verified=${lastCount(rows, 'fields_verified')}
Verification: ${countOk(rows, 'fields_verified')}/${Math.max(countAll(rows, 'fields_verified'), 1)}
Dynamic questions: ${countOk(rows, 'dynamic_detected')}/${countAll(rows, 'dynamic_detected')}
Recovery: ${countOk(rows, 'recovered_failure')}/${countAll(rows, 'recovered_failure')} retries logged=${countAll(rows, 'retry')}
Navigation: ${countOk(rows, 'navigation')}/${countAll(rows, 'navigation')}
End-to-end: ${countOk(rows, 'end_to_end')}/${countAll(rows, 'end_to_end')} (submit clicked: ${named(rows, 'no_external_submit').some((r) => !r.ok) ? 'YES' : 'no'})

RATES
field_detection_rate: ${pct(summary.rates.field_detection_rate)}
interaction_success_rate: ${pct(summary.rates.interaction_success_rate)}
question_understanding_rate: ${pct(summary.rates.question_understanding_rate)}
truthful_answer_rate: ${pct(summary.rates.truthful_answer_rate)}
option_mapping_rate: ${pct(summary.rates.option_mapping_rate)}
verification_rate: ${pct(summary.rates.verification_rate)}
page_completion_rate: ${pct(summary.rates.page_completion_rate)}
end_to_end_success_rate: ${pct(summary.rates.end_to_end_success_rate)}

OVERALL:
${overall}

CRITICAL FAILURES:
${formatFails(crit)}

NON-CRITICAL FAILURES:
${formatFails(noncrit)}

RECOMMENDED FIXES:
${recs.map((r) => `- ${r}`).join('\n')}

Notes:
- Metrics are measured, not assumed. A missing rate means that probe did not emit a sample.
- Failure codes: ${Object.entries(FAILURE).map(([k, v]) => `${k} ${v}`).join('; ')}
- node --test exit code: ${exitCode}
`;
}

function yn(rows, name) {
  const hits = named(rows, name);
  if (!hits.length) return 'n/a';
  return hits.every((r) => r.ok) ? 'yes' : 'no';
}

function formatFails(list) {
  if (!list.length) return 'none';
  return list.map((f) => `- ${f.code} ${FAILURE[f.code] || ''} — ${f.phase}.${f.name}: ${f.detail || ''}`).join('\n');
}
