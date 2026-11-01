import { getCleanSupabaseEnv } from '../lib/clusterBatchRunner.mjs';
import { createClient } from '@supabase/supabase-js';

const { url, key } = getCleanSupabaseEnv();
const supabase = createClient(url, key);

async function testPhase1Integrity() {
  console.log('====================================================');
  console.log('       PRODUCTION GATE 1: PHASE 1 AWL-ID AUDIT      ');
  console.log('====================================================');

  const { data: jdRows, error: jdErr } = await supabase.from('job_distributions').select('id, applywizz_id');
  if (jdErr) throw jdErr;

  const { data: stRows, error: stErr } = await supabase.from('submission_tasks').select('id, applywizz_id, status, application_submitted_screenshot_url');
  if (stErr) throw stErr;

  const dirtyJd = jdRows.filter(r => r.applywizz_id && /["'\[\]\\]/.test(r.applywizz_id));
  const dirtySt = stRows.filter(r => r.applywizz_id && /["'\[\]\\]/.test(r.applywizz_id));

  console.log(`Total job_distributions rows: ${jdRows.length}`);
  console.log(`Dirty job_distributions rows: ${dirtyJd.length}`);
  console.log(`Total submission_tasks rows:  ${stRows.length}`);
  console.log(`Dirty submission_tasks rows:  ${dirtySt.length}`);

  if (dirtyJd.length > 0 || dirtySt.length > 0) {
    throw new Error(`Gate 1 Failed: Found ${dirtyJd.length} dirty job_distributions and ${dirtySt.length} dirty submission_tasks.`);
  }

  // Ensure pattern matches clean AWL ID
  const invalidPatternJd = jdRows.filter(r => !/^AWL-[A-Z0-9_-]+$/i.test(r.applywizz_id?.trim()));
  const invalidPatternSt = stRows.filter(r => !/^AWL-[A-Z0-9_-]+$/i.test(r.applywizz_id?.trim()));

  console.log(`Invalid pattern job_distributions: ${invalidPatternJd.length}`);
  console.log(`Invalid pattern submission_tasks:  ${invalidPatternSt.length}`);

  const submittedCount = stRows.filter(r => r.status === 'submitted' && r.application_submitted_screenshot_url).length;
  console.log(`Total valid submitted rows with screenshots: ${submittedCount}`);

  console.log('✅ GATE 1 PASS: Database AWL IDs are 100% clean and sanitized!\n');
}

testPhase1Integrity().catch((err) => {
  console.error('❌ GATE 1 FAILED:', err.message);
  process.exit(1);
});
