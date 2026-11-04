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
    // 0. Detect "Already Applied" state ONLY if NOT on an active application wizard step
    const allButtons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const hasWizardNavBtn = allButtons.some(b => {
      const txt = (b.textContent || '').trim().toLowerCase();
      return (
        txt === 'save and continue' ||
        txt === 'save & continue' ||
        txt === 'save and next' ||
        txt === 'review and submit' ||
        txt === 'back'
      );
    });

    const hasWizardDomElement = Boolean(
      document.querySelector(
        'button[data-automation-id="bottom-navigation-next-button"], ' +
        'button[data-automation-id="pageFooterNextButton"], ' +
        'button[data-automation-id="saveAndContinue"], ' +
        'button[data-automation-id="next-button"], ' +
        'div[data-automation-id="file-upload-drop-zone"], ' +
        '[data-automation-id="progressBar"], ' +
        '[data-automation-id="progressBarActiveStep"], ' +
        '[data-automation-id="myInformationPage"], ' +
        '[data-automation-id="myExperiencePage"], ' +
        '[data-automation-id="applicationQuestionsPage"], ' +
        '[data-automation-id="voluntaryDisclosuresPage"], ' +
        '[data-automation-id="reviewPage"]'
      )
    );

    const isVisible = (el) => {
      if (!el) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.closest?.('[hidden], [aria-hidden="true"], [style*="display: none" i], [style*="display:none" i]')) return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        } catch {}
      }
      return true;
    };

    if (!hasWizardNavBtn && !hasWizardDomElement) {
      const appliedEl = document.querySelector(
        '[data-automation-id="appliedButton"], [data-automation-id="alreadyApplied"], [data-automation-id="previouslyApplied"], [data-automation-id="applicationAlreadySubmitted"], [data-automation-id="duplicateApplication"]'
      );
      if (appliedEl && isVisible(appliedEl)) {
        return 'Already Applied';
      }

      const alertContainers = Array.from(document.querySelectorAll(
        '[role="alert"], [data-automation-id*="alert" i], [data-automation-id*="banner" i], [data-automation-id="errorMessage"], h1, h2, h3'
      ));

      for (const container of alertContainers) {
        if (!isVisible(container)) continue;
        const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || /once (?:your|the) application|will not be able to update/i.test(text)) continue;
        if (
          /you(?:'ve|\s+have)?\s+already\s+applied\b/i.test(text) ||
          /already\s+applied\s+(?:for|to)\s+this\s+(?:job|position)\b/i.test(text) ||
          /you(?:'ve|\s+have)?\s+already\s+submitted\s+(?:an?|your)\s+application\b/i.test(text) ||
          /application\s+has\s+already\s+been\s+submitted\b/i.test(text) ||
          /we\s+have\s+already\s+received\s+your\s+application\b/i.test(text) ||
          /duplicate\s+application\s+detected\b/i.test(text)
        ) {
          return 'Already Applied';
        }
      }
    }

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

    // 3. Direct Review & Submit page detection (must precede bodyText because Review contains full text of all previous steps)
    const hasSubmitButton = Boolean(
      document.querySelector('button[data-automation-id*="submit" i], [data-automation-id="pageFooterSubmitButton"], button[type="submit"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).some(b => /^\s*submit(?:\s+application)?\s*$/i.test(b.textContent || ''))
    );
    if (hasSubmitButton && (/review/i.test(document.title) || /review\s*(?:and|&)\s*submit/i.test(document.body?.innerText || ''))) {
      return 'Review';
    }

    const bodyText = document.body?.innerText || '';
    if (hasSubmitButton || (/Review/i.test(bodyText) && /Review/i.test(document.title))) {
      return 'Review';
    }

    if (/How Did You Hear About Us/i.test(bodyText) || /Country\s*\/\s*Territory\s*Phone\s*Code/i.test(bodyText) || Boolean(document.querySelector('input[data-automation-id="legalNameSection_firstName"], input[id*="legalName--firstName"]'))) {
      return 'My Information';
    }
    if (/Work Experience/i.test(bodyText) && (/Resume\/CV|Education|Skills/i.test(bodyText))) return 'My Experience';
    if (/Conflict of Interest/i.test(bodyText)) return 'Application Questions';
    if (/Voluntary Self-Identification of Disability/i.test(bodyText) || /CC-305/i.test(bodyText) || /OMB Control Number 1250-0005/i.test(bodyText)) return 'Self Identify';
    if (/Voluntary Disclosures|Equal Employment Opportunity|Veteran Status|Race\/Ethnicity/i.test(bodyText)) return 'Voluntary Disclosures';

    return 'Unknown';
  });
}

/**
 * Canonical sequence order for Workday wizard pages.
 */
export const WORKDAY_STEP_SEQUENCE = [
  'My Information',
  'My Experience',
  'Application Questions',
  'Voluntary Disclosures',
  'Self Identify',
  'Review',
];

export function getStepOrder(stepName) {
  const s = String(stepName || '').toLowerCase().trim();
  if (s.includes('information')) return 1;
  if (s.includes('experience')) return 2;
  if (s.includes('application questions') || s.includes('question')) return 3;
  if (s.includes('voluntary') || s.includes('disclosure') || s.includes('eeo')) return 4;
  if (s.includes('self') || s.includes('identify') || s.includes('disability') || s.includes('veteran')) return 5;
  if (s.includes('review')) return 6;
  return 7;
}

