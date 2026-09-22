import { test, expect, describe, vi, beforeEach } from 'vitest';
import { askLlmFallback, resetLlmBudget } from './llmFallback.mjs';

// Mock the Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    Anthropic: class {
      constructor() {
        this.messages = {
          create: mockCreate
        };
      }
    }
  };
});

describe('llmFallback', () => {
  beforeEach(() => {
    resetLlmBudget();
    mockCreate.mockReset();
    process.env.LLM_MAX_CALLS_PER_RUN = '10';
  });

  test('rejects fake fact ids', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ answer: 'Yes', supporting_fact_ids: ['f2'], reason: 'test' }) }]
    });

    const field = { label: 'Question', controlType: 'text' };
    const facts = [{ id: 'f1', text: 'Some fact' }];
    const res = await askLlmFallback('c1', 't1', 'misc', field, [], facts);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/hallucinated fact ID/);
  });

  test('rejects null answers', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ answer: null, supporting_fact_ids: [], reason: 'Do not know' }) }]
    });

    const field = { label: 'Question', controlType: 'text' };
    const facts = [{ id: 'f1', text: 'Some fact' }];
    const res = await askLlmFallback('c1', 't1', 'misc', field, [], facts);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('Do not know');
  });

  test('rejects excluded categories', async () => {
    const field = { label: 'Sponsorship', controlType: 'radio' };
    const facts = [];
    const res = await askLlmFallback('c1', 't1', 'work_auth.sponsorship', field, [], facts);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Excluded category/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('respects budget cap', async () => {
    process.env.LLM_MAX_CALLS_PER_RUN = '1';
    
    mockCreate.mockResolvedValue({
      content: [{ text: JSON.stringify({ answer: 'A', supporting_fact_ids: [], reason: 'test' }) }]
    });

    const field = { label: 'Q', controlType: 'text' };
    const facts = [];
    
    const res1 = await askLlmFallback('c1', 't1', 'misc', field, [], facts);
    expect(res1.ok).toBe(true);

    const res2 = await askLlmFallback('c1', 't1', 'misc2', field, [], facts);
    expect(res2.ok).toBe(false);
    expect(res2.reason).toMatch(/budget cap exceeded/);
  });
});
