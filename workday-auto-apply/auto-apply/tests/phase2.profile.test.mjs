import test from 'node:test';
import assert from 'node:assert/strict';
import { mapApplyWizzToProfile, buildApplyWizzQaIndex } from '../lib/applyWizzClient.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';
import { loadMockApplyWizzPayload, buildMockHydratedProfile } from './helpers/mockProfile.mjs';
import { metric } from './helpers/metrics.mjs';

test('mock Apply Wizz payload is parsed and normalized without a network call', () => {
  const data = loadMockApplyWizzPayload();
  const overlay = mapApplyWizzToProfile(data.client, data.additional_information);
  const qa = buildApplyWizzQaIndex(data.client, data.additional_information);

  const fetched = Boolean(data.client.applywizz_id === 'TEST-000');
  const parsed = overlay.personal.first_name === 'Test' && overlay.personal.last_name === 'User';
  const normalized = overlay.work_auth.authorized_us === 'Yes'
    && overlay.education.university === 'Test University';
  const available = Boolean(qa['legally authorized to work'] || qa['authorized to work']);

  metric('phase2', 'profile_fetched', fetched);
  metric('phase2', 'profile_parsed', parsed, { code: parsed ? '' : 'F5' });
  metric('phase2', 'profile_normalized', normalized, { code: normalized ? '' : 'F5' });
  metric('phase2', 'profile_available', available, { code: available ? '' : 'F5' });

  assert.equal(overlay.personal.email, 'test.user@example.test');
  assert.equal(overlay.work_auth.sponsorship_needed, 'No');
  assert.equal(overlay.experience.years, '2');
  assert.equal(overlay.experience.current_title, 'Software Intern');
  assert.ok(available);
});

test('hydrated mock profile is usable by the answer engine', () => {
  const profile = buildMockHydratedProfile();
  const rec = resolveFieldWithoutLlm({
    questionId: 'q-auth',
    label: 'Are you legally authorized to work in the United States?',
    elementType: 'radio',
    fieldType: 'radio',
    options: ['Yes', 'No'],
    required: true,
  }, profile);
  const ok = rec?.answer === 'Yes' && rec.requiresReview === false;
  metric('phase2', 'profile_to_engine', ok, { code: ok ? '' : 'F5' });
  assert.equal(rec.answer, 'Yes');
  assert.equal(profile._applyWizzHydrated, true);
  assert.ok(profile.skills.includes('React'));
});