export function normalizeWorkdayStepName(stepName, questionLabel = '') {
  const q = String(questionLabel || '').toLowerCase();

  // Heuristic disambiguation for fields scraped on Review or generic containers
  if (!stepName || stepName === 'Application' || stepName === 'Review' || stepName === 'Review & Submit' || stepName === 'Unknown') {
    if (/first\s*name|last\s*name|email|phone|mobile|country|city|state|postal|zip|address|hear about us/i.test(q)) {
      return 'My Information';
    }
    if (/resume|education|degree|school|university|gpa|employer|job title|company|years of experience/i.test(q)) {
      return 'My Experience';
    }
    if (/disability|cc-?305|veteran|gender|race|ethnicity|hispanic|latino/i.test(q)) {
      return 'Self Identify';
    }
    if (/authorized|permit.*work|sponsor|visa|terms and conditions|policy|convict|felon|relative|family member/i.test(q)) {
      return 'Voluntary Disclosures';
    }
  }

  const s = String(stepName || '').toLowerCase().trim();
  if (s.includes('information')) return 'My Information';
  if (s.includes('experience')) return 'My Experience';
  if (s.includes('self') || s.includes('identify') || s.includes('disability')) return 'Self Identify';
  if (s.includes('voluntary') || s.includes('disclosure') || s.includes('eeo')) return 'Voluntary Disclosures';
  if (s.includes('question')) return 'Application Questions';
  if (s.includes('review')) return 'Review';
  return stepName || 'Application Questions';
}

/**
 * Detects whether the current Workday page is showing an "already applied"
 * state — meaning this candidate (AWL-ID) has previously submitted to this job.
 *
 * Called immediately after page navigation, before wizard detection.
 * Returns true → skip this AWL-ID, mark as 'already_applied', move to next.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function detectAlreadyApplied(page) {
  try {
    return await page.evaluate(() => {
      // 0. ABSOLUTE HARD GUARD: If on an active application wizard step, the candidate
      // is actively applying! Workday NEVER renders the wizard form if already applied.
      const allButtons = Array.from(document.querySelectorAll('button, a[role="button"]'));
      const hasWizardNavBtn = allButtons.some(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        return (
          txt === 'save and continue' ||
          txt === 'save & continue' ||
          txt === 'save and next' ||
          txt === 'review and submit' ||
          txt === 'back'
        );
      });

      const hasWizardDomElement = Boolean(
        document.querySelector(
          'button[data-automation-id="bottom-navigation-next-button"], ' +
          'button[data-automation-id="pageFooterNextButton"], ' +
          'button[data-automation-id="saveAndContinue"], ' +
          'button[data-automation-id="next-button"], ' +
          'div[data-automation-id="file-upload-drop-zone"], ' +
          '[data-automation-id="progressBar"], ' +
          '[data-automation-id="progressBarActiveStep"], ' +
          '[data-automation-id="myInformationPage"], ' +
          '[data-automation-id="myExperiencePage"], ' +
          '[data-automation-id="applicationQuestionsPage"], ' +
          '[data-automation-id="voluntaryDisclosuresPage"], ' +
          '[data-automation-id="reviewPage"]'
        )
      );

      if (hasWizardNavBtn || hasWizardDomElement) {
        return false;
      }

      const isVisible = (el) => {
        if (!el) return false;
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        if (el.closest?.('[hidden], [aria-hidden="true"], [style*="display: none" i], [style*="display:none" i]')) return false;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          } catch {}
        }
        return true;
      };

      // 1. ARIA / data-automation-id based detection for structured Workday tenants
      const appliedEl = document.querySelector(
        '[data-automation-id="appliedButton"], [data-automation-id="alreadyApplied"], [data-automation-id="previouslyApplied"], [data-automation-id="applicationAlreadySubmitted"], [data-automation-id="duplicateApplication"]'
      );
      if (appliedEl && isVisible(appliedEl)) {
        return true;
      }

      // 2. Button / badge elements explicitly saying "Applied" or "Already Applied"
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], div[role="status"], [class*="badge" i], [class*="status" i]'));
      if (buttons.some(b => {
        if (!isVisible(b)) return false;
        return /^\s*(applied|already applied|previously applied)\s*$/i.test((b.textContent || '').trim());
      })) {
        return true;
      }

      // 3. Document alert / banner / heading checks — strictly inspect alert or header containers
      // NEVER match instructional/conditional warnings like:
      // "Once your application has been submitted, you will not be able to update your resume..."
      const alertContainers = Array.from(document.querySelectorAll(
        '[role="alert"], [data-automation-id*="alert" i], [data-automation-id*="banner" i], [data-automation-id="errorMessage"], h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="compositeHeader"]'
      ));

      for (const container of alertContainers) {
        if (!isVisible(container)) continue;
        const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;

        if (
          /once (?:your|the) application/i.test(text) ||
          /after (?:your|the) application/i.test(text) ||
          /when (?:your|the) application/i.test(text) ||
          /before (?:submitting|your)/i.test(text) ||
          /will not be able to update/i.test(text) ||
          /ensure you have provided/i.test(text)
        ) {
          continue;
        }

        if (
          /you(?:'ve|\s+have)?\s+already\s+applied\b/i.test(text) ||
          /already\s+applied\s+(?:for|to)\s+this\s+(?:job|position)\b/i.test(text) ||
          /you(?:'ve|\s+have)?\s+already\s+submitted\s+(?:an?|your)\s+application\b/i.test(text) ||
          /application\s+has\s+already\s+been\s+submitted\b/i.test(text) ||
          /we\s+have\s+already\s+received\s+your\s+application\b/i.test(text) ||
          /duplicate\s+application\s+detected\b/i.test(text)
        ) {
          return true;
        }
      }

      return false;
    });
  } catch {
    // If evaluation fails (page closed/crashed), treat as not-already-applied
    return false;
  }
}
