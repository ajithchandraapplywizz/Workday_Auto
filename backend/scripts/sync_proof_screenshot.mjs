import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function syncPendingProof() {
  const screenshotUrl = 'https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/submitted-applications/CLIENT/1792731924887_submitted_1792731924887.png';
  const distId = '645bb943-d3b4-423c-87a0-cdf2f6b56dfa';
  const taskId = '244e25a0-5347-4889-a63f-53a4d018c7a2';
  const candidateId = 'AWL-27321';

  console.log('Syncing proof screenshot for AWL-27321...');

  // 1. Update job_distributions
  const { data: jdData, error: jdErr } = await supabase
    .from('job_distributions')
    .update({
      status: 'submitted',
      application_submitted_screenshot_url: screenshotUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', distId)
    .select('id, applywizz_id, status, application_submitted_screenshot_url');

  console.log('job_distributions update:', { jdData, jdErr });

  // 2. Update submission_tasks
  const { data: stData, error: stErr } = await supabase
    .from('submission_tasks')
    .update({
      status: 'submitted',
      screenshot_path: screenshotUrl,
      application_submitted_screenshot_url: screenshotUrl,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .or(`id.eq.${taskId},distribution_id.eq.${distId},applywizz_id.eq.${candidateId}`)
    .select('id, applywizz_id, status, screenshot_path, application_submitted_screenshot_url');

  console.log('submission_tasks update:', { stData, stErr });
}

syncPendingProof().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
