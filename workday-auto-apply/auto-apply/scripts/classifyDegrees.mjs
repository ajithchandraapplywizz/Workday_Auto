/**
 * scripts/classifyDegrees.mjs — Offline AI degree classification script.
 *
 * Classifies candidate education into canonical buckets directly against Supabase:
 * - Master of Science
 * - Bachelor of Technology
 * - Master of Biotechnology
 *
 * Adheres strictly to the additive-only policy and writes zero local files.
 */

import { loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';
import { openRouterChat } from '../lib/openRouterLlm.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';

loadLocalEnvOnce();

export const CANONICAL_BUCKETS = [
  'Master of Science',
  'Bachelor of Technology',
  'Master of Biotechnology',
];

export const SHORTCUT_CANDIDATES = {
  'Master of Science': ['Master of Science', 'MS', 'M.S.'],
  'Bachelor of Technology': ['Bachelor of Technology', 'B.Tech', 'BTech'],
  'Master of Biotechnology': ['Master of Biotechnology', 'M.Biotech', 'MSBiotech'],
};

export function tokenSetRatio(str1, str2) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const set1 = new Set(norm(str1));
  const set2 = new Set(norm(str2));
  if (!set1.size || !set2.size) return 0;
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  if (intersection.size === set1.size) return 100;
  return Math.round((2 * intersection.size / (set1.size + set2.size)) * 100);
}

export function classifyDeterministically(sourceRaw = '') {
  const s = String(sourceRaw || '').trim();
  if (!s) return null;

  // Master of Biotechnology (checked before general Master of Science)
  if (
    /master\s*(?:of)?\s*biotech(?:nology)?|\bm\.?biotech\b|\bmsbiotech\b/i.test(s)
    || tokenSetRatio('Master of Biotechnology', s) >= 85
  ) {
    return 'Master of Biotechnology';
  }

  // Master of Science
  if (
    /master\s*(?:of)?\s*science|\bm\.?sc\b|\bm\.?s\b(?!\s*degree|\s*in\s*arts)|\bms\b/i.test(s)
    || tokenSetRatio('Master of Science', s) >= 85
  ) {
    if (!/\bbachelor\b|\bbs\b/i.test(s) || /\bmaster\b|\bms\b/i.test(s)) {
      return 'Master of Science';
    }
  }

  // Bachelor of Technology
  if (
    /bachelor\s*(?:of)?\s*technology|\bb\.?tech\b/i.test(s)
    || tokenSetRatio('Bachelor of Technology', s) >= 85
  ) {
    return 'Bachelor of Technology';
  }

  return null;
}

export async function classifyWithLlm(sourceRaw = '') {
  const prompt = `Given this education info, classify into exactly one of:
['Master of Science', 'Bachelor of Technology', 'Master of Biotechnology', 'NONE'].
Return NONE only if it genuinely does not correspond to any of these three
(e.g. Bachelor of Arts, MBA, unrelated field). Do not force a fit.

Input: "${sourceRaw}"

Respond with ONLY the exact string from the list above.`;

  try {
    const res = await openRouterChat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens: 50,
    });
    const raw = res?.choices?.[0]?.message?.content?.trim() || '';
    const cleaned = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (CANONICAL_BUCKETS.includes(cleaned)) {
      return cleaned;
    }
    return null;
  } catch (err) {
    console.error(`  ⚠️ LLM classification failed for "${sourceRaw}": ${err.message}`);
    return null;
  }
}

async function fetchAllClients(supabaseUrl, serviceKey) {
  const res = await httpsJsonWithRetry({
    url: `${supabaseUrl}/rest/v1/clients?select=applywizz_id,client_name,first_name,last_name,degree,education,field_of_study&order=applywizz_id.asc`,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Range: '0-999',
    },
    timeoutMs: 25000,
  }, { attempts: 2, label: 'Supabase' });

  if (!res.ok) {
    throw new Error(`Failed to fetch clients: ${res.status} ${res.text}`);
  }
  return res.json() || [];
}

