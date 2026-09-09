/**
 * stateDetector.mjs — Workday wizard state detection (DOM / a11y only)
 */

export const WORKDAY_STATES = {
  MY_INFORMATION: 'My Information',
  MY_EXPERIENCE: 'My Experience',
  APPLICATION_QUESTIONS: 'Application Questions',
  VOLUNTARY_DISCLOSURES: 'Voluntary Disclosures',
  SELF_IDENTIFY: 'Self Identify',
  REVIEW: 'Review',
  UNKNOWN: 'Unknown',
};

/**
 * Detect current Workday wizard step from rendered page content.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function detectWorkdayStep(page) {
  return await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="step-title"], [data-automation-id="compositeHeader"], legend'));
    for (const h of headings) {
      const text = (h.textContent || '').trim();
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures/i.test(text)) return 'Voluntary Disclosures';
      if (/self\s*identify/i.test(text)) return 'Self Identify';
      if (/^review(\s*application)?$/i.test(text) || /review\s*and\s*submit/i.test(text) || /review\s*your\s*application/i.test(text)) return 'Review';
    }

    const activeStep = document.querySelector('[data-automation-id*="wizardStep"][aria-current="step"], [data-automation-id*="currentStep"], li.active, [aria-selected="true"]');
    if (activeStep) {
      const text = (activeStep.textContent || '').trim();
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures/i.test(text)) return 'Voluntary Disclosures';
      if (/self\s*identify/i.test(text)) return 'Self Identify';
      if (/review/i.test(text)) return 'Review';
    }

    const bodyText = document.body?.innerText || '';
    if (/My Information/i.test(bodyText) && (/How Did You Hear/i.test(bodyText) || /Address Line/i.test(bodyText))) return 'My Information';
    if (/My Experience/i.test(bodyText) || (/Work Experience/i.test(bodyText) && /Resume/i.test(bodyText))) return 'My Experience';
    if (/Application Questions/i.test(bodyText) || /Conflict of Interest/i.test(bodyText)) return 'Application Questions';
    if (/Voluntary Disclosures/i.test(bodyText) || /terms and conditions/i.test(bodyText)) return 'Voluntary Disclosures';
    if (/Self\s*Identify/i.test(bodyText) || (/CC-305/i.test(bodyText) && /Voluntary Self-Identification of Disability/i.test(bodyText))) return 'Self Identify';
    if (/Review/i.test(bodyText) && (document.querySelector('button[data-automation-id*="submit"], button:has-text("Submit")') || /Review/i.test(document.title))) return 'Review';

    return 'Unknown';
  });
}
