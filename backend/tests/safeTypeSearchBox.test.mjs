import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTypeSearchBox } from '../lib/fields.mjs';

test('safeTypeSearchBox types full text into input', async () => {
  let value = '';
  let eventsDispatched = [];

  const mockInput = {
    async isVisible() { return true; },
    async scrollIntoViewIfNeeded() {},
    async click() {},
    async focus() {},
    async fill(val) { value = val; },
    async pressSequentially(val) { value = val; },
    async inputValue() { return value; },
    async dispatchEvent(evt) { eventsDispatched.push(evt); },
    async press() {},
  };

  const mockPage = {
    locator() { return mockInput; },
    async waitForTimeout() {},
    keyboard: {
      async press() {},
      async type(text) { value = text; },
    },
  };

  const ok = await safeTypeSearchBox(mockPage, mockInput, 'Computer Science');
  assert.equal(ok, true);
  assert.equal(value, 'Computer Science');
});

test('safeTypeSearchBox detects truncated "puter Science" and heals with full "Computer Science"', async () => {
  let value = '';
  let eventsDispatched = [];
  let fillCount = 0;

  const mockInput = {
    async isVisible() { return true; },
    async scrollIntoViewIfNeeded() {},
    async click() {},
    async focus() {},
    async fill(val) {
      fillCount++;
      value = val;
    },
    // Simulate Workday wiping "Com" so pressSequentially leaves "puter Science"
    async pressSequentially(val) {
      value = 'puter Science';
    },
    async inputValue() { return value; },
    async dispatchEvent(evt) { eventsDispatched.push(evt); },
    async press() {},
  };

  const mockPage = {
    locator() { return mockInput; },
    async waitForTimeout() {},
    keyboard: {
      async press() {},
      async type() {},
    },
  };

  const ok = await safeTypeSearchBox(mockPage, mockInput, 'Computer Science');
  assert.equal(ok, true);
  // Auto-healing must replace "puter Science" with full "Computer Science"
  assert.equal(value, 'Computer Science');
  assert.ok(eventsDispatched.includes('input'));
  assert.ok(eventsDispatched.includes('change'));
  assert.ok(fillCount >= 2, 'Must have cleared and refilled atomically');
});
