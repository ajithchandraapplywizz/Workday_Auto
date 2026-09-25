import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeterministically,
  tokenSetRatio,
  CANONICAL_BUCKETS,
  SHORTCUT_CANDIDATES,
} from '../scripts/classifyDegrees.mjs';
import { resolveDynamicAnswer } from '../lib/questionEngine/pageAnswerEngine.mjs';

test('deterministic degree classification handles standard cases', () => {
  assert.equal(classifyDeterministically('Master of Science in Data Analytics'), 'Master of Science');
  assert.equal(classifyDeterministically('MS in Computer Science'), 'Master of Science');
  assert.equal(classifyDeterministically('M.S. in Software Engineering'), 'Master of Science');
  assert.equal(classifyDeterministically('Bachelor of Technology in Computer Science'), 'Bachelor of Technology');
  assert.equal(classifyDeterministically('B.Tech in ECE'), 'Bachelor of Technology');
  assert.equal(classifyDeterministically('BTech in Information Technology'), 'Bachelor of Technology');
  assert.equal(classifyDeterministically('Master of Biotechnology'), 'Master of Biotechnology');
  assert.equal(classifyDeterministically('M.Biotech'), 'Master of Biotechnology');
});

test('deterministic degree classification returns null for non-target degrees', () => {
  assert.equal(classifyDeterministically('Bachelor of Arts in English'), null);
  assert.equal(classifyDeterministically('Doctor of Philosophy in Physics'), null);
  assert.equal(classifyDeterministically('MBA in Finance'), null);
  assert.equal(classifyDeterministically('High School Diploma'), null);
  assert.equal(classifyDeterministically(''), null);
});

test('canonical buckets and shortcut candidates structure is correct', () => {
  assert.deepEqual(CANONICAL_BUCKETS, [
    'Master of Science',
    'Bachelor of Technology',
    'Master of Biotechnology',
  ]);
  assert.deepEqual(SHORTCUT_CANDIDATES['Master of Science'], ['Master of Science', 'MS', 'M.S.']);
  assert.deepEqual(SHORTCUT_CANDIDATES['Bachelor of Technology'], ['Bachelor of Technology', 'B.Tech', 'BTech']);
  assert.deepEqual(SHORTCUT_CANDIDATES['Master of Biotechnology'], ['Master of Biotechnology', 'M.Biotech', 'MSBiotech']);
});

test('Layer 4 fallback returns review when live options cannot be matched without LLM', async () => {
  const field = {
    label: 'Degree Level',
    fieldType: 'dropdown',
    required: true,
    options: ['High School', 'Associate Degree', 'Doctorate'],
  };
  const profile = {
    _applyWizzId: 'TEST-123',
    _applyWizzHydrated: true,
    _supabaseHydrated: true,
    _supabaseQa: {},
    _degreeClassification: {
      canonical_degree: 'Master of Science',
    },
  };
  const result = await resolveDynamicAnswer(field, profile, { allowLlm: false });
  assert.ok(result?.requiresReview, 'Must require review when options do not match and LLM is disabled');
  assert.equal(result?.reasonCode, 'NO_VALID_OPTION');
});
