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
    // 1. If visible password/auth fields or Create Account/Sign In active step exist, it is NOT a wizard form step
    const pwdVisible = Array.from(document.querySelectorAll('input[type="password"], input[data-automation-id="password"], input[data-automation-id="verifyPassword"]'))
      .some((el) => el.offsetParent !== null);
    if (pwdVisible) return 'Unknown';

    const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"], [data-automation-id*="wizardStep"][aria-current="step"], [data-automation-id*="currentStep"], li.active, [aria-selected="true"]');
    if (activeStep) {
      const text = (activeStep.textContent || '').trim();
      if (/create\s*account|sign\s*in/i.test(text)) return 'Unknown';
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures?|equal\s*employment|eeo|diversity/i.test(text)) return 'Voluntary Disclosures';
      if (/self[- ]?identif|disability|cc-?305/i.test(text)) return 'Self Identify';
      if (/review/i.test(text)) return 'Review';
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="step-title"], [data-automation-id="compositeHeader"], legend'));
    for (const h of headings) {
      const text = (h.textContent || '').trim();
      if (/^(create\s*account|sign\s*in|create\s*account\s*\/\s*sign\s*in)$/i.test(text)) return 'Unknown';
      if (/^my\s*information$/i.test(text)) return 'My Information';
      if (/^my\s*experience$/i.test(text)) return 'My Experience';
      if (/^application\s*questions/i.test(text)) return 'Application Questions';
      if (/^(voluntary\s*disclosures?|equal\s*employment|eeo|diversity)/i.test(text)) return 'Voluntary Disclosures';
      if (/^(self[- ]?identif|disability|cc-?305)/i.test(text)) return 'Self Identify';
      if (/^review(\s*application)?$/i.test(text) || /review\s*and\s*submit/i.test(text) || /review\s*your\s*application/i.test(text)) return 'Review';
    }

    const bodyText = document.body?.innerText || '';
    if (/How Did You Hear About Us/i.test(bodyText) || /Country\s*\/\s*Territory\s*Phone\s*Code/i.test(bodyText) || Boolean(document.querySelector('input[data-automation-id="legalNameSection_firstName"], input[id*="legalName--firstName"]'))) {
      return 'My Information';
    }
    if (/Work Experience/i.test(bodyText) && (/Resume\/CV|Education|Skills/i.test(bodyText))) return 'My Experience';
    if (/Conflict of Interest/i.test(bodyText)) return 'Application Questions';
    if (/Voluntary Self-Identification of Disability/i.test(bodyText) || /CC-305/i.test(bodyText) || /OMB Control Number 1250-0005/i.test(bodyText)) return 'Self Identify';
    if (/Voluntary Disclosures|Equal Employment Opportunity|Veteran Status|Race\/Ethnicity/i.test(bodyText)) return 'Voluntary Disclosures';
    if (/Review/i.test(bodyText) && (document.querySelector('button[data-automation-id*="submit"], button:has-text("Submit")') || /Review/i.test(document.title))) return 'Review';

    return 'Unknown';
  });
}

