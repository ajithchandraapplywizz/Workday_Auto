/**
 * restore_submission_tasks.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Restores all 'ready_for_review' rows from `job_distributions` back into
 * `submission_tasks`.
 *
 * Use this script whenever submission_tasks was accidentally cleared or deleted:
 * All master candidate answers, Q&A maps, and form structures are permanently
 * preserved in `job_distributions`, so this script re-mirrors them in seconds.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

async function main() {
  loadLocalEnvOnce();
  const url = (process.env.SUPABASE_URL || '').replace(/[\"']/g, '').replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').replace(/[\"']/g, '');

  if (!url || !key) {
    console.error('❌ Supabase credentials not found in environment (.env).');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`🔄 RESTORING SUBMISSION TASKS FROM JOB DISTRIBUTIONS`);
  console.log(`${'═'.repeat(72)}\n`);

  // 1. Fetch all ready_for_review records from job_distributions
  console.log(`🔍 Fetching all 'ready_for_review' applications from public.job_distributions...`);
  let offset = 0;
  const readyRows = [];
  while (true) {
    const res = await httpsJsonWithRetry({
      url: `${url}/rest/v1/job_distributions?status=eq.ready_for_review&select=id,applywizz_id,job_url,company,role_title,created_at,updated_at&limit=1000&offset=${offset}`,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      console.error(`❌ Failed to query job_distributions: ${res.status} ${res.text}`);
      process.exit(1);
    }
    const chunk = res.json() || [];
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    readyRows.push(...chunk);
    if (chunk.length < 1000) break;
    offset += chunk.length;
  }

  console.log(`   Found ${readyRows.length} 'ready_for_review' rows in job_distributions.`);

  if (readyRows.length === 0) {
    console.log(`⚠️ No 'ready_for_review' rows found in job_distributions to restore.`);
    return;
  }

  // Deduplicate strictly by distribution_id or (applywizz_id, job_url)
  const dedupMap = new Map();
  for (const r of readyRows) {
    const awl = String(r.applywizz_id || '').trim().toUpperCase();
    const jUrl = String(r.job_url || '').trim();
    const distId = r.id;
    const pairKey = distId || `${awl}:::${jUrl}`;
    if (!dedupMap.has(pairKey)) {
      dedupMap.set(pairKey, {
        distribution_id: distId,
        applywizz_id: awl,
        job_url: jUrl,
        company: r.company || 'Workday Employer',
        role_title: r.role_title || 'Role',
        status: 'ready_for_review',
        created_at: r.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  const tasksToInsert = Array.from(dedupMap.values());
  console.log(`   Deduplicated to ${tasksToInsert.length} unique submission tasks.`);

  // 2. Batch insert into submission_tasks in chunks of 50
  console.log(`\n⏳ Inserting ${tasksToInsert.length} tasks into public.submission_tasks...`);
  const CHUNK_SIZE = 50;
  let restoredCount = 0;

  for (let i = 0; i < tasksToInsert.length; i += CHUNK_SIZE) {
    const chunk = tasksToInsert.slice(i, i + CHUNK_SIZE);
    const postRes = await httpsJsonWithRetry({
      url: `${url}/rest/v1/submission_tasks?on_conflict=distribution_id`,
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: chunk,
    });

    if (!postRes.ok) {
      console.warn(`   ⚠️ Chunk insert error: ${postRes.status} ${postRes.text?.slice(0, 150)}`);
    } else {
      restoredCount += chunk.length;
      process.stdout.write(`   ✓ Restored ${restoredCount}/${tasksToInsert.length} tasks...\r`);
    }
  }

  console.log(`\n\n✅ RESTORATION COMPLETE!`);
  console.log(`   • Total Restored to submission_tasks: ${restoredCount} tasks`);
  console.log(`   • Status: 'ready_for_review'`);
  console.log(`   • You can now trigger submissions from the dashboard or daemon!\n`);
}

main().catch((err) => {
  console.error('Fatal error during restoration:', err);
  process.exit(1);
});
