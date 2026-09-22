import test from 'node:test';
import assert from 'node:assert/strict';
import { splitGivenFamilyName, normalizePersonalNames } from './personName.mjs';

test('family name is last word only; given is all before', () => {
  assert.deepEqual(splitGivenFamilyName('John Michael Smith'), {
    first_name: 'John Michael',
    last_name: 'Smith',
  });
  assert.deepEqual(splitGivenFamilyName('Ajith Chandra'), {
    first_name: 'Ajith',
    last_name: 'Chandra',
  });
  assert.deepEqual(splitGivenFamilyName('Madonna'), {
    first_name: 'Madonna',
    last_name: 'Madonna',
  });
});

test('normalizePersonalNames fixes wrong YAML split from full name', () => {
  const p = normalizePersonalNames({
    first_name: 'John',
    last_name: 'Michael Smith',
    full_name: 'John Michael Smith',
  });
  assert.equal(p.first_name, 'John Michael');
  assert.equal(p.last_name, 'Smith');
});
