/**
 * Clean QA table: Workday questions the bot auto-answered
 * vs whether Apply Wizz API can supply that answer.
 *
 * Usage: node scripts/applywizz-gap-table.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch { /* optional */ }

const id = process.env.APPLYWIZZ_ID || 'AWL-34133';
const url = process.env.APPLYWIZZ_CLIENT_URL
  || process.env.APPLYWIZZ_API_URL
  || `https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(id)}`;

console.log(`Fetching Apply Wizz API (${id})...\n`);
const res = await fetch(url, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(20000),
});
if (!res.ok) throw new Error(`Apply Wizz API ${res.status}`);
const api = await res.json();

const {
  buildApplyWizzQaIndex,
  mapApplyWizzToProfile,
  lookupApplyWizzAnswer,
} = await import('../lib/applyWizzClient.mjs');
const { normalizeLabel } = await import('../lib/qaStore.mjs');
const { resolveByConcept } = await import('../lib/answerConcepts.mjs');

const client = api.client || {};
const info = api.additional_information || {};
const qaIndex = buildApplyWizzQaIndex(client, info);
const overlay = mapApplyWizzToProfile(client, info);
const profile = { ...overlay, _applyWizzQa: qaIndex, qa_answers: {} };

/** Collect questions the bot already answered (qa-store + llm-qa-store only). */
const answered = new Map(); // norm -> { question, botAnswer, source }

function addAnswered(label, answer, source) {
  const q = String(label || '').trim();
  const a = String(answer || '').trim();
  if (!q || q.length < 4 || !a) return;
  if (/indicates a required field|application questions \d|save and continue|password|beecatcher|^, /i.test(q)) {
    return;
  }
  // Skip truncated junk labels from bad harvests
  if (/^\W/.test(q) || q.startsWith(')')) return;

  const norm = normalizeLabel(q);
  if (!norm || norm.length < 4) return;

  // Prefer longer/cleaner question text; keep first non-empty answer
  if (!answered.has(norm)) {
    answered.set(norm, { question: q, botAnswer: a.slice(0, 180), source });
    return;
  }
  const cur = answered.get(norm);
  if (q.length > cur.question.length) cur.question = q;
  if (!cur.botAnswer && a) cur.botAnswer = a.slice(0, 180);
}

try {
  const qa = JSON.parse(readFileSync('data/qa-store.json', 'utf8'));
  for (const [k, v] of Object.entries(qa)) {
    const label = typeof v === 'object' && v ? (v.raw_label || k) : k;
    const clean = String(label).includes('::') ? String(label).split('::').slice(1).join('::') : label;
    const keyClean = String(k).includes('::') ? String(k).split('::').slice(1).join('::') : k;
    const ans = typeof v === 'object' && v ? v.answer : v;
    addAnswered(clean || keyClean, ans, 'qa-store');
  }
} catch (e) {
  console.error('qa-store:', e.message);
}

try {
  const llm = JSON.parse(readFileSync('data/llm-qa-store.json', 'utf8'));
  for (const [k, v] of Object.entries(llm.answers || {})) {
    if (!v || typeof v !== 'object' || !v.answer) continue;
    addAnswered(v.label || k, v.answer, 'llm / resume / bot analysis');
  }
} catch (e) {
  console.error('llm-qa-store:', e.message);
}

function inApplyWizzApi(label) {
  const hit = lookupApplyWizzAnswer(label, profile, { threshold: 0.55 });
  if (hit?.answer) return true;
  const concept = resolveByConcept(label, profile);
  return Boolean(concept?.answer);
}

const rows = [];
for (const [, entry] of [...answered.entries()].sort((a, b) => a[1].question.localeCompare(b[1].question))) {
  const present = inApplyWizzApi(entry.question);
  rows.push({
    question: entry.question,
    in_apply_wizz_api: present ? 'Yes' : 'No',
    bot_answer: entry.botAnswer,
    answered_via: entry.source,
  });
}

const missing = rows.filter((r) => r.in_apply_wizz_api === 'No');
const present = rows.filter((r) => r.in_apply_wizz_api === 'Yes');

