import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPhoneRelatedField,
  isMandatoryField,
  shouldSkipOptionalFill,
  isSkippableUnimportantLabel,
  shouldIncludeInScan,
} from '../lib/scanFieldFilter.mjs';
import { mapLabelToProfileValue } from '../lib/planner.mjs';

test('isPhoneRelatedField identifies all phone-related labels and field IDs', () => {
  assert.equal(isPhoneRelatedField('Phone Number'), true);
  assert.equal(isPhoneRelatedField('phone number'), true);
  assert.equal(isPhoneRelatedField('Phone Device Type'), true);
  assert.equal(isPhoneRelatedField('phone type'), true);
  assert.equal(isPhoneRelatedField('Device Type'), true);
  // Country Phone Code is strictly no-touch / protected from dropdown clicking
  assert.equal(isPhoneRelatedField('Country / Territory Phone Code'), false);
  assert.equal(isPhoneRelatedField('Country Phone Code'), false);
  assert.equal(isPhoneRelatedField('Mobile Phone'), true);
  assert.equal(isPhoneRelatedField('Mobile Number'), true);
  assert.equal(isPhoneRelatedField('Mobile'), true);
  assert.equal(isPhoneRelatedField('Telephone'), true);
  assert.equal(isPhoneRelatedField('cell phone'), true);
  assert.equal(isPhoneRelatedField('', { id: 'phoneNumber--phoneNumber' }), true);
  assert.equal(isPhoneRelatedField('', { automationId: 'phoneNumber--phoneType' }), true);

  // Extension is not mandatory phone number
  assert.equal(isPhoneRelatedField('Phone Extension'), false);
  assert.equal(isPhoneRelatedField('Extension'), false);
  // Non-phone fields
  assert.equal(isPhoneRelatedField('First Name'), false);
  assert.equal(isPhoneRelatedField('Email Address'), false);
  assert.equal(isPhoneRelatedField('How Did You Hear About Us?'), false);
});

test('isMandatoryField strictly treats phone fields as mandatory regardless of required flag or asterisks', () => {
  // Even when required is false or missing, and no asterisk is present:
  assert.equal(isMandatoryField('Phone Number', { required: false }), true);
  assert.equal(isMandatoryField('phone number', {}), true);
  assert.equal(isMandatoryField('Phone Device Type', { required: false }), true);
  assert.equal(isMandatoryField('Mobile Phone', {}), true);
});

test('shouldSkipOptionalFill and isSkippableUnimportantLabel NEVER skip phone fields', () => {
  // Should never skip optional fill for phone
  assert.equal(shouldSkipOptionalFill('Phone Number', { required: false }, {}), false);
  assert.equal(shouldSkipOptionalFill('Phone Device Type', { required: false }, {}), false);

  // Should never be considered skippable / unimportant
  assert.equal(isSkippableUnimportantLabel('Phone Number', { required: false }), false);
  assert.equal(isSkippableUnimportantLabel('Phone Device Type', { required: false }), false);
  assert.equal(isSkippableUnimportantLabel('Mobile Phone', {}), false);

  // Must always be included in scan
  assert.equal(shouldIncludeInScan('Phone Number', { required: false }), true);
  assert.equal(shouldIncludeInScan('Phone Device Type', { required: false }), true);
  // Country Phone Code is skipped from scan to preserve no-touch guardrail
  assert.equal(shouldIncludeInScan('Country Phone Code', { required: false }), false);
});

test('mapLabelToProfileValue resolves phone number and device type from profile', () => {
  const profile = {
    personal: {
      phone: '5102662606',
      phone_device_type: 'Mobile',
      country_phone_code: 'United States of America (+1)',
    },
  };

  assert.equal(mapLabelToProfileValue('Phone Number', profile), '5102662606');
  assert.equal(mapLabelToProfileValue('phone number', profile), '5102662606');
  assert.equal(mapLabelToProfileValue('Phone Device Type', profile), 'Mobile');
  assert.equal(mapLabelToProfileValue('Phone Type', profile), 'Mobile');
});

test('No-Touch Country Code policy strictly prevents interaction and clicking via custom dropdown & field resolution', async () => {
  const { isCountryPhoneCodeField } = await import('../lib/scanFieldFilter.mjs');
  const { fillWorkdayCustomDropdown } = await import('../lib/interaction/workdayCustomDropdown.mjs');
  const { findField } = await import('../lib/fields.mjs');

  // 1. Label variants correctly detected as protected country phone code
  assert.equal(isCountryPhoneCodeField('Country / Territory Phone Code'), true);
  assert.equal(isCountryPhoneCodeField('Country Phone Code'), true);
  assert.equal(isCountryPhoneCodeField('Country Code'), true);
  assert.equal(isCountryPhoneCodeField('Country Dialing Code'), true);
  assert.equal(isCountryPhoneCodeField('United States of America (+1)'), true);
  assert.equal(isCountryPhoneCodeField('', { id: 'countryPhoneCode' }), true);
  assert.equal(isCountryPhoneCodeField('', { automationId: 'country-phone-code' }), true);

  // 2. findField immediately rejects country phone code and returns null
  const rejectedField = await findField({}, { label: 'Country Phone Code', automationId: 'countryPhoneCode' });
  assert.equal(rejectedField, null);

  // 3. fillWorkdayCustomDropdown immediately skips without clicking
  const customResult = await fillWorkdayCustomDropdown({}, { label: 'Country / Territory Phone Code' }, 'United States (+1)');
  assert.equal(customResult.success, true);
  assert.equal(customResult.widgetKind, 'skipped');
});

test('Phone number recovery parses authentic resume and updates profile', async () => {
  const { extractContactFromResumeText } = await import('../lib/clientContact.mjs');
  const sampleResumeText = `
    VADIRAJA K
    Cincinnati, OH | +1 (513) 799-3131 | vadiraja.korlahalli@applywizard.ai
    DevOps Engineer with 4+ years experience
  `;
  const contact = extractContactFromResumeText(sampleResumeText);
  const cleanDigits = String(contact.phone || '').replace(/\D/g, '').slice(-10);
  assert.equal(cleanDigits, '5137993131');
});
