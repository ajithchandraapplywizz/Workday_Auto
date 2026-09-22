import { test, expect, describe } from 'vitest';
import { resolveIntent, deriveControlTypeFromDom } from './intentResolver.mjs';

describe('intentResolver', () => {
  test('dropdown vs input misclassification: deriveControlTypeFromDom strictly uses DOM, not label', () => {
    // Should be dropdown despite ambiguous label
    const dropdownField = {
      label: 'Enter your country or select from list',
      elementType: 'select',
      role: 'listbox'
    };
    expect(deriveControlTypeFromDom(dropdownField)).toBe('dropdown');

    // Should be text input
    const inputField = {
      label: 'Select your preferred name (text input)',
      elementType: 'input',
      role: 'textbox'
    };
    expect(deriveControlTypeFromDom(inputField)).toBe('text');
  });

  test('fuzzball matches intents correctly', async () => {
    const field = {
      label: 'Highest level of education',
      elementType: 'select',
      role: 'listbox'
    };
    
    const result = await resolveIntent(field);
    expect(result.intent).toBe('education.degree');
    expect(result.controlType).toBe('dropdown');
    expect(result.method).toBe('fuzzball');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });
});
