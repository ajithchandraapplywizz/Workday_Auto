import { loadLocalEnvOnce, isSupabaseConfigured, getScannedJob, completeSubmittedTask } from '../lib/supabaseClient.mjs';
import { preResolveClientAnswersDetailed } from '../lib/jobFormCache.mjs';
import { loadProfile } from '../lib/planner.mjs';

loadLocalEnvOnce();

async function runTest() {
  console.log('🧪 VERIFYING CLIENT QUESTION RESOLUTION & SCREENSHOT DECOUPLING...');

  // 1. Fetch a scanned job blueprint from scanned_jobs
  const jobUrl = 'https://cambiumlearning.wd1.myworkdayjobs.com/camb/job/Remote/Data-Analyst-I_REQ-4633';
  const scanned = await getScannedJob(jobUrl);

  if (!scanned || !scanned.scraped_questions) {
    console.error('❌ Could not find scanned job for REQ-4633');
    process.exit(1);
  }

  console.log(`✅ Loaded Scanned Job: ${scanned.company} | ${scanned.role_title}`);
  console.log(`   Scraped Questions Count: ${scanned.scraped_questions.length}`);
  console.log(`   Blueprint Screenshot Path: ${scanned.screenshot_path ? 'Present (' + scanned.screenshot_path.slice(0, 50) + '...)' : 'None'}`);

  const schema = {
    id: scanned.id,
    fields_schema: scanned.scraped_questions,
    company: scanned.company,
    role_title: scanned.role_title,
  };

  // 2. Resolve for two distinct clients in parallel (e.g. AWL-4220 and AWL-1568)
  const clientIds = ['AWL-4220', 'AWL-1568'];
  console.log(`\n⚡ Resolving in parallel for: ${clientIds.join(', ')}...`);

  const results = await Promise.all(clientIds.map(async (awlId) => {
    const profile = await loadProfile(null, { applywizzId: awlId });
    if (!profile) return { awlId, error: 'Profile not found' };
    profile._applyWizzId = awlId;
    profile._canonicalJobUrl = jobUrl;
    profile._jobUrl = jobUrl;
    profile._company = scanned.company;

    const detailed = await preResolveClientAnswersDetailed({ jobUrl, schema, profile });
    return {
      awlId,
      resolvedCount: detailed?.structuredAnswers?.filter(a => a.is_answered)?.length || 0,
      totalCount: detailed?.structuredAnswers?.length || 0,
      isFullyAnswered: detailed?.isFullyAnswered,
      sampleAnswers: detailed?.structuredAnswers?.slice(0, 3).map(a => ({ q: a.question, ans: a.answer, tier: a.tier })),
    };
  }));

  for (const res of results) {
    console.log(`\n📋 Client ${res.awlId}:`);
    console.log(`   Resolved: ${res.resolvedCount} / ${res.totalCount} (Fully Answered: ${res.isFullyAnswered})`);
    console.log(`   Sample Answers:`, JSON.stringify(res.sampleAnswers, null, 2));
  }

  console.log('\n✅ Parallel resolution test passed cleanly!');
}

runTest().catch((e) => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
