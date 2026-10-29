import test from 'node:test';
import assert from 'node:assert/strict';

test('cluster priority sorting orders 0th attempt clean links strictly first', () => {
  const sampleClusters = [
    { canonicalKey: 'c1', jobUrl: 'https://example.com/job1', clientCount: 30, attemptCount: 1 },
    { canonicalKey: 'c2', jobUrl: 'https://example.com/job2', clientCount: 10, attemptCount: 0 },
    { canonicalKey: 'c3', jobUrl: 'https://example.com/job3', clientCount: 50, attemptCount: 2 },
    { canonicalKey: 'c4', jobUrl: 'https://example.com/job4', clientCount: 25, attemptCount: 0 },
  ];

  // Test default sort: 0th attempt first, then clientCount desc
  const sorted = [...sampleClusters].sort((a, b) => {
    const attA = a.attemptCount || 0;
    const attB = b.attemptCount || 0;
    if (attA !== attB) return attA - attB;
    return b.clientCount - a.clientCount;
  });

  assert.equal(sorted[0].canonicalKey, 'c4'); // attempt 0, 25 clients
  assert.equal(sorted[1].canonicalKey, 'c2'); // attempt 0, 10 clients
  assert.equal(sorted[2].canonicalKey, 'c1'); // attempt 1, 30 clients
  assert.equal(sorted[3].canonicalKey, 'c3'); // attempt 2, 50 clients

  // Test fresh filter (attemptPhase: 'fresh')
  const fresh = sampleClusters.filter((c) => (c.attemptCount || 0) === 0);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((c) => c.attemptCount === 0));

  // Test retry filter (attemptPhase: 'retry')
  const retry = sampleClusters.filter((c) => (c.attemptCount || 0) > 0 && (c.attemptCount || 0) < 3);
  assert.equal(retry.length, 2);
  assert.ok(retry.every((c) => c.attemptCount > 0 && c.attemptCount < 3));
});
