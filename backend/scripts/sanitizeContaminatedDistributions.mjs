/**
 * sanitizeContaminatedDistributions.mjs
 *
 * Scans pending/ready_for_review rows in Supabase `job_distributions`.
 * For sibling candidates (`lead_applywizz_id` != `applywizz_id`), strips any non-universal
 * answers (First Name, Last Name, Email, Address, Company, Job Title, Dates, Education, Gender)
 * so that they re-resolve strictly using their own authentic client profile facts.
 */

import { getCleanSupabaseEnv } from '../lib/clusterBatchRunner.mjs';
import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { isAllowedUniversalLeadQuestion } from '../lib/resolvingWorkerPool.mjs';

async function sanitizePendingDistributions() {
  const { url, key, configured } = getCleanSupabaseEnv();
  if (!configured) {
    console.log('Supabase not configured. Skipping database sanitation.');
    return;
  }

  console.log('🔍 Checking Supabase `job_distributions` for contaminated sibling candidate rows...');

  // Fetch pending or ready_for_review distributions
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/job_distributions?select=id,applywizz_id,lead_applywizz_id,status,resolved_answers,is_fully_answered&status=in.(ready_for_review,needs_answers,queued,ready_to_review)&limit=200`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    console.error('Failed to query job_distributions:', res.status, res.text?.slice(0, 100));
    return;
  }

  const rows = res.json() || [];
  console.log(`Found ${rows.length} pending distribution row(s).`);

  let sanitizedCount = 0;

  for (const row of rows) {
    const isSibling = row.lead_applywizz_id && String(row.lead_applywizz_id).trim().toUpperCase() !== String(row.applywizz_id).trim().toUpperCase();
    if (!isSibling) continue;

    if (!Array.isArray(row.resolved_answers) || row.resolved_answers.length === 0) continue;

    // Filter to retain ONLY genuine universal answers
    const originalCount = row.resolved_answers.length;
    const sanitizedAnswers = row.resolved_answers.filter((a) => {
      const q = a.question || a.label || '';
      return isAllowedUniversalLeadQuestion(q);
    });

    if (sanitizedAnswers.length < originalCount) {
      console.log(`🧹 Sanitizing distribution ${row.id} for ${row.applywizz_id}: Stripped ${originalCount - sanitizedAnswers.length} personal/lead answer(s).`);

      const patchRes = await httpsJsonWithRetry({
        url: `${url}/rest/v1/job_distributions?id=eq.${row.id}`,
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          resolved_answers: sanitizedAnswers,
          is_fully_answered: false,
          status: 'needs_answers',
          updated_at: new Date().toISOString(),
        }),
      });

      if (patchRes.ok) {
        sanitizedCount++;
      } else {
        console.warn(`Failed to update row ${row.id}:`, patchRes.status);
      }
    }
  }

  console.log(`✅ Sanitation complete: ${sanitizedCount} contaminated sibling row(s) sanitized.`);
}

sanitizePendingDistributions().catch((err) => {
  console.error('Error during sanitation:', err);
});
