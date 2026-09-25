import { test, expect, describe, beforeEach } from 'vitest';
import { validateAnswer, resetLoopGuard } from './answerValidator.mjs';

describe('answerValidator', () => {
  beforeEach(() => {
    resetLoopGuard();
  });

  test('validator rejecting unsourced answers', () => {
    const field = { label: 'Field' };
    const answerObj = { value: 'Fabricated', source: null }; // No source
    const res = validateAnswer(answerObj, field, [], {});
    expect(res.ok).toBe(false);
    expect(res.reasons[0]).toMatch(/No source cited/);
  });

  test('the retry cap (loop guard)', () => {
    const field = { questionId: 'q123', controlType: 'text' };
    const answerObj = { value: null, source: 'resume' }; // null fails validation
    
    // First attempt fails, bumps loop guard count
    const res1 = validateAnswer(answerObj, field, [], {});
    expect(res1.ok).toBe(false);

    // Second attempt fails, bumps loop guard count
    const res2 = validateAnswer(answerObj, field, [], {});
    expect(res2.ok).toBe(false);

    // Third attempt fails due to loop guard limit (MAX_RETRIES = 2)
    const res3 = validateAnswer(answerObj, field, [], {});
    expect(res3.ok).toBe(false);
    expect(res3.reasons[0]).toMatch(/Loop guard triggered/);
  });

  test('dropdown snapping', () => {
    const field = { label: 'Field', controlType: 'dropdown' };
    const answerObj = { value: 'Bachelors', source: 'resume' };
    const liveOptions = ['Bachelor of Science', 'Master of Science'];
    
    const res = validateAnswer(answerObj, field, liveOptions, {});
    expect(res.ok).toBe(true);
    expect(res.adjustedValue).toBe('Bachelor of Science');
  });
});
