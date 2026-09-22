import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSupabaseAnswerSync,
  isSupabaseConfigured,
  loadSupabaseAnswers,
  upsertSupabaseApplication,
} from './supabaseClient.mjs';
import { normalizeJobUrl, normalizeApplicationStatus } from './applicationHistory.mjs';
import { resolveClientAnswer, peekClientAnswer } from './clientAnswer.mjs';
import { resolveVeteranVoluntaryAnswer } from './workdayQuestionFill.mjs';
import { matchDemographicOption } from './interaction/workdayCustomDropdown.mjs';

test('Tier 1: lookupSupabaseAnswerSync matches exact normalized labels', () => {
  const profile = {
    _supabaseQa: {
      'veteran status': 'I am not a protected veteran',
      'desired salary': '95000',
    },
  };

  const hit = lookupSupabaseAnswerSync('Veteran Status', profile);
  assert.ok(hit);
  assert.equal(hit.answer, 'I am not a protected veteran');
  assert.match(hit.source, /supabase/);
});

test('Tier 1: lookupSupabaseAnswerSync concept matches veteran questions and aligns options', () => {
  const profile = {
    _supabaseQa: {
      'veteran status': 'I am not a protected veteran',
    },
  };

  const longLabel = 'Please select the veteran status which most accurately describes how you identify yourself.';
  const hit = lookupSupabaseAnswerSync(longLabel, profile, {
    options: ['I am not a protected veteran', 'I identify as a protected veteran', 'Decline to state'],
  });
  assert.ok(hit);
  assert.equal(hit.answer, 'I am not a protected veteran');

  // Align when page options only offer "I am not a veteran"
  const hitFallback = lookupSupabaseAnswerSync(longLabel, profile, {
    options: ['I am not a veteran', 'I identify as one or more classifications of protected veteran'],
  });
  assert.ok(hitFallback);
  assert.equal(hitFallback.answer, 'I am not a veteran');
});

test('matchDemographicOption bidirectional fallback between not_protected and not_veteran', () => {
  const options = ['I am not a veteran', 'I identify as a protected veteran', 'Decline'];
  assert.equal(matchDemographicOption('I am not a protected veteran', options), 'I am not a veteran');

  const optionsProtected = ['I am not a protected veteran', 'I identify as a protected veteran', 'Decline'];
  assert.equal(matchDemographicOption('I am not a veteran', optionsProtected), 'I am not a protected veteran');
});

test('resolveVeteranVoluntaryAnswer uses Supabase answers first', () => {
  const profile = {
    _supabaseQa: {
      'veteran status': 'I am not a protected veteran',
    },
    eeo: {},
    _applyWizzQa: {},
  };
  assert.equal(resolveVeteranVoluntaryAnswer(profile), 'I am not a protected veteran');
});

test('3-tier precedence: Supabase (Tier 1) beats ApplyWizz API (Tier 2) and Resume (Tier 3)', async () => {
  const profile = {
    _supabaseQa: {
      'what is your target compensation': '110000',
    },
    _applyWizzQa: {
      'what is your target compensation': '90000',
    },
    compensation: '80000',
    experience: { years: '4' },
    skills: ['Python'],
  };

  const hit = await resolveClientAnswer({
    label: 'What is your target compensation?',
    fieldType: 'input',
  }, profile);

  assert.ok(hit);
  assert.equal(hit.answer, '110000');
  assert.match(hit.source, /supabase/);
});

test('3-tier precedence: ApplyWizz API (Tier 2) is used when Supabase has no record', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    _applyWizzQa: {
      'are you willing to travel': 'Yes, up to 25%',
    },
    experience: { years: '4' },
    skills: ['Python'],
  };

  const hit = await resolveClientAnswer({
    label: 'Are you willing to travel?',
    fieldType: 'input',
  }, profile);

  assert.ok(hit);
  assert.equal(hit.answer, 'Yes, up to 25%');
  assert.match(hit.source, /applywizz/);
});

test('3-tier precedence: Resume (Tier 3) is used when Supabase and API have no record', async () => {
  const profile = {
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    _applyWizzQa: {},
    experience: {
      years: '5',
      current_title: 'Senior Cloud Engineer',
    },
    skills: ['Kubernetes', 'Docker'],
  };

  const hit = await resolveClientAnswer({
    label: 'How many years of experience do you have with Kubernetes?',
    fieldType: 'input',
  }, profile);

  assert.ok(hit);
  assert.equal(hit.answer, '5');
  assert.match(hit.source, /experience|resume/);
});

test('normalizeJobUrl strips application step subpaths and percent-encoded commas', () => {
  const dirty1 = 'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/Dallas%2C-Texas/Dev_123/apply/applyManually';
  assert.equal(normalizeJobUrl(dirty1), 'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/Dallas,-Texas/Dev_123');

  const dirty2 = 'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/Boston/Dev_123/applicationSubmitted';
  assert.equal(normalizeJobUrl(dirty2), 'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/Boston/Dev_123');

  const clean = 'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/Boston/Dev_123';
  assert.equal(normalizeJobUrl(clean), clean);
});

test('normalizeApplicationStatus maps run states to public.applications check constraint', () => {
  assert.equal(normalizeApplicationStatus('submitted'), 'submitted');
  assert.equal(normalizeApplicationStatus('ready_for_review'), 'in_progress');
  assert.equal(normalizeApplicationStatus('needs_manual_verification'), 'in_progress');
  assert.equal(normalizeApplicationStatus('incomplete'), 'failed');
  assert.equal(normalizeApplicationStatus('error'), 'failed');
  assert.equal(normalizeApplicationStatus('review_declined'), 'skipped');
  assert.equal(normalizeApplicationStatus('skipped'), 'skipped');
  assert.equal(normalizeApplicationStatus(undefined, { tenantProgress: true }), 'in_progress');
  assert.equal(normalizeApplicationStatus(undefined, { success: true }), 'in_progress');
  assert.equal(normalizeApplicationStatus(), 'started');
});

test('upsertSupabaseApplication handles submission and updates status dynamically', async () => {
  if (!isSupabaseConfigured()) return;
  const ok = await upsertSupabaseApplication({
    applywizzId: 'AWL-34133',
    jobUrl: 'https://mfs.wd1.myworkdayjobs.com/en-US/MFS-Careers/job/Boston/Sr-Product-Owner_MFS-231909-1',
    company: 'MFS Investment Management',
    roleTitle: 'Sr Product Owner',
    status: 'submitted',
  });
  assert.equal(ok, true);
});