async function updateClientDegreeClassification(supabaseUrl, serviceKey, applywizzId, classification) {
  const res = await httpsJsonWithRetry({
    url: `${supabaseUrl}/rest/v1/clients?applywizz_id=eq.${encodeURIComponent(applywizzId)}`,
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: {
      degree_classification: classification,
      updated_at: new Date().toISOString(),
    },
    timeoutMs: 20000,
  }, { attempts: 2, label: 'Supabase Update' });

  if (!res.ok) {
    throw new Error(`Failed to update ${applywizzId}: ${res.status} ${res.text}`);
  }
  return true;
}

export async function run() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log(`\n======================================================`);
  console.log(`🎓 Starting Degree AI Classification (${isDryRun ? 'DRY RUN' : 'LIVE RUN'})`);
  console.log(`======================================================\n`);

  if (!isSupabaseConfigured()) {
    console.error('❌ Supabase is not configured in .env. Exiting.');
    process.exit(1);
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  console.log(`Fetching clients directly from Supabase...`);
  const clients = await fetchAllClients(supabaseUrl, serviceKey);
  console.log(`Found ${clients.length} client(s) in Supabase.\n`);

  const stats = {
    total: clients.length,
    deterministic: 0,
    llm: 0,
    unmapped: 0,
    byBucket: {
      'Master of Science': 0,
      'Bachelor of Technology': 0,
      'Master of Biotechnology': 0,
    },
  };

  const unmappedList = [];

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    const id = client.applywizz_id;
    const rawDegree = (client.degree || client.education || '').trim();
    const rawField = (client.field_of_study || '').trim();
    const sourceRaw = [rawDegree, rawField].filter(Boolean).join(' in ') || rawDegree || 'Unknown';

    let canonicalDegree = classifyDeterministically(sourceRaw);
    let matchMethod = 'deterministic';

    if (!canonicalDegree && sourceRaw !== 'Unknown') {
      canonicalDegree = await classifyWithLlm(sourceRaw);
      matchMethod = 'llm';
    }

    if (canonicalDegree) {
      if (matchMethod === 'deterministic') stats.deterministic++;
      else stats.llm++;
      stats.byBucket[canonicalDegree] = (stats.byBucket[canonicalDegree] || 0) + 1;
    } else {
      stats.unmapped++;
      unmappedList.push({ applywizz_id: id, source_raw: sourceRaw });
    }

    const shortcuts = canonicalDegree ? SHORTCUT_CANDIDATES[canonicalDegree] : null;
    const classificationPayload = {
      canonical_degree: canonicalDegree,
      shortcut_candidates: shortcuts,
      source_raw: sourceRaw,
      classified_at: new Date().toISOString(),
    };

    console.log(
      `[${i + 1}/${clients.length}] ${id}: "${sourceRaw}" -> ${canonicalDegree || 'NULL'} (${matchMethod})`
    );

    if (!isDryRun) {
      try {
        await updateClientDegreeClassification(supabaseUrl, serviceKey, id, classificationPayload);
      } catch (err) {
        console.error(`  ❌ Failed to write classification for ${id}: ${err.message}`);
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`📊 Classification Summary`);
  console.log(`======================================================`);
  console.log(`Total Clients Processed: ${stats.total}`);
  console.log(`Deterministic Matches:   ${stats.deterministic}`);
  console.log(`LLM Matches:             ${stats.llm}`);
  console.log(`Unmapped (NULL):         ${stats.unmapped}`);
  console.log(`\nBreakdown by Canonical Bucket:`);
  for (const [bucket, count] of Object.entries(stats.byBucket)) {
    console.log(`  - ${bucket}: ${count}`);
  }

  if (unmappedList.length > 0) {
    console.log(`\n======================================================`);
    console.log(`⚠️ Unmapped Clients Report (${unmappedList.length} clients):`);
    console.log(`(Review list below - stdout only, no local files created)`);
    console.log(`======================================================`);
    for (const item of unmappedList) {
      console.log(`  ${item.applywizz_id}: "${item.source_raw}"`);
    }
    console.log(`======================================================\n`);
  }

  console.log(`✅ Classification complete! (${isDryRun ? 'DRY RUN - nothing written' : 'Written to Supabase'})`);
}

import { fileURLToPath } from 'url';
import { resolve } from 'path';

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().catch((err) => {
    console.error('Fatal error running classification script:', err);
    process.exit(1);
  });
}

