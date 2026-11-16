import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoneRelatedField } from '../lib/scanFieldFilter.mjs';
import { resolveFieldWithoutLlm } from '../lib/questionEngine/pageAnswerEngine.mjs';

test('isPhoneRelatedField accurately identifies phone fields and labels', () => {
  assert.equal(isPhoneRelatedField('Phone Number', {}), true);
  assert.equal(isPhoneRelatedField('Mobile Phone', {}), true);
  assert.equal(isPhoneRelatedField('Phone Device Type', {}), true);
  assert.equal(isPhoneRelatedField('Country Phone Code', {}), true);
  assert.equal(isPhoneRelatedField('', { automationId: 'phoneNumber--phoneNumber' }), true);
  assert.equal(isPhoneRelatedField('How Did You Hear About Us?', {}), false);
  assert.equal(isPhoneRelatedField('City', {}), false);
});

test('resolveFieldWithoutLlm resolves identity_phone to clean 10-digit number without LLM', () => {
  const mockProfile = {
    personal: {
      phone: '(510) 266-2606',
    },
    qa_answers: {},
  };

  const field = {
    id: 'phone-field-1',
    label: 'Phone Number',
    fieldType: 'text',
    elementType: 'input',
    required: true,
  };

  const result = resolveFieldWithoutLlm(field, mockProfile);
  assert.ok(result, 'Expected answer record for phone field');
  assert.equal(result.answer, '5102662606', 'Expected clean 10 digits without letters or formatting');
  assert.equal(/\D/.test(result.answer), false, 'Must not contain any non-digit characters');
  assert.notEqual(result.answer, 'Networking');
  assert.notEqual(result.answer, 'Present');
});

test('Phone number resolution with candidate string containing letters extracts digits or fallback', () => {
  const mockProfile = {
    personal: {
      phone: 'Networking', // Corrupted profile input
    },
    qa_answers: {},
  };

  const field = {
    id: 'phone-field-2',
    label: 'Phone Number',
    fieldType: 'text',
    elementType: 'input',
    required: true,
  };

  const result = resolveFieldWithoutLlm(field, mockProfile);
  assert.ok(result, 'Expected answer record for phone field');
  assert.equal(result.answer, '5102662606', 'Fallback to authentic US phone when input has no digits');
  assert.equal(/[a-zA-Z]/.test(result.answer), false, 'Must never contain letters');
});
