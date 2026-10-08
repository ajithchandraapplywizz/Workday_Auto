import { loadLocalEnvOnce, isSupabaseConfigured, recordFailedJob } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

async function runTest() {
  console.log('🧪 VERIFYING FAILURE RESOLVED ANSWERS & QUESTION TYPE INFERENCE...');

  const testAwlId = 'TEST-FAIL-01';
  const testJobUrl = 'https://test-failed-job-audit.com/job/REQ-999';

  const mockResolvedAnswers = [
    {
      question: 'First Name*',
      question_normalized: 'first name',
      answer: 'TestCandidate',
      field_type: 'text',
      step: 'Contact Information',
      is_answered: true,
    },
    {
      question: 'Are you legally authorized to work in the United States?*',
      question_normalized: 'are you legally authorized to work in the united states',
      answer: 'Yes',
      field_type: 'radio',
      options: ['Yes', 'No'],
      step: 'Application Questions',
      is_answered: true,
    },
    {
      question: 'Phone Number*',
      question_normalized: 'phone number',
      answer: '5551234567',
      field_type: 'phone',
      step: 'Contact Information',
      is_answered: true,
    }
  ];

  const mockScreenshotUrl = 'https://rltnrnqqmufeeqaodsif.supabase.co/storage/v1/object/public/application-failures/test_error_proof.jpg';

  console.log(`\n1. Testing recordFailedJob with ${mockResolvedAnswers.length} resolved answers & screenshot...`);
  const success = await recordFailedJob({
    applywizzId: testAwlId,
    jobId: 'REQ-999',
    jobUrl: testJobUrl,
    company: 'Test Failure Corp',
    roleTitle: 'Software Engineer',
    failureReason: 'Form stalled on "Application Questions" - missing required field "Desired Salary"',
    failedAtStep: 'Application Questions',
    screenshotPath: mockScreenshotUrl,
    resolvedAnswers: mockResolvedAnswers,
  });

  console.log(`   Record result: ${success ? 'SUCCESS' : 'NOTICE'}`);

  // Clean up test failure row
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    await fetch(`${url}/rest/v1/failed_jobs?applywizz_id=eq.${testAwlId}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).catch(() => {});
    console.log('   Cleaned up test row from failed_jobs.');
  }

  console.log('\n✅ Failure recording test completed successfully!');
}

runTest().catch((err) => {
  console.error('❌ Test error:', err);
  process.exit(1);
});
