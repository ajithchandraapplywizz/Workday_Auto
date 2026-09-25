import test from 'node:test';
import assert from 'node:assert/strict';

import { parseErrorFieldNames } from './workdayErrorRepair.mjs';

test('parseErrorFieldNames reads Degree from Ally-style banners', () => {
  const names = parseErrorFieldNames([
    'Errors FoundError-DegreeThe field Degree is required and must have a value.',
    'Error-DegreeThe field Degree is required and must have a value.',
  ]);
  assert.ok(names.some((n) => /^degree$/i.test(n)), `expected Degree in ${names.join(', ')}`);
});
