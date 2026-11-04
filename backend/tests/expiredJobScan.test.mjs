import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkdayJobPageMissing } from '../lib/discovery.mjs';

function createMockPage({ bodyText = '', buttons = [], inputs = [], spinners = [] } = {}) {
  return {
    isClosed: () => false,
    evaluate: async (fn, arg) => {
      // Mock minimal browser DOM in node context
      const doc = {
        body: { innerText: bodyText },
        querySelector: (sel) => {
          if (sel.includes('loadingSpinner') || sel.includes('progressbar')) {
            return spinners.length > 0 ? {} : null;
          }
          if (sel.includes('apply') || sel.includes('adventureButton') || sel.includes('continueApplication')) {
            return buttons.find(b => /apply|adventure|continue/i.test(b)) ? {} : null;
          }
          if (sel.includes('pageFooterNextButton') || sel.includes('legalNameSection')) {
            return buttons.find(b => /save and continue|continue/i.test(b)) || inputs.find(i => /legalName/i.test(i)) ? {} : null;
          }
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel.includes('a, button')) {
            return buttons.map(text => ({ textContent: text }));
          }
          return [];
        },
      };

      // Create a global document wrapper for evaluate
      const prevDoc = globalThis.document;
      try {
        globalThis.document = doc;
        return fn(arg);
      } finally {
        globalThis.document = prevDoc;
      }
    },
  };
}

test('isWorkdayJobPageMissing: detects "The page you are looking for doesn\'t exist"', async () => {
  const page = createMockPage({
    bodyText: 'Error 404. The page you are looking for doesn\'t exist or has moved.',
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, true);
});

test('isWorkdayJobPageMissing: detects "This job posting has been filled"', async () => {
  const page = createMockPage({
    bodyText: 'Thank you for your interest. This job posting has been filled and is closed.',
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, true);
});

test('isWorkdayJobPageMissing: detects "Position is no longer available"', async () => {
  const page = createMockPage({
    bodyText: 'We appreciate your interest in our company. This position is no longer available.',
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, true);
});

test('isWorkdayJobPageMissing: detects "This requisition has been closed"', async () => {
  const page = createMockPage({
    bodyText: 'Notice: This requisition has been closed. No longer accepting applications.',
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, true);
});

test('isWorkdayJobPageMissing: returns false if page has an active Apply button', async () => {
  const page = createMockPage({
    bodyText: 'Senior Software Engineer. You may see expired notices on old jobs, but this is active.',
    buttons: ['Apply Now'],
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, false);
});

test('isWorkdayJobPageMissing: returns false if page is actively loading spinner', async () => {
  const page = createMockPage({
    bodyText: 'Loading...',
    spinners: ['loading-spinner'],
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, false);
});

test('isWorkdayJobPageMissing: returns false if wizard Save and Continue button is visible', async () => {
  const page = createMockPage({
    bodyText: 'Step 1: My Information. Please fill in your address and contact info.',
    buttons: ['Save and Continue'],
  });
  const missing = await isWorkdayJobPageMissing(page);
  assert.equal(missing, false);
});
