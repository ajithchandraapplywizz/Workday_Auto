/**
 * stateDetector.mjs — Workday wizard state detection (DOM / a11y only)
 */

export const WORKDAY_STATES = {
  AUTHENTICATION: 'Authentication',
  MY_INFORMATION: 'My Information',
  MY_EXPERIENCE: 'My Experience',
  APPLICATION_QUESTIONS: 'Application Questions',
  VOLUNTARY_DISCLOSURES: 'Voluntary Disclosures',
  SELF_IDENTIFY: 'Self Identify',
  REVIEW: 'Review',
  UNKNOWN: 'Unknown',
};

/**
 * Patiently waits for Workday page and form fields to dynamically render (hydrating React/SPA components).
 * Prevents premature failure where the stepper/header is rendered but form inputs are still loading.
 *
 * @param {import('playwright').Page} page
 * @param {object} options
 * @param {number} [options.timeoutMs=20000] Maximum time to wait for form hydration
 * @param {boolean} [options.triggerHydration=true] Dispatch micro-scroll/resize to awaken hydration if blank
 * @returns {Promise<boolean>} True if form controls or stable wizard state mounted, false on timeout
 */
export async function waitForWorkdayFormRender(page, { timeoutMs = 20000, triggerHydration = true } = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;

  const startTime = Date.now();
  let hydrated = false;

  // 1. Initial wait for loading spinners/progressbars to detach
  try {
    await page.waitForSelector(
      '[data-automation-id="loadingSpinner"], [data-automation-id*="loading-spinner" i], [role="progressbar"], .loading-spinner, div[class*="loading" i], div[class*="spinner" i], div[class*="skeleton" i], div.bubble-pulse, div.loading-backdrop',
      { state: 'detached', timeout: 5000 }
    );
  } catch {}

  while (Date.now() - startTime < timeoutMs) {
    if (page.isClosed()) return false;

    const status = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        if (el.closest?.('[hidden], [aria-hidden="true"], [style*="display: none" i], [style*="display:none" i]')) return false;
        try {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        } catch {}
        return el.offsetParent !== null || el.getClientRects().length > 0;
      };

      // Check for any genuine form controls or submission/already_applied states
      const formControls = document.querySelectorAll(
        'input[type="password"], input[data-automation-id="password"], input[data-automation-id="verifyPassword"], ' +
        'input[data-automation-id="emailAddress"], input[data-automation-id="email"], ' +
        'button[data-automation-id="SignInWithEmailButton"], button[data-automation-id="signInSubmitButton"], ' +
        'button[data-automation-id="createAccountSubmitButton"], button[data-automation-id="createAccountTab"], ' +
        'button[data-automation-id="signInTab"], button[data-automation-id="bottom-navigation-next-button"], ' +
        'button[data-automation-id="pageFooterNextButton"], button[data-automation-id="saveAndContinue"], ' +
        'button[data-automation-id="pageFooterSubmitButton"], input[data-automation-id="legalNameSection_firstName"], ' +
        'input[id*="legalName--firstName"], div[data-automation-id="file-upload-drop-zone"], ' +
        '[data-automation-id="myInformationPage"], [data-automation-id="myExperiencePage"], ' +
        '[data-automation-id="applicationQuestionsPage"], [data-automation-id="voluntaryDisclosuresPage"], ' +
        '[data-automation-id="reviewPage"], [data-automation-id="submissionSuccess"], [data-automation-id="appliedButton"]'
      );

      for (const ctrl of formControls) {
        if (isVisible(ctrl)) return { isRendered: true, type: 'control' };
      }

      // Check for generic inputs or dropdowns in main form container
      const formBody = document.querySelector('main, [role="main"], form, div[data-automation-id*="page" i], div[data-automation-id*="form" i]');
      if (formBody) {
        const bodyInputs = formBody.querySelectorAll('input:not([type="hidden"]), select, textarea, button[data-automation-id*="button" i]');
        for (const bi of bodyInputs) {
          if (isVisible(bi)) return { isRendered: true, type: 'body_input' };
        }
      }

      // Check if stepper is visible (Workday wizard/auth shell is mounted)
      const stepper = document.querySelector(
        '[data-automation-id="progressBar"], [data-automation-id="progressBarActiveStep"], nav[aria-label*="progress" i], nav[aria-label*="step" i], ol[class*="progress" i], ul[class*="progress" i], div[class*="stepper" i]'
      );
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const hasStepper = Boolean(stepper) || (/create\s*account/i.test(bodyText) && /my\s*information/i.test(bodyText));

      const hasSpinner = Boolean(
        document.querySelector('[data-automation-id*="loadingSpinner" i], [data-automation-id*="loading-spinner" i], [role="progressbar"], .loading-spinner, div[class*="loading" i], div[class*="spinner" i], div[class*="skeleton" i], div.bubble-pulse')
      );

      return {
        isRendered: false,
        hasStepper,
        hasSpinner,
        bodyLen: bodyText.length,
      };
    }).catch(() => ({ isRendered: false }));

    if (status.isRendered) {
      hydrated = true;
      break;
    }

    // If stepper is rendered or spinner is active, Workday is dynamically hydrating the page
    const elapsed = Date.now() - startTime;
    if (triggerHydration && (status.hasStepper || status.hasSpinner || status.bodyLen > 100)) {
      if (elapsed > 2000 && elapsed < 8000) {
        await page.evaluate(() => {
          try {
            window.scrollBy(0, 10);
            window.scrollBy(0, -10);
            window.dispatchEvent(new Event('resize'));
          } catch {}
        }).catch(() => {});
      }
    }

    await page.waitForTimeout(400).catch(() => {});
  }

  await page.waitForTimeout(200).catch(() => {});
  return hydrated;
}

