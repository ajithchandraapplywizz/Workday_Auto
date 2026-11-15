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
  assert.equal(isPhoneRelatedField('Country / Territory Phone Code'), true);
  assert.equal(isPhoneRelatedField('Country Phone Code'), true);
  assert.equal(isPhoneRelatedField('Mobile Phone'), true);
  assert.equal(isPhoneRelatedField('Mobile Number'), true);
  assert.equal(isPhoneRelatedField('Mobile'), true);
  assert.equal(isPhoneRelatedField('Telephone'), true);
  assert.equal(isPhoneRelatedField('cell phone'), true);
  assert.equal(isPhoneRelatedField('', { id: 'phoneNumber--phoneNumber' }), true);
  assert.equal(isPhoneRelatedField('', { automationId: 'phoneNumber--phoneType' }), true);
  assert.equal(isPhoneRelatedField('', { name: 'countryPhoneCode' }), true);

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
  assert.equal(isMandatoryField('Country / Territory Phone Code', { required: false }), true);
  assert.equal(isMandatoryField('Mobile Phone', {}), true);
});

test('shouldSkipOptionalFill and isSkippableUnimportantLabel NEVER skip phone fields', () => {
  // Should never skip optional fill for phone
  assert.equal(shouldSkipOptionalFill('Phone Number', { required: false }, {}), false);
  assert.equal(shouldSkipOptionalFill('Phone Device Type', { required: false }, {}), false);
  assert.equal(shouldSkipOptionalFill('Country Phone Code', { required: false }, {}), false);

  // Should never be considered skippable / unimportant
  assert.equal(isSkippableUnimportantLabel('Phone Number', { required: false }), false);
  assert.equal(isSkippableUnimportantLabel('Phone Device Type', { required: false }), false);
  assert.equal(isSkippableUnimportantLabel('Mobile Phone', {}), false);

  // Must always be included in scan
  assert.equal(shouldIncludeInScan('Phone Number', { required: false }), true);
  assert.equal(shouldIncludeInScan('Phone Device Type', { required: false }), true);
  assert.equal(shouldIncludeInScan('Country Phone Code', { required: false }), true);
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
