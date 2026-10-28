import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runPreview() {
  // 1. Queued tasks preview (queued -> ready_for_review)
  const { count: queuedCount, data: queuedSample, error: qErr } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, job_url, company, role_title, status, updated_at', { count: 'exact' })
    .eq('status', 'queued')
    .limit(5);

  console.log('--- REPAIR PREVIEW 1: QUEUED ROWS ---');
  console.log(`Total 'queued' rows to return to 'ready_for_review': ${queuedCount}`);
  if (qErr) console.error('Queued error:', qErr);
  console.log('Sample queued rows:', JSON.stringify(queuedSample, null, 2));

  // 2. Failed tasks preview (failed -> ready_for_review) using exact WHERE clause:
  // status = 'failed' AND screenshot is null AND (error_message ILIKE '%daemon restarted%' OR error_message ILIKE '%timed out%')
  const { data: allFailed, error: fErr } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, job_url, company, role_title, status, error_message, application_submitted_screenshot_url, screenshot_path, updated_at')
    .eq('status', 'failed')
    .is('application_submitted_screenshot_url', null)
    .is('screenshot_path', null);

  const matchedFailed = (allFailed || []).filter(t => {
    const msg = t.error_message || '';
    return msg.toLowerCase().includes('daemon restarted') || msg.toLowerCase().includes('timed out');
  });

  console.log('\n--- REPAIR PREVIEW 2: FAILED ROWS (EXACT WHERE CLAUSE) ---');
  console.log(`Total 'failed' rows in submission_tasks: ${(allFailed || []).length}`);
  console.log(`Total matching failed repair WHERE clause (no screenshot + daemon restarted/timed out): ${matchedFailed.length}`);
  console.log('Sample matched failed rows:', JSON.stringify(matchedFailed.slice(0, 5), null, 2));
}

runPreview();
