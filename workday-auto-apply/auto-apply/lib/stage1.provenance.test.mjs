import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyProvenance, isSensitiveField } from './provenanceGate.mjs';
import { matchOptionSafely } from './interaction/selectVerified.mjs';
import { makeGuard } from './loopGuard.mjs';

test('provenance gate allows authorized sources and blocks ungrounded defaults', () => {
  // Allowed
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'supabase_exact' }).ok, true);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'supabase_fuzzy' }).ok, true);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'crm' }).ok, true);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'resume' }).ok, true);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'llm_live_options' }).ok, true);

  // Blocked
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'sensitive_safe' }).ok, false);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'profile_fallback' }).ok, false);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'workday_default' }).ok, false);
  assert.equal(verifyProvenance({ label: 'test' }, { source: 'static_default' }).ok, false);
});

test('provenance gate strictly forbids LLM for legal, sponsorship, work auth, and salary', () => {
  assert.equal(verifyProvenance({ label: 'Are you authorized to work in the US?' }, { source: 'llm', intent: 'work_authorization' }).ok, false);
  assert.equal(verifyProvenance({ label: 'Will you require sponsorship?' }, { source: 'llm_live_options', intent: 'sponsorship' }).ok, false);
  assert.equal(verifyProvenance({ label: 'What is your gender?' }, { source: 'llm', intent: 'eeo_gender' }).ok, false);
  assert.equal(verifyProvenance({ label: 'Desired Salary' }, { source: 'llm', intent: 'salary' }).ok, false);
});

test('matchOptionSafely forbids fuzzy matching across negation boundaries', () => {
  const options = ['I require sponsorship', 'I do not require sponsorship'];
  
  // Exact match matches
  assert.equal(matchOptionSafely('I do not require sponsorship', options).match, 'I do not require sponsorship');
  assert.equal(matchOptionSafely('I require sponsorship', options).match, 'I require sponsorship');

  // "I require sponsorship" must NEVER match "I do not require sponsorship"
  const crossMatch = matchOptionSafely('I require visa sponsorship', ['I do not require sponsorship']);
  assert.equal(crossMatch.match, null);
  assert.equal(crossMatch.reason, 'no_safe_option_match');

  const negCross = matchOptionSafely('I do not require sponsorship', ['I require sponsorship']);
  assert.equal(negCross.match, null);
  assert.equal(negCross.reason, 'negation_requires_exact_match');
});

test('matchOptionSafely supports synonyms and restricts prefix matching to unique unambiguous hits', () => {
  const ynOptions = ['Yes', 'No'];
  assert.equal(matchOptionSafely('True', ynOptions).match, 'Yes');
  assert.equal(matchOptionSafely('Y', ynOptions).match, 'Yes');
  assert.equal(matchOptionSafely('False', ynOptions).match, 'No');

  const ambiguous = ['Bachelor of Science', 'Bachelor of Arts'];
  assert.equal(matchOptionSafely('Bachelor', ambiguous).match, null);
  assert.equal(matchOptionSafely('Bachelor', ambiguous).reason, 'ambiguous_prefix_match');

  const unique = ['Master of Science in Computer Science', 'High School'];
  assert.equal(matchOptionSafely('Master of Science', unique).match, 'Master of Science in Computer Science');
});

test('makeGuard enforces per-field attempt limits and prevents infinite loops', () => {
  const guard = makeGuard({ maxAttemptsPerField: 2, maxIterationsPerPage: 8, maxStallCycles: 3 });
  const field = { label: 'Sponsorship', questionId: 'q-sponsorship' };

  // Attempt 1
  const a1 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a1.count, 1);
  assert.equal(a1.exceeded, false);

  // Attempt 2
  const a2 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a2.count, 2);
  assert.equal(a2.exceeded, false);

  // Attempt 3 -> Exceeded
  const a3 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a3.count, 3);
  assert.equal(a3.exceeded, true);
  assert.equal(guard.isExceeded(field, 'Yes', 0), true);

  // Cycle tracking
  const c1 = guard.recordCycle(0);
  assert.equal(c1.cyclesWithoutProgress, 1);
  assert.equal(c1.stalled, false);

  guard.recordCycle(0);
  const c3 = guard.recordCycle(0);
  assert.equal(c3.stalled, true);
  assert.equal(c3.shouldAbort, true);
});

// ─── Item 2 proof tests ──────────────────────────────────────────────────────

import { mapLabelToProfileValue } from './planner.mjs';
import { lookupDefaultAnswer } from './workdayDefaults.mjs';

test('_dynamic.today: mapLabelToProfileValue returns available_to_start from profile, not today', () => {
  // Profile has a stored start date — it must win over today's date.
  const profile = {
    experience: { available_to_start: '09/20/2026', start_date: null },
    personal: {},
  };

  const resultAvail = mapLabelToProfileValue('When are you available to start?', profile);
  assert.equal(resultAvail, '09/20/2026', 'available_to_start must override _dynamic.today');

  const resultDesired = mapLabelToProfileValue('Desired start date', profile);
  assert.equal(resultDesired, '09/20/2026', 'experience.start_date fallback works too');

  // When profile has NO date, mapLabelToProfileValue should return today's date (MM/DD/YYYY).
  const noDateProfile = { experience: {}, personal: {} };
  const fallback = mapLabelToProfileValue('When are you available to start?', noDateProfile);
  assert.match(String(fallback), /^\d{2}\/\d{2}\/\d{4}$/, 'today fallback must still be MM/DD/YYYY');
});