/**
 * Detect current Workday wizard step from rendered page content.
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {boolean} [options.waitForRender=true]
 * @param {number} [options.timeoutMs=8000]
 * @returns {Promise<string>}
 */
export async function detectWorkdayStep(page, { waitForRender = true, timeoutMs = 8000 } = {}) {
  if (waitForRender && page && !page.isClosed()) {
    await waitForWorkdayFormRender(page, { timeoutMs }).catch(() => {});
  }
  return await page.evaluate(() => {
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
      return el.offsetParent !== null;
    };

    // 0. If visible authentication fields, verification codes, or auth buttons exist, it is strictly NOT a wizard step
    const isAuthVisible = Array.from(document.querySelectorAll(
      'input[type="password"], input[data-automation-id="password"], input[data-automation-id="verifyPassword"], ' +
      'input[data-automation-id="emailAddress"], input[data-automation-id="email"], ' +
      'input[data-automation-id*="passcode" i], input[data-automation-id*="code" i], input[data-automation-id*="verification" i], ' +
      'button[data-automation-id="SignInWithEmailButton"], button[data-automation-id="signInSubmitButton"], ' +
      'button[data-automation-id="createAccountSubmitButton"], button[data-automation-id="createAccountLink"], ' +
      'button[data-automation-id="signInLink"], [data-automation-id="createAccountTab"], [data-automation-id="signInTab"], ' +
      'button[data-automation-id="createAccountButton"], button[data-automation-id="signInButton"]'
    )).some(el => isVisible(el));
    if (isAuthVisible) return 'Authentication';

    // Check for auth page headings or text prompts
    const authHeaders = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], legend')).some(h => {
      if (!isVisible(h)) return false;
      const ht = (h.textContent || '').trim().toLowerCase();
      return (
        ht === 'sign in' ||
        ht === 'create account' ||
        ht === 'create an account' ||
        ht === 'verify your identity' ||
        ht === 'verification code' ||
        ht === 'check your email' ||
        ht === 'enter code' ||
        ht.includes('email verification') ||
        ht.includes('sign in with email')
      );
    });
    if (authHeaders) return 'Authentication';

    // 1. Priority Stepper Detection: Match active progress step in Workday stepper
    const activeStep = document.querySelector(
      '[data-automation-id="progressBarActiveStep"], [data-automation-id*="wizardStep"][aria-current="step"], ' +
      '[data-automation-id*="currentStep"], li.active, [aria-current="step"], [aria-current="page"], [aria-selected="true"]'
    );
    if (activeStep && isVisible(activeStep)) {
      const text = (activeStep.textContent || '').trim();
      if (/create\s*account|sign\s*in/i.test(text)) return 'Authentication';
      if (/my\s*information/i.test(text)) return 'My Information';
      if (/my\s*experience/i.test(text)) return 'My Experience';
      if (/application\s*questions/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures?|equal\s*employment|eeo|diversity/i.test(text)) return 'Voluntary Disclosures';
      if (/self[- ]?identif|disability|cc-?305/i.test(text)) return 'Self Identify';
      if (/review/i.test(text)) return 'Review';
    }

    // Also match stepper items by class or styling (e.g. red bullet / active dot on "Create Account/Sign In")
    const stepperItems = Array.from(document.querySelectorAll('ol li, ul li, [data-automation-id*="step" i], nav[aria-label*="progress" i] div, div[class*="step" i]'));
    for (const item of stepperItems) {
      if (!isVisible(item)) continue;
      const isItemActive = item.classList.contains('active') || item.getAttribute('aria-current') === 'step' || item.getAttribute('aria-selected') === 'true' || Boolean(item.querySelector('[aria-current="step"], .active, svg circle, circle[fill]'));
      if (isItemActive) {
        const text = (item.textContent || '').trim();
        if (/create\s*account|sign\s*in/i.test(text)) return 'Authentication';
        if (/my\s*information/i.test(text)) return 'My Information';
        if (/my\s*experience/i.test(text)) return 'My Experience';
        if (/application\s*questions/i.test(text)) return 'Application Questions';
        if (/voluntary\s*disclosures?|equal\s*employment|eeo|diversity/i.test(text)) return 'Voluntary Disclosures';
        if (/self[- ]?identif|disability|cc-?305/i.test(text)) return 'Self Identify';
        if (/review/i.test(text)) return 'Review';
      }
    }

    // 2. Detect genuine Workday wizard navigation buttons or step containers
    const allButtons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const hasWizardNavBtn = allButtons.some(b => {
      if (!isVisible(b)) return false;
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      if (inNav) return false;
      const txt = (b.textContent || '').trim().toLowerCase();
      const autoId = b.getAttribute('data-automation-id') || '';
      return (
        autoId === 'pageFooterNextButton' ||
        autoId === 'bottom-navigation-next-button' ||
        autoId === 'saveAndContinue' ||
        autoId === 'pageFooterSubmitButton' ||
        txt === 'save and continue' ||
        txt === 'save & continue' ||
        txt === 'save and next' ||
        txt === 'review and submit' ||
        txt === 'submit application' ||
        txt === 'submit'
      );
    });

    const hasWizardDomElement = Boolean(
      document.querySelector(
        'button[data-automation-id="bottom-navigation-next-button"], ' +
        'button[data-automation-id="pageFooterNextButton"], ' +
        'button[data-automation-id="saveAndContinue"], ' +
        'div[data-automation-id="file-upload-drop-zone"], ' +
        '[data-automation-id="progressBar"], ' +
        '[data-automation-id="progressBarActiveStep"], ' +
        'nav[aria-label*="progress" i], nav[aria-label*="step" i], ' +
        'ol[class*="progress" i], ul[class*="progress" i], div[class*="stepper" i], ' +
        '[data-automation-id="myInformationPage"], ' +
        '[data-automation-id="myExperiencePage"], ' +
        '[data-automation-id="applicationQuestionsPage"], ' +
        '[data-automation-id="voluntaryDisclosuresPage"], ' +
        '[data-automation-id="reviewPage"]'
      )
    ) || (
      /create\s*account\s*[\/\-]\s*sign\s*in/i.test(document.body?.innerText || '') &&
      /my\s*information/i.test(document.body?.innerText || '')
    );

    // 2a. If neither wizard navigation buttons nor wizard DOM containers exist, check Submitted, Already Applied or return Unknown
    if (!hasWizardNavBtn && !hasWizardDomElement) {
      // Priority check: Application Submission Confirmation (modal dialog, alert, or page)
      const isConfirmation = Boolean(
        document.querySelector(
          '[data-automation-id="submissionSuccess"], [data-automation-id="applicationSubmitted"], [data-automation-id="congratulations"], [data-automation-id="thankYouMessage"]'
        )
      );
      if (isConfirmation) {
        return 'Submitted';
      }

      const confirmContainers = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [data-automation-id*="popup" i], [data-automation-id*="modal" i], h1, h2, h3, h4, p, div'
      ));
      for (const container of confirmContainers) {
        if (!isVisible(container)) continue;
        const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (
          /congratulations\b/i.test(text) &&
          /application\s*(?:has\s*been\s*|is\s*|was\s*)?(?:successfully\s*)?(?:submitted|received)/i.test(text)
        ) {
          return 'Submitted';
        }
        if (
          /thank\s*you\s*(?:for\s*(?:applying|your\s*application)|very\s*much)|your\s*application\s*has\s*been\s*successfully\s*submitted/i.test(text) &&
          !/already\s*(?:applied|submitted)/i.test(text)
        ) {
          return 'Submitted';
        }
      }

      const href = window.location.href || '';
      if (/\/submitted\b|\/thankyou\b|\/application-submitted\b|\/applicationSubmitted\b/i.test(href)) {
        return 'Submitted';
      }

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

      // No wizard navigation controls and no wizard containers -> strictly Unknown (prevents false step triggers on landing/auth/footer)
      return 'Unknown';
    }

    // 4. Match primary headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="step-title"], [data-automation-id="compositeHeader"], legend'));
    for (const h of headings) {
      if (!isVisible(h)) continue;
      const text = (h.textContent || '').trim();
      if (/^(create\s*account|sign\s*in|create\s*account\s*[\/\-]\s*sign\s*in)$/i.test(text)) return 'Authentication';
      if (/\bmy\s*information\b/i.test(text)) return 'My Information';
      if (/\bmy\s*experience\b/i.test(text)) return 'My Experience';
      if (/\bapplication\s*questions\b/i.test(text)) return 'Application Questions';
      if (/voluntary\s*disclosures?|equal\s*employment\s*identification|diversity/i.test(text)) return 'Voluntary Disclosures';
      if (/self[- ]?identif|disability|cc-?305/i.test(text)) return 'Self Identify';
      if (/^review(\s*application)?$/i.test(text) || /review\s*and\s*submit/i.test(text) || /review\s*your\s*application/i.test(text)) return 'Review';
    }

    // 5. Direct Review & Submit page detection
    const hasGenuineSubmitButton = Boolean(
      document.querySelector('[data-automation-id="pageFooterSubmitButton"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).some(b => isVisible(b) && /^\s*submit(?:\s+application)?\s*$/i.test((b.textContent || '').trim()))
    );
    if (hasGenuineSubmitButton && (/review/i.test(document.title) || /review\s*(?:and|&)\s*submit/i.test(document.body?.innerText || ''))) {
      return 'Review';
    }

    const bodyText = document.body?.innerText || '';
    if (hasGenuineSubmitButton && (/Review/i.test(bodyText) && /Review/i.test(document.title))) {
      return 'Review';
    }

    // 6. Section & Form field matching (strictly via visible containers and section headers — NEVER body text EEO footers)
    if (
      /How Did You Hear About Us/i.test(bodyText) ||
      /Country\s*(?:\/|and)?\s*Territory\s*Phone\s*Code/i.test(bodyText) ||
      /Country\s*Phone\s*Code/i.test(bodyText) ||
      /Legal\s*Name/i.test(bodyText) ||
      /Phone\s*Device\s*Type/i.test(bodyText) ||
      Boolean(document.querySelector('input[data-automation-id="legalNameSection_firstName"], input[id*="legalName--firstName"], [data-automation-id="myInformationPage"]'))
    ) {
      return 'My Information';
    }
    if (/Work Experience/i.test(bodyText) && (/Resume\/CV|Education|Skills/i.test(bodyText))) return 'My Experience';
    if (/Conflict of Interest/i.test(bodyText)) return 'Application Questions';
    if (
      Boolean(document.querySelector('[data-automation-id="selfIdentificationPage"], [data-automation-id*="selfIdentify" i]')) ||
      Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], legend')).some(el => isVisible(el) && /self[- ]?identif|disability|cc-?305/i.test(el.textContent || ''))
    ) {
      return 'Self Identify';
    }
    if (
      Boolean(document.querySelector('[data-automation-id="voluntaryDisclosuresPage"], [data-automation-id*="voluntaryDisclosures" i]')) ||
      Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], legend')).some(el => isVisible(el) && /voluntary\s*disclosures?/i.test(el.textContent || ''))
    ) {
      return 'Voluntary Disclosures';
    }

    return 'Unknown';
  });
}