function pad(s, n) {
  const t = String(s || '');
  if (t.length >= n) return `${t.slice(0, n - 1)}…`;
  return t + ' '.repeat(n - t.length);
}

console.log('='.repeat(100));
console.log('APPLY WIZZ API GAP — questions bot auto-answered');
console.log(`Client: ${id} | ${client.full_name || ''}`);
console.log(`Total bot-answered questions: ${rows.length}`);
console.log(`In Apply Wizz API: Yes=${present.length}  |  No (gap)=${missing.length}`);
console.log('='.repeat(100));
console.log('');
console.log('QUESTIONS NOT IN APPLY WIZZ CLIENT API (bot answered on its own)');
console.log('-'.repeat(100));
console.log(`${pad('#', 4)} ${pad('Workday question', 72)} ${pad('In API?', 8)}`);
console.log('-'.repeat(100));
missing.forEach((r, i) => {
  console.log(`${pad(String(i + 1), 4)} ${pad(r.question, 72)} ${pad(r.in_apply_wizz_api, 8)}`);
});
console.log('-'.repeat(100));
console.log(`TOTAL NOT IN API: ${missing.length}`);
console.log('');

// Markdown — clean 2-column focus + bot answer detail table
let md = '';
md += '# Apply Wizz API Gap Report\n\n';
md += `Generated: ${new Date().toISOString()}\n\n`;
md += `**Client:** ${id} — ${client.full_name || 'n/a'}\n\n`;
md += '## Summary\n\n';
md += '| Metric | Count |\n|---|---:|\n';
md += `| Questions bot auto-answered | ${rows.length} |\n`;
md += `| In Apply Wizz API (Yes) | ${present.length} |\n`;
md += `| **Not in Apply Wizz API (No)** | **${missing.length}** |\n\n`;
md += 'Scope: Apply Wizz API only (YAML excluded). Sources: `qa-store.json`, `llm-qa-store.json`.\n\n';

md += '## Not in Apply Wizz API — 2 column table\n\n';
md += '| Workday question (bot auto-answered) | In Apply Wizz client API? |\n';
md += '|---|---|\n';
for (const r of missing) {
  md += `| ${r.question.replace(/\|/g, '\\|')} | **No** |\n`;
}
md += `\n**Total not in API: ${missing.length}**\n\n`;

md += '## Same gaps — with bot answer (for QA)\n\n';
md += '| # | Workday question | In API? | Bot answer (resume / LLM / analysis) |\n';
md += '|---:|---|---|---|\n';
missing.forEach((r, i) => {
  md += `| ${i + 1} | ${r.question.replace(/\|/g, '\\|')} | No | ${String(r.bot_answer).replace(/\|/g, '\\|')} |\n`;
});
md += '\n';

md += '## In Apply Wizz API (covered) — reference\n\n';
md += '| Workday question | In Apply Wizz client API? |\n';
md += '|---|---|\n';
for (const r of present) {
  md += `| ${r.question.replace(/\|/g, '\\|')} | Yes |\n`;
}
md += `\n**Total in API: ${present.length}**\n`;

writeFileSync('data/APPLYWIZZ-API-GAP-REPORT.md', md);
writeFileSync('data/APPLYWIZZ-API-GAP-REPORT.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  client: { applywizz_id: id, full_name: client.full_name },
  summary: {
    bot_answered_total: rows.length,
    in_api_yes: present.length,
    in_api_no: missing.length,
  },
  not_in_apply_wizz_api: missing.map((r) => ({
    question: r.question,
    in_apply_wizz_api: 'No',
    bot_answer: r.bot_answer,
  })),
  in_apply_wizz_api: present.map((r) => ({
    question: r.question,
    in_apply_wizz_api: 'Yes',
    bot_answer: r.bot_answer,
  })),
}, null, 2));

console.log(`Updated: data/APPLYWIZZ-API-GAP-REPORT.md`);
console.log(`Updated: data/APPLYWIZZ-API-GAP-REPORT.json`);