test('lookupDefaultAnswer returns null for high-trust labels (Item 2 guard)', () => {
  // These must NOT be answered by a hardcoded default — they must go through resolveField.
  const highTrust = [
    'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?',
    'Do you possess a high school diploma, G.E.D. or equivalent from an accredited institution?',
    'Do you have relatives who work for our company?',
    'Minimum educational requirements',
    'Availability/Start Date:*',
    'When are you available to start?',
    'Desired start date',
  ];

  for (const label of highTrust) {
    const result = lookupDefaultAnswer(label);
    assert.equal(
      result,
      null,
      `lookupDefaultAnswer must return null for high-trust label: "${label}" — got: ${JSON.stringify(result)}`
    );
  }
});

test('Item 3: guard key = controlId + normalized label (no answer text), cap is 2, 3rd attempt refused', () => {
  const guard = makeGuard({ maxAttemptsPerField: 2 });
  const field = {
    label: 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?',
    questionId: 'q-sponsorship',
  };

  // Check key format: must be controlId + normalized label, must NOT contain the answer "Yes" or "No"
  const keyYes = guard.makeKey(field, 'Yes', 1);
  const keyNo = guard.makeKey(field, 'No', 1);
  assert.equal(keyYes, keyNo, 'Guard key must not depend on or embed the answer text');
  assert.equal(keyYes.includes('Yes'), false, 'Guard key must not contain answer "Yes"');
  assert.equal(keyYes.includes('No'), false, 'Guard key must not contain answer "No"');
  assert.equal(keyYes.startsWith('q-sponsorship_'), true, 'Guard key must start with controlId');

  // Attempt 1: allowed
  assert.equal(guard.isExceeded(field, 'Yes', 0), false, 'Attempt 1 should not be exceeded');
  const a1 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a1.count, 1);
  assert.equal(a1.exceeded, false, 'Attempt 1 must not be exceeded');

  // Attempt 2: allowed
  assert.equal(guard.isExceeded(field, 'Yes', 0), false, 'Attempt 2 should not be exceeded');
  const a2 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a2.count, 2);
  assert.equal(a2.exceeded, false, 'Attempt 2 is allowed (cap is 2)');

  // Attempt 3: REFUSED (isExceeded is true, recordAttempt reports exceeded)
  assert.equal(guard.isExceeded(field, 'Yes', 0), true, '3rd attempt must be refused (isExceeded = true)');
  const a3 = guard.recordAttempt(field, 'Yes', 0);
  assert.equal(a3.count, 3);
  assert.equal(a3.exceeded, true, '3rd attempt must be marked exceeded');
});

test('Item 5: options-membership gate enforced across all tiers before clicking', async () => {
  const { validateBeforeFill } = await import('./orchestrator/preFillValidator.mjs');
  const { fillCombobox } = await import('./interaction/combobox.mjs');
  const { fillRadio } = await import('./interaction/radio.mjs');
  const { fillSelect } = await import('./interaction/select.mjs');

  const dropdownField = {
    questionId: 'q-dropdown',
    label: 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?',
    elementType: 'combobox',
    fieldType: 'dropdown',
    options: ['Yes', 'No'],
    required: true,
  };

  // Tier 1: validateBeforeFill pre-fill gate rejects invalid option
  const invalidDecision = {
    questionId: 'q-dropdown',
    answer: 'Maybe',
    confidence: 0.95,
    source: 'applywizz_profile',
    reasonCode: 'EXPLICIT_PROFILE_MATCH',
  };
  const gateResult = validateBeforeFill(dropdownField, invalidDecision);
  assert.equal(gateResult.ok, false, 'Pre-fill gate must reject answer not in options');
  assert.equal(gateResult.requiresReview, true, 'Rejection must require review');

  // Tier 2: fillCombobox handler rejects before clicking
  const comboboxResult = await fillCombobox({}, dropdownField, 'Maybe');
  assert.equal(comboboxResult.success, false, 'fillCombobox must fail when answer not in options');
  assert.match(comboboxResult.reason, /option_not_in_list/);

  // Tier 3: fillRadio handler rejects before clicking
  const radioField = {
    questionId: 'q-radio',
    label: 'Do you have relatives who work for our company?',
    elementType: 'radio',
    fieldType: 'radio',
    options: ['Yes', 'No'],
    required: true,
  };
  const radioResult = await fillRadio({}, radioField, 'Unknown Option');
  assert.equal(radioResult.success, false, 'fillRadio must fail when answer not in options');
  assert.match(radioResult.reason, /radio_option_not_found/);

  // Tier 4: fillSelect handler rejects before clicking
  const selectField = {
    questionId: 'q-select',
    label: 'Highest Education Completed',
    elementType: 'select',
    fieldType: 'select',
    options: ['High School Diploma', "Bachelor's Degree", "Master's Degree"],
    required: true,
  };
  const selectResult = await fillSelect({}, selectField, 'Doctorate / PhD');
  assert.equal(selectResult.success, false, 'fillSelect must fail when answer not in options');
  assert.match(selectResult.reason, /select_option_not_found/);

  // Tier 5: matchOptionSafely strictly blocks negation cross-matching
  const negationMatch = matchOptionSafely('Yes, I require sponsorship', [
    'I do not require sponsorship now or in the future',
    'No sponsorship needed',
  ]);
  assert.equal(negationMatch.match, null, 'Must never match across negation boundaries');
});