/**
 * Double-verify with the DOM that the page is genuinely the Review & Submit page (last page of wizard).
 */
export async function isWorkdayReviewPage(page) {
  if (!page || page.isClosed()) return false;
  return await page.evaluate(() => {
    // 1. Explicit reviewPage container or review step
    if (document.querySelector('[data-automation-id="reviewPage"], [data-automation-id="reviewStep"]')) {
      return true;
    }

    // 2. Submit button presence (strictly genuine submit button, never 'Save and Continue' or generic submit type)
    const hasSubmitButton = Boolean(
      document.querySelector('[data-automation-id="pageFooterSubmitButton"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).some(b => /^\s*submit(?:\s+application)?\s*$/i.test((b.textContent || '').trim()))
    );

    // 3. Review heading or title
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"], [data-automation-id="step-title"], [data-automation-id="compositeHeader"]'));
    const hasReviewHeading = headings.some(h => /review\s*(?:and|&)\s*submit|review\s*(?:your\s*)?application|^review$/i.test((h.textContent || '').trim()));

    // 4. Progress bar active step is Review
    const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"], [data-automation-id*="wizardStep"][aria-current="step"], [data-automation-id*="currentStep"], li.active');
    const isReviewActiveStep = activeStep && /review/i.test(activeStep.textContent || '');

    // 5. Body text indicators
    const bodyText = (document.body?.innerText || '').slice(0, 5000);
    const hasReviewText = /review\s*(?:and|&)\s*submit|review\s*your\s*application/i.test(bodyText) || /review/i.test(document.title);

    if (hasSubmitButton && (hasReviewHeading || isReviewActiveStep || hasReviewText)) {
      return true;
    }
    if (hasReviewHeading && (hasSubmitButton || document.querySelectorAll('dt, [data-automation-id*="formField"]').length > 5)) {
      return true;
    }
    if (isReviewActiveStep && hasSubmitButton) {
      return true;
    }

    return false;
  }).catch(() => false);
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

/**
 * Checks if the current page or any open modal represents a successful submission confirmation.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdaySubmissionSuccess(page) {
  if (!page || page.isClosed()) return false;
  try {
    return await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && (el.offsetParent !== null || el.getClientRects().length > 0);
      };

      if (document.querySelector('[data-automation-id="submissionSuccess"], [data-automation-id="applicationSubmitted"], [data-automation-id="congratulations"], [data-automation-id="thankYouMessage"]')) {
        return true;
      }

      const href = window.location.href || '';
      if (/\/submitted\b|\/thankyou\b|\/application-submitted\b|\/applicationSubmitted\b/i.test(href)) {
        return true;
      }

      const popupEls = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [data-automation-id*="popup" i], [data-automation-id*="modal" i], h1, h2, h3, h4, div.wd-popup, #popup-container'
      ));

      for (const el of popupEls) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/congratulations/i.test(t) && /application\s*(?:has\s*been|is|was)?\s*(?:successfully\s*)?(?:submitted|received)/i.test(t)) {
          return true;
        }
        if (/your\s*application\s*has\s*been\s*successfully\s*submitted/i.test(t)) {
          return true;
        }
        if (/thank\s*you\s*(?:very\s*much\s*)?for\s*(?:applying|your\s*application)/i.test(t) && !/already\s*(?:applied|submitted)/i.test(t)) {
          return true;
        }
      }

      const bodyText = (document.body?.innerText || '').slice(0, 3000);
      if (/congratulations/i.test(bodyText) && /application\s*(?:has\s*been|is|was)?\s*(?:successfully\s*)?(?:submitted|received)/i.test(bodyText)) {
        return true;
      }

      return false;
    });
  } catch {
    return false;
  }
}
