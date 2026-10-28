import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runEvidenceTests() {
  console.log('================================================================');
  console.log('PHASE 1 EVIDENCE TEST SUITE: DATABASE GUARDS & ONE-SHOT ACTOR');
  console.log('================================================================\n');

  // Step 1: Confirm migration status by inspecting columns
  console.log('1. Checking database columns for migration 040...');
  const { data: colCheck, error: colErr } = await supabase
    .from('submission_tasks')
    .select('id, status_actor, possibly_submitted, review_flag')
    .limit(1);

  if (colErr && colErr.message.includes('does not exist')) {
    console.error('NOT RUN — requires developer to execute in SQL Editor');
    console.error(`Reason: ${colErr.message}`);
    console.error('Please run backend/supabase-migrations/040_phase1_database_guards_and_state.sql in the Supabase SQL Editor first.\n');
    process.exit(1);
  }
  console.log('✅ Migration 040 columns confirmed present in submission_tasks!\n');

  // Step 2: Supabase-js Actor Update Test
  const testAWL = 'AWL-TEST-GUARD';
  console.log(`2. Executing supabase-js updates on test row (applywizz_id: ${testAWL})...`);

  // Insert test row in ready_for_review
  const { data: insData, error: insErr } = await supabase
    .from('submission_tasks')
    .insert({
      applywizz_id: testAWL,
      job_url: 'https://test.workday.com/job/evidence-check',
      company: 'Evidence Test Corp',
      role_title: 'Evidence Test Role',
      status: 'ready_for_review',
      status_actor: 'system',
    })
    .select('id, status, status_actor');

  if (insErr) {
    console.error(`❌ Insert failed: ${insErr.message}`);
    process.exit(1);
  }

  const testTaskId = insData[0].id;
  console.log(`   Created test row #${testTaskId} (status: ${insData[0].status}, status_actor: ${insData[0].status_actor})`);

  // Step 3: ready_for_review -> queued
  const { data: qData, error: qErr } = await supabase
    .from('submission_tasks')
    .update({ status: 'queued', status_actor: 'system' })
    .eq('id', testTaskId)
    .select('id, status, status_actor');

  if (qErr) {
    console.error(`❌ Transition ready_for_review -> queued failed: ${qErr.message}`);
    process.exit(1);
  }
  if (!qData || qData[0].status !== 'queued' || qData[0].status_actor !== 'system') {
    console.error(`❌ Assertion failed on queued transition: received status=${qData?.[0]?.status}, actor=${qData?.[0]?.status_actor}`);
    process.exit(1);
  }
  console.log(`   ✅ ready_for_review -> queued: status=${qData[0].status}, status_actor=${qData[0].status_actor}`);

  // Step 4: queued -> applying (with worker_1)
  const { data: aData, error: aErr } = await supabase
    .from('submission_tasks')
    .update({ status: 'applying', worker_id: 'worker_1', status_actor: 'system' })
    .eq('id', testTaskId)
    .select('id, status, status_actor');

  if (aErr) {
    console.error(`❌ Transition queued -> applying failed: ${aErr.message}`);
    process.exit(1);
  }
  if (!aData || aData[0].status !== 'applying' || aData[0].status_actor !== 'system') {
    console.error(`❌ Assertion failed on applying transition: received status=${aData?.[0]?.status}, actor=${aData?.[0]?.status_actor}`);
    process.exit(1);
  }
  console.log(`   ✅ queued -> applying: status=${aData[0].status}, status_actor=${aData[0].status_actor}`);

  // Step 5: applying -> ready_for_review with actor 'stop' (one-shot check)
  const { data: stopData, error: stopErr } = await supabase
    .from('submission_tasks')
    .update({ status: 'ready_for_review', status_actor: 'stop' })
    .eq('id', testTaskId)
    .select('id, status, status_actor');

  if (stopErr) {
    console.error(`❌ Transition applying -> ready_for_review with actor 'stop' failed: ${stopErr.message}`);
    process.exit(1);
  }
  if (!stopData || stopData[0].status !== 'ready_for_review') {
    console.error(`❌ Assertion failed: expected status='ready_for_review', got ${stopData?.[0]?.status}`);
    process.exit(1);
  }
  // ASSERTION: status_actor MUST be reset to 'system' (one-shot behavior)
  if (stopData[0].status_actor !== 'system') {
    console.error(`❌ Assertion failed: status_actor persisted as '${stopData[0].status_actor}', expected 'system'`);
    process.exit(1);
  }
  console.log(`   ✅ applying -> ready_for_review with actor='stop': status=${stopData[0].status}, status_actor=${stopData[0].status_actor} (reset confirmed)`);

  console.log('\n================================================================');
  console.log('CLEANUP SQL (To run in Supabase SQL Editor as table owner):');
  console.log('----------------------------------------------------------------');
  console.log(`delete from public.submission_task_events where task_id in (select id from public.submission_tasks where applywizz_id = '${testAWL}');`);
  console.log(`delete from public.submission_tasks where applywizz_id = '${testAWL}';`);
  console.log('================================================================\n');

  console.log('✅ ALL SUPABASE-JS EVIDENCE ASSERTIONS PASSED.');
}

runEvidenceTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
