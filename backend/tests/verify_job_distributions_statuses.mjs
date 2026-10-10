import assert from 'assert';
import { preResolveClientAnswersDetailed } from '../lib/jobFormCache.mjs';

async function testResolutionStatuses() {
  console.log('🧪 RUNNING VERIFICATION FOR 4-TIER ANSWER RESOLUTION & STATUS RULES...');

  // Mock schema with 3 required fields and 1 optional field
  const schema = {
    tenant: 'test',
    company: 'Acme Corp',
    fields_schema: [
      {
        label: 'First Name*',
        normalized_label: 'first name',
        field_type: 'text',
        step: 'My Information',
        is_required: true,
        options: [],
      },
      {
        label: 'Middle Name',
        normalized_label: 'middle name',
        field_type: 'text',
        step: 'My Information',
        is_required: false,
        options: [],
      },
      {
        label: 'Are you legally authorized to work in the United States?*',
        normalized_label: 'are you legally authorized to work in the united states',
        field_type: 'dropdown',
        step: 'Application Questions',
        is_required: true,
        options: ['Yes', 'No'],
      },
      {
        label: 'What is your desired salary?*',
        normalized_label: 'what is your desired salary',
        field_type: 'text',
        step: 'Application Questions',
        is_required: true,
        options: [],
      },
    ],
  };

  // Case 1: Client has all required fields resolved (Middle Name optional missing is allowed)
  const profileComplete = {
    _applyWizzId: 'AWL-TEST-1',
    personal: {
      first_name: 'Alice',
      last_name: 'Smith',
    },
    target_salary: '120000',
    work_auth: {
      authorized_us: 'Yes',
    },
    // middle name missing
  };

  console.log('\n--- Case 1: Client with 100% required answers ---');
  const res1 = await preResolveClientAnswersDetailed({
    jobUrl: 'https://test.myworkdayjobs.com/test/job/1',
    schema,
    profile: profileComplete,
  });

  console.log(`Client 1 result: isFullyAnswered=${res1.isFullyAnswered}, unansweredCount=${res1.unansweredCount}, status=${res1.status}`);
  console.log(`Unanswered Questions JSON:`, JSON.stringify(res1.unansweredQuestions, null, 2));

  assert.strictEqual(res1.isFullyAnswered, true, 'Case 1 should be fully answered');
  assert.strictEqual(res1.unansweredCount, 0, 'Case 1 unanswered count must be 0');
  assert.strictEqual(res1.status, 'ready_for_review', 'Case 1 status must be ready_for_review');
  assert.deepStrictEqual(res1.unansweredQuestions, [], 'Case 1 unanswered questions must be empty array');

  // Case 2: Client with missing required answers (salary and work authorization missing)
  const profileIncomplete = {
    _applyWizzId: 'AWL-TEST-2',
    firstName: 'Bob',
    // workAuthorization and desiredSalary missing
  };

  console.log('\n--- Case 2: Client with missing required answers ---');
  const res2 = await preResolveClientAnswersDetailed({
    jobUrl: 'https://test.myworkdayjobs.com/test/job/1',
    schema,
    profile: profileIncomplete,
  });

  console.log(`Client 2 result: isFullyAnswered=${res2.isFullyAnswered}, unansweredCount=${res2.unansweredCount}, status=${res2.status}`);
  console.log(`Unanswered Questions JSON:`, JSON.stringify(res2.unansweredQuestions, null, 2));

  assert.strictEqual(res2.isFullyAnswered, false, 'Case 2 should not be fully answered');
  assert.strictEqual(res2.unansweredCount >= 2, true, 'Case 2 must have at least 2 unanswered required questions');
  assert.strictEqual(res2.status, 'needs_answers', 'Case 2 status must be needs_answers');
  assert.strictEqual(Array.isArray(res2.unansweredQuestions), true, 'Case 2 unanswered questions must be an array');
  assert.strictEqual(res2.unansweredQuestions.length, res2.unansweredCount, 'unansweredQuestions length must match unansweredCount');

  for (const q of res2.unansweredQuestions) {
    assert.ok(q.question, 'Each unanswered question must have question label');
    assert.ok(q.field_type, 'Each unanswered question must have field_type');
    assert.ok(q.step, 'Each unanswered question must have step');
    assert.strictEqual(q.is_required, true, 'Only required questions should be in unansweredQuestions');
    assert.strictEqual(q.reason, 'missing_required_answer', 'Reason must be missing_required_answer');
  }

  console.log('\n✅ ALL ASSERTIONS PASSED! Status and unanswered_questions JSON rules verified successfully.');
}

testResolutionStatuses().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
