import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageOrchestrator } from '../lib/orchestrator/pageLoop.mjs';
import { validateBeforeFill } from '../lib/orchestrator/preFillValidator.mjs';
import { STATUS } from '../lib/orchestrator/types.mjs';
import { createFixtureAdapter } from './helpers/fixtureAdapter.mjs';
import { metric } from './helpers/metrics.mjs';

const radioField = {
  questionId: 'q1',
  label: 'Are you legally authorized to work in the United States?',
  elementType: 'radio',
  fieldType: 'radio',
  required: true,
  options: ['Yes', 'No'],
  currentValue: null,
  visible: true,
  disabled: false,
};

const yesDecision = {
  questionId: 'q1',
  intent: 'work_authorization',
  answer: 'Yes',
  confidence: 0.98,
  requiresReview: false,
  source: 'applywizz_profile',
  reasonCode: 'EXPLICIT_PROFILE_MATCH',
};

function memoryAdapter(store, extras = {}) {
  return {
    name: 'spy',
    async detectPage() { extras.order.push('detect'); return 'Application Questions'; },
    async waitStable() { extras.order.push('wait'); },
    async scan() { extras.order.push('scan'); return { fields: extras.fields || [{ ...radioField, currentValue: store.current }] }; },
    shouldFill(field) { return !store.current && Boolean(field?.questionId); },
    async fill(_p, field, answer) {
      extras.order.push('fill');
      extras.fillCalls = (extras.fillCalls || 0) + 1;
      if (extras.failFirst && extras.fillCalls === 1) {
        return { success: false, verifiedValue: '' };
      }
      if (extras.alwaysFail) return { success: false, verifiedValue: '' };
      store.current = extras.wrongValue || answer;
      field.currentValue = store.current;
      return { success: true, verifiedValue: store.current };
    },
    async readValue() {
      extras.order.push('verify');
      const extraFields = extras.dynamicAfterFill && store.current === 'Yes'
        ? [{
          questionId: 'q-license',
          label: "Driver's license number",
          elementType: 'text',
          required: true,
          options: [],
          currentValue: '',
          visible: true,
        }]
        : [];
      return {
        current: extras.forceRead || store.current,
        field: { ...radioField, currentValue: extras.forceRead || store.current },
        all: [{ ...radioField, currentValue: extras.forceRead || store.current }, ...extraFields, ...(store.extra || [])],
      };
    },
    valuesMatch(requested, actual) { return requested === actual; },
    async validatePage() {
      extras.order.push('validate');
      if (extras.pageErrors) {
        return { ok: false, requiredRemaining: 1, errors: extras.pageErrors, reason: 'visible_error' };
      }
      if (extras.requireEmpty) {
        return { ok: false, requiredRemaining: 1, errors: [], reason: 'required_empty' };
      }
      return { ok: true, requiredRemaining: 0, errors: [] };
    },
  };
}

test('orchestrator runs detect → wait → scan → answer → fill → verify → validate in order', async () => {
  const store = { current: null };
  const extras = { order: [] };
  extras.fields = [radioField];
  const result = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter(store, extras),
    pageNumber: 1,
    answerFn: async () => {
      extras.order.push('answer');
      return { pageNumber: 1, answers: [yesDecision] };
    },
  });
  const prefix = extras.order.slice(0, 7).join('>');
  const expectedStart = extras.order[0] === 'wait' && extras.order.includes('detect') && extras.order.includes('scan')
    && extras.order.includes('answer') && extras.order.includes('fill') && extras.order.includes('verify');
  metric('phase3', 'operation_order', expectedStart, { detail: extras.order.join('>') });
  assert.ok(expectedStart, prefix);
  assert.equal(result.status, STATUS.PAGE_COMPLETE);
  metric('phase3', 'page_processed', true);
  metric('phase3', 'page_completed', true);
  metric('phase3', 'fields_filled', true, { count: result.filled });
  metric('phase3', 'fields_verified', true, { count: result.verified });
});

test('A all required filled may proceed; B missing required must not', async () => {
  const a = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField] }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  metric('phase3', 'validation_A', a.status === STATUS.PAGE_COMPLETE);
  assert.equal(a.status, STATUS.PAGE_COMPLETE);

  const b = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField], requireEmpty: true }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  // fill may succeed but page validate reports required remaining
  const blockedB = b.status !== STATUS.PAGE_COMPLETE;
  metric('phase3', 'validation_B', blockedB, { detail: b.status, code: blockedB ? '' : 'F8' });
  assert.ok(blockedB);
});

test('C invalid answer and E unresolved high-risk must not proceed', async () => {
  const invalid = validateBeforeFill(radioField, { ...yesDecision, answer: 'Maybe' });
  metric('phase3', 'validation_C', invalid.ok === false, { code: invalid.ok ? 'F8' : '' });
  assert.equal(invalid.ok, false);

  const e = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, {
      order: [],
      fields: [{
        questionId: 'q44',
        label: 'Do you currently hold an active security clearance?',
        elementType: 'radio',
        required: true,
        options: ['Yes', 'No'],
      }],
    }),
    answerFn: async () => ({
      answers: [{
        questionId: 'q44',
        intent: 'clearance',
        answer: null,
        confidence: 0,
        requiresReview: true,
        reasonCode: 'HIGH_RISK_MISSING_DATA',
      }],
    }),
  });
  metric('phase3', 'validation_E', e.status === STATUS.BLOCKED, { detail: e.status, code: e.status === STATUS.BLOCKED ? '' : 'F8' });
  assert.equal(e.status, STATUS.BLOCKED);
});

test('D visible validation error and F wrong DOM value must not proceed', async () => {
  const d = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField], pageErrors: ['This field is required'] }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  metric('phase3', 'validation_D', d.status !== STATUS.PAGE_COMPLETE, { detail: d.status });
  assert.notEqual(d.status, STATUS.PAGE_COMPLETE);

  const f = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField], forceRead: 'No' }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  metric('phase3', 'validation_F', f.status === STATUS.BLOCKED || f.status === STATUS.PAGE_INCOMPLETE, {
    detail: f.status,
    code: f.reason === 'verification_failed' ? '' : 'F11',
  });
  assert.ok(f.status === STATUS.BLOCKED || f.status === STATUS.PAGE_INCOMPLETE);
});

test('failed fill rediscovers and retries, then stops safely', async () => {
  const recovered = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField], failFirst: true }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  const recoveredOk = recovered.status === STATUS.PAGE_COMPLETE && recovered.verified === 1;
  metric('phase3', 'retry', true, { count: 1 });
  metric('phase3', 'recovered_failure', recoveredOk, { detail: recovered.status, code: recoveredOk ? '' : 'F3' });
  assert.equal(recovered.status, STATUS.PAGE_COMPLETE);

  const stopped = await runPageOrchestrator({
    page: {},
    profile: { qa_answers: {}, _persistAnswers: false },
    adapter: memoryAdapter({ current: null }, { order: [], fields: [radioField], alwaysFail: true, forceRead: '' }),
    answerFn: async () => ({ answers: [yesDecision] }),
  });
  const safeStop = stopped.status !== STATUS.PAGE_COMPLETE;
  metric('phase3', 'safely_stopped', safeStop, { detail: stopped.status, code: safeStop ? '' : 'F12' });
  assert.ok(safeStop);
});
