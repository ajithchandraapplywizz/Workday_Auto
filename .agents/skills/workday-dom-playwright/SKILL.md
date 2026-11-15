---
name: workday-dom-playwright
description: >-
  Mastery of Playwright browser automation for Workday ATS portals (*.myworkdayjobs.com).
  Handles dynamic ARIA containers, custom popup dropdowns, spin calendars, OFCCP CC-305
  voluntary disclosures, strict multi-checkbox enforcement (e.g. race Asian only), mandatory
  phone section expansion and verification, Tab/Enter input commitment, and zero local screenshot
  cloud streaming. Activate whenever interacting with, debugging, or writing DOM automation for Workday forms.
---

# Workday DOM & Playwright Automation Mastery

This skill defines the definitive protocols for automating, inspecting, and filling forms on Workday Applicant Tracking Systems (`*.myworkdayjobs.com`) using Playwright.

## Core Invariants & Guardrails

1. **Zero Blind Fills**:
   - Never assume an input has received a value just because `fill()` or `type()` executed.
   - Every input interaction must be followed by a verification step asserting that the value persisted in the live DOM (reading `inputValue()` or `innerText`).
   - If Workday reactive state clears an input on blur or dropdown cascade, re-fill and commit.

2. **Zero Local Screenshots**:
   - NEVER save, write, or download screenshots to the local disk or workspace folders (`screenshots/`, `data/`, `tmp/`).
   - All Playwright screenshots must be kept strictly as in-memory buffers:
     ```javascript
     const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
     await uploadToSupabaseStorage('submitted-applications', filename, buf);
     ```

3. **Input Commitment via Keyboard**:
   - Workday text inputs often require explicit blur, Enter, or Tab events to trigger internal state changes and data-automation updates:
     ```javascript
     await input.fill(value);
     await page.keyboard.press('Tab');
     await page.waitForTimeout(150);
     ```

---

## Key Workday Form Interaction Patterns

### 1. Mandatory Phone Section & Verification (`Step 1: My Information`)
- **Strict Rule**: Phone Number, Phone Device Type, and Country Phone Code are **ALWAYS strictly mandatory to fill**, regardless of whether Workday renders an asterisk `*` or `aria-required="false"`.
- **Expansion Protocol**: If phone fields are unmounted, locate and click the `Add` or `Add Phone` button.
- **Device Type**: Select `Mobile` (or candidate preference). Never leave as "Select One".
- **Country Code**: Default to `+1` (United States/Canada) or candidate country code.
- **Verification Gate**: Assert that numeric digits persist in the live DOM. If empty right before advancing, trigger `ensureStep1PhoneDetailsComplete`.

### 2. Custom Pop-Up Dropdowns (`data-automation-id="select-button"`)
Workday dropdowns are not native HTML `<select>` elements. They are ARIA listbox buttons that mount an overlay popup.
- **Interaction Pattern**:
  ```javascript
  // 1. Click dropdown trigger
  await trigger.click();
  // 2. Wait for listbox popup overlay
  const popup = page.locator('[role="listbox"], [data-automation-id="select-items-list"]');
  await popup.waitFor({ state: 'visible', timeout: 5000 });
  // 3. Search or filter option
  const option = popup.locator(`[role="option"]:has-text("${exactOptionText}")`);
  if (await option.count() > 0) {
    await option.first().click();
  } else {
    // Fallback: search box inside popup
    const searchInput = popup.locator('input[type="text"]');
    if (await searchInput.count() > 0) {
      await searchInput.fill(exactOptionText);
      await page.keyboard.press('Enter');
    }
  }
  ```

### 3. Voluntary Disclosures & Self-Identify (OFCCP CC-305)
- **EEO / Race Multi-Checkbox Rule**: When encountering race/ethnicity multi-checkbox groups, ONLY check "Asian" (or candidate verified identity). All other race options (Black, Hispanic, White, Native Hawaiian, Two or more, I do not wish to answer) must be strictly unchecked.
- **OFCCP CC-305 Spin Calendar & Date Commitment**:
  - The CC-305 electronic signature date must be filled using valid spinbutton or input handling, followed by Tab/Enter commitment.
  - Assert the date field does not display the error *"The field Date is required and must have a value"*.
- **Routing**: Always route `/voluntary|eeo|equal|diversity|disclos/i` and `/self[- ]?identif|disability|cc-?305/i` to dedicated handlers in `engine.mjs`.

### 4. Review & Submit Stage 3 Fast-Track
- During live submission (`confirmSubmit === true`), do not parse or harvest the full review DOM.
- Fast-track: Verify all required sections show green checkmarks or valid states, electronically sign agreements, click "Submit", and wait for confirmation text or confirmation ID.
- Capture proof screenshot in-memory and stream directly to `submitted-applications` bucket.

---

## Anti-Patterns to Avoid

| Anti-Pattern | Why It Breaks Workday | Correct Pattern |
|---|---|---|
| Blind `page.fill()` without verification | Reactive state cascades clear values | Check `inputValue()` immediately after fill |
| Hardcoded selector IDs like `#input-14` | Workday IDs change dynamically on re-render | Use `data-automation-id` and ARIA label proximity |
| Leaving "Select One" on dropdowns | Workday treats as unanswered mandatory question | Sweeper must select verified answer or closest profile match |
| Saving local screenshots to `screenshots/` | Violates Zero Local Screenshots Policy & pollutes git | Stream in-memory buffer directly to Supabase Storage |
| Harvesting questions during Stage 3 | Adds 15–30s idle delay per wizard step | Guard question harvesting with `if (isScan)` |
