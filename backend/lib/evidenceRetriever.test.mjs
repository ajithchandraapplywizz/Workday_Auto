import { test, expect, describe } from 'vitest';
import { retrieveEvidence } from './evidenceRetriever.mjs';

const mockDb = {
  from: (table) => ({
    select: () => ({
      eq: (field, val) => ({
        eq: (f2, v2) => ({
          eq: (f3, v3) => ({
            single: async () => {
              if (table === 'qa_answers' && val === 'candidate-1' && v2 === 'tenant-A') {
                return { data: { answer_value: 'QA Answer', source: 'qa_cache' }, error: null };
              }
              if (table === 'qa_answers' && val === 'candidate-1' && v2 === 'tenant-B') {
                // Simulating tenant isolation - no QA answer for Tenant B
                return { data: null, error: { code: 'PGRST116' } };
              }
              return { data: null, error: { code: 'PGRST116' } };
            }
          }),
          order: () => ({
            limit: () => ({
              single: async () => {
                if (table === 'client_facts' && val === 'candidate-1') {
                  return { data: { value: JSON.stringify({ text: 'Resume Answer' }), source: 'resume', evidence_text: 'fact evidence' }, error: null };
                }
                return { data: null, error: { code: 'PGRST116' } };
              }
            })
          })
        })
      })
    })
  })
};

const errorDb = {
  from: (table) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { code: '500', message: 'DB Down' } })
          }),
          order: () => ({
            limit: () => ({
              single: async () => ({ data: null, error: { code: '500', message: 'DB Down' } })
            })
          })
        })
      })
    })
  })
};

describe('evidenceRetriever', () => {
  test('tenant isolation: does not bleed QA answers across tenants', async () => {
    // Has QA answer in Tenant A
    const resA = await retrieveEvidence('candidate-1', 'tenant-A', 'education.degree', { db: mockDb });
    expect(resA.status).toBe('found');
    expect(resA.value).toBe('QA Answer');
    expect(resA.tier).toBe(1);

    // Falls through QA cache for Tenant B and hits Tier 3 (resume)
    const resB = await retrieveEvidence('candidate-1', 'tenant-B', 'education.degree', { db: mockDb });
    expect(resB.status).toBe('found');
    expect(resB.value).toBe('Resume Answer');
    expect(resB.tier).toBe(3);
  });

  test('tier order: QA cache (Tier 1) overrides Resume facts (Tier 3)', async () => {
    const res = await retrieveEvidence('candidate-1', 'tenant-A', 'education.degree', { db: mockDb });
    expect(res.status).toBe('found');
    expect(res.tier).toBe(1);
    expect(res.value).toBe('QA Answer');
  });

  test('unavailable is distinct from no_evidence', async () => {
    // 1. Missing db/credentials completely
    const oldUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = '';
    const res1 = await retrieveEvidence('candidate-1', 'tenant-A', 'education.degree');
    process.env.SUPABASE_URL = oldUrl;
    expect(res1.status).toBe('unavailable');
    expect(res1.value).toBeUndefined();

    // 2. Query error
    const res2 = await retrieveEvidence('candidate-1', 'tenant-A', 'education.degree', { db: errorDb });
    expect(res2.status).toBe('unavailable');

    // 3. True no evidence
    const res3 = await retrieveEvidence('candidate-unknown', 'tenant-A', 'education.degree', { db: mockDb });
    expect(res3.status).toBe('no_evidence');
  });
});
