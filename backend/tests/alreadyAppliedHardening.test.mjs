import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkdayAlreadyApplied } from '../lib/discovery.mjs';

function createMockElement({ tagName = 'div', textContent = '', attributes = {}, children = [] } = {}) {
  const el = {
    tagName: tagName.toUpperCase(),
    textContent,
    hidden: false,
    getAttribute: (attr) => attributes[attr] || null,
    closest: () => null,
    children,
  };
  return el;
}

function createMockPage({ elements = [], bodyText = '' } = {}) {
  return {
    isClosed: () => false,
    evaluate: async (fn) => {
      const mockDoc = {
        querySelectorAll: (selector) => {
          if (selector.includes('button')) {
            return elements.filter(e => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button');
          }
          if (selector.includes('[role="alert"]') || selector.includes('h1')) {
            return elements.filter(e => e.getAttribute('role') === 'alert' || e.tagName === 'H1' || e.tagName === 'H2' || e.tagName === 'H3');
          }
          return [];
        },
        querySelector: (selector) => {
          if (selector.includes('appliedButton') || selector.includes('alreadyApplied')) {
            return elements.find(e => e.getAttribute('data-automation-id') === 'appliedButton' || e.getAttribute('data-automation-id') === 'alreadyApplied') || null;
          }
          if (selector.includes('bottom-navigation-next-button') || selector.includes('progressBar') || selector.includes('file-upload-drop-zone')) {
            return elements.find(e => {
              const id = e.getAttribute('data-automation-id');
              return id === 'bottom-navigation-next-button' || id === 'progressBar' || id === 'file-upload-drop-zone';
            }) || null;
          }
          return null;
        },
        body: {
          innerText: bodyText,
        }
      };

      globalThis.document = mockDoc;
      globalThis.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
      try {
        return fn();
      } finally {
        delete globalThis.document;
        delete globalThis.window;
      }
    }
  };
}

test('Step 2 "My Experience" with resume helper text is NOT already applied', async () => {
  const page = createMockPage({
    elements: [
      createMockElement({ tagName: 'div', attributes: { 'data-automation-id': 'progressBar' }, textContent: 'My Experience' }),
      createMockElement({ tagName: 'div', attributes: { 'data-automation-id': 'file-upload-drop-zone' }, textContent: 'Drop files here' }),
      createMockElement({ tagName: 'button', attributes: { 'data-automation-id': 'bottom-navigation-next-button' }, textContent: 'Save and Continue' }),
    ],
    bodyText: 'Resume/CV Once your application has been submitted, you will not be able to update your resume. Please ensure you have provided your most current version. Save and Continue'
  });

  const result = await isWorkdayAlreadyApplied(page);
  assert.equal(result, false, 'Step 2 active wizard must NEVER be detected as already applied');
});

test('Page with active Save and Continue is NOT already applied even if text contains submitted keywords', async () => {
  const page = createMockPage({
    elements: [
      createMockElement({ tagName: 'button', textContent: 'Save and Continue' }),
    ],
    bodyText: 'Ensure your application is submitted before deadline.'
  });

  const result = await isWorkdayAlreadyApplied(page);
  assert.equal(result, false, 'Page with Save and Continue button must return false');
});

test('JD page with explicit appliedButton element IS already applied', async () => {
  const page = createMockPage({
    elements: [
      createMockElement({ tagName: 'button', attributes: { 'data-automation-id': 'appliedButton' }, textContent: 'Applied' }),
    ],
    bodyText: 'Senior Software Engineer Applied'
  });

  const result = await isWorkdayAlreadyApplied(page);
  assert.equal(result, true, 'Dedicated appliedButton must return true');
});

test('Explicit "You have already applied for this position" banner IS already applied', async () => {
  const page = createMockPage({
    elements: [
      createMockElement({ tagName: 'div', attributes: { role: 'alert' }, textContent: 'You have already applied for this position.' }),
    ],
    bodyText: 'You have already applied for this position.'
  });

  const result = await isWorkdayAlreadyApplied(page);
  assert.equal(result, true, 'Explicit alert stating already applied must return true');
});
