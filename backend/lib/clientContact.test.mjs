import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPlainUsPhone,
  extractContactFromResumeText,
  US_COUNTRY_NAME,
} from './clientContact.mjs';

test('formatPlainUsPhone strips formatting', () => {
  assert.equal(formatPlainUsPhone('(512) 555-0199'), '5125550199');
  assert.equal(formatPlainUsPhone('+1 (512) 555-0199'), '5125550199');
});

test('extractContactFromResumeText — Boston, MA resolves to United States and +1', () => {
  const text = `
Alice Walker
Boston, MA
Phone: (617) 555-0123
Email: alice@example.com
`;
  const c = extractContactFromResumeText(text);
  assert.equal(c.city, 'Boston');
  assert.equal(c.state, 'MA');
  assert.equal(c.country, 'United States of America');
  assert.equal(c.country_phone_code, 'United States of America (+1)');
});

test('extractContactFromResumeText — St. Louis, MO resolves to United States and +1', () => {
  const text = `
Bob Miller
St. Louis, MO
Phone: (314) 555-0456
Email: bob@example.com
`;
  const c = extractContactFromResumeText(text);
  assert.equal(c.city, 'St. Louis');
  assert.equal(c.state, 'MO');
  assert.equal(c.country, 'United States of America');
  assert.equal(c.country_phone_code, 'United States of America (+1)');
});

test('extractContactFromResumeText — Hyderabad, Telangana resolves to India and +91', () => {
  const text = `
Ravi Kumar
Hyderabad, Telangana
Phone: +91 9876543210
Email: ravi@example.com
`;
  const c = extractContactFromResumeText(text);
  assert.equal(c.city, 'Hyderabad');
  assert.equal(c.state, 'Telangana');
  assert.equal(c.country, 'India');
  assert.equal(c.country_phone_code, 'India (+91)');
});

