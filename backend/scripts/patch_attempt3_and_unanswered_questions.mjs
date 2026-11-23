import { supabase } from '../lib/supabaseClient.mjs';

/**
 * Patch script:
 * 1. Updates all Attempt 3/3 failed rows in job_distributions:
 *    - status: 'failed'
 *    - worker_id: null, worker_leased_at: null
 *    - application_submitted_screenshot_url: extracted from diagnostic_screenshot if currently null
 * 2. Updates all rows where is_fully_answered = true but unanswered_questions != '[]':
 *    - unanswered_questions: []
 *    - unanswered_count: 0
 */
async function run() {
  console.log('--- Starting Patch for Attempt 3/3 and Unanswered Questions ---');

  // STEP 1: Mark all Attempt 3/3 rows as failed
  console.log('\n[Step 1] Fetching Attempt 3/3 rows...');
  const { data: att3Rows, error: att3Err } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, company, status, error_message, application_submitted_screenshot_url')
    .ilike('error_message', '%Attempt 3/3%');

  if (att3Err) {
    console.error('Error fetching Attempt 3 rows:', att3Err.message);
    process.exit(1);
  }

  console.log(`Found ${att3Rows.length} total rows with Attempt 3/3 in error_message.`);
  let failedUpdated = 0;

  for (const row of att3Rows) {
    const errText = row.error_message || '';
    const shotMatch = errText.match(/\[diagnostic_screenshot:\s*([^\s\]]+)\]/i);
    const extractedShot = (shotMatch && shotMatch[1] && shotMatch[1] !== 'none' && shotMatch[1] !== 'None')
      ? shotMatch[1].trim()
      : null;

    const finalShot = row.application_submitted_screenshot_url || extractedShot || null;

    const patch = {
      status: 'failed',
      worker_id: null,
      worker_leased_at: null,
      updated_at: new Date().toISOString(),
    };

    if (finalShot) {
      patch.application_submitted_screenshot_url = finalShot;
    }

    const { error: updErr } = await supabase
      .from('job_distributions')
      .update(patch)
      .eq('id', row.id);

    if (updErr) {
      console.warn(`Failed to update Attempt 3 row ${row.id} (${row.applywizz_id}): ${updErr.message}`);
    } else {
      failedUpdated++;
    }
  }

  console.log(`✅ Successfully updated ${failedUpdated}/${att3Rows.length} Attempt 3/3 rows to status 'failed' with diagnostic screenshot URLs.`);

  // STEP 2: Clear unanswered_questions for all is_fully_answered = true rows
  console.log('\n[Step 2] Fetching is_fully_answered = true rows with non-empty unanswered_questions...');
  const { data: unansRows, error: unansErr } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, is_fully_answered, unanswered_count, unanswered_questions')
    .eq('is_fully_answered', true)
    .neq('unanswered_questions', '[]');

  if (unansErr) {
    console.error('Error fetching unanswered questions rows:', unansErr.message);
    process.exit(1);
  }

  console.log(`Found ${unansRows.length} rows where is_fully_answered = true but unanswered_questions is not empty.`);

  const CHUNK_SIZE = 50;
  let clearedCount = 0;

  for (let i = 0; i < unansRows.length; i += CHUNK_SIZE) {
    const chunkIds = unansRows.slice(i, i + CHUNK_SIZE).map(r => r.id);
    const { error: clearErr } = await supabase
      .from('job_distributions')
      .update({
        unanswered_questions: [],
        unanswered_count: 0,
        updated_at: new Date().toISOString(),
      })
      .in('id', chunkIds);

    if (clearErr) {
      console.warn(`Chunk update error at index ${i}:`, clearErr.message);
    } else {
      clearedCount += chunkIds.length;
    }
  }

  console.log(`✅ Successfully cleared unanswered_questions for ${clearedCount}/${unansRows.length} rows.`);

  // STEP 3: Verification Check
  console.log('\n[Step 3] Verifying remaining counts in job_distributions...');
  const { count: remReadyAtt3 } = await supabase
    .from('job_distributions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ready_for_review')
    .ilike('error_message', '%Attempt 3/3%');

  const { count: remReadyTotal } = await supabase
    .from('job_distributions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ready_for_review');

  const { count: remUnansMismatch } = await supabase
    .from('job_distributions')
    .select('*', { count: 'exact', head: true })
    .eq('is_fully_answered', true)
    .neq('unanswered_questions', '[]');

  console.log('Verification Results:', {
    remaining_ready_for_review_with_attempt3: remReadyAtt3,
    remaining_ready_for_review_total: remReadyTotal,
    remaining_unanswered_mismatch: remUnansMismatch,
  });

  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
