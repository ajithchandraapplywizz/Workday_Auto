/**
 * discovery.mjs — Portal-aware form discovery
 *
 * Detects ATS platform (Greenhouse, Lever, Ashby, Workday, Gem, generic)
 * and navigates from JD page to the actual application form.
 */

// ─── ATS Detection ─────────────────────────────────────────────────────────
export function detectATS(url) {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  if (/myworkday|workday/i.test(url)) return 'workday';
  if (/jobs\.gem\.com/i.test(url)) return 'gem';
  if (/icims/i.test(url)) return 'icims';
  if (/smartrecruiters/i.test(url)) return 'smartrecruiters';
  return 'generic';
}

// ─── Check if an element is inside a nav or header ─────────────────────────
export async function isInNavOrHeader(el) {
  return await el.evaluate(node => {
    let cur = node;
    while (cur && cur !== document.body) {
      const tag = cur.tagName?.toLowerCase();
      const role = cur.getAttribute?.('role')?.toLowerCase();
      const autoId = cur.getAttribute?.('data-automation-id')?.toLowerCase() || '';
      if (
        tag === 'nav' || tag === 'header' ||
        role === 'navigation' || role === 'banner' ||
        autoId === 'header' || autoId === 'navbar' || autoId === 'pageheader' || autoId === 'top-nav'
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    const rect = node.getBoundingClientRect();
    if (rect.top < 70 && rect.bottom < 85) {
      const inMainOrDialog = node.closest('main, [role="main"], [role="dialog"], .modal, form, [data-automation-id*="page"]');
      if (!inMainOrDialog) return true;
    }
    return false;
  }).catch(() => false);
}

// ─── Pre-scan page & modal elements to detect gateway state ────────────────
export async function prescanGatewayElements(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], .modal, [data-automation-id*="modal"], [data-automation-id*="dialog"]');
    const root = modal || document;

    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea'));
    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));

    const hasEmailInput = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const type = (i.type || '').toLowerCase();
      return (type === 'email' || autoId.includes('email') || autoId.includes('username') || nameOrId.includes('email') || nameOrId.includes('username')) && i.offsetParent !== null;
    });

    const hasPasswordInput = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const isVerify = autoId.includes('verify') || nameOrId.includes('verify') || (i.placeholder || '').toLowerCase().includes('verify');
      return (i.type === 'password' || autoId.includes('password')) && !isVerify && i.offsetParent !== null;
    });

    const hasVerifyPassword = inputs.some(i => {
      const autoId = (i.getAttribute('data-automation-id') || '').toLowerCase();
      const nameOrId = (i.name || i.id || '').toLowerCase();
      const isVerify = autoId.includes('verify') || nameOrId.includes('verify') || (i.placeholder || '').toLowerCase().includes('verify');
      return isVerify && i.offsetParent !== null;
    });

    const ssoWithEmailBtn = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return (t === 'sign in with email' || t === 'continue with email' || t === 'log in with email' || t.includes('sign in with email')) && b.offsetParent !== null;
    });

    const hasSocialSSO = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return (t.includes('google') || t.includes('apple') || t.includes('linkedin')) && b.offsetParent !== null;
    });

    const hasCreateAccountBtn = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      const autoId = b.getAttribute('data-automation-id') || '';
      return (t === 'create account' || autoId === 'createAccountLink' || autoId === 'createAccountSubmitButton' || autoId === 'createAccountTab') && b.offsetParent !== null;
    });

    const hasSignInUnderCreateAccount = buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      const autoId = b.getAttribute('data-automation-id') || '';
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      const isSubmit = autoId === 'signInSubmitButton' || b.getAttribute('type') === 'submit';
      return (t === 'sign in' || autoId === 'signInLink' || autoId === 'signInTab') && !inNav && !isSubmit && b.offsetParent !== null;
    });

    const hasWizardFields = !!document.querySelector('input[data-automation-id="legalNameSection_firstName"], button[data-automation-id="bottom-navigation-next-button"], [data-automation-id*="wizardStep"]');

    const hasApplyBtn = buttons.some(b => {
      const autoId = b.getAttribute('data-automation-id') || '';
      const t = (b.textContent || '').trim().toLowerCase();
      const inNav = !!b.closest('nav, header, [role="navigation"], [role="banner"]');
      return !inNav && (autoId === 'adventureButton' || autoId === 'applyButton' || autoId === 'jobPostingApplyButton' || t === 'apply' || t === 'apply now' || t === 'apply for this job') && b.offsetParent !== null;
    });

    return {
      hasActiveModal: !!modal,
      hasWizardFields,
      hasApplyBtn,
      hasEmailInput,
      hasPasswordInput,
      hasVerifyPassword,
      hasSocialSSO,
      hasSignInWithEmailBtn: ssoWithEmailBtn,
      hasCreateAccountBtn,
      hasSignInUnderCreateAccount,
    };
  }).catch(() => ({}));
}

// ─── Adaptive Gateway Handler post-Apply ───────────────────────────────────
export async function handleAdaptiveGateway(page, mode = 'signin') {
  console.log(`   Scanning page & gateway elements post-apply (mode: "${mode}")...`);
  await page.waitForTimeout(1000);

  const scan = await prescanGatewayElements(page);
  console.log('   Pre-scan elements:', JSON.stringify(scan));

  if (scan.hasActiveModal) {
    console.log('   ℹ️  Modal dialog detected — scanning and filling fields inside modal without closing it.');
  }

  // 1. Social SSO Screen with "Sign in with email"
  if (scan.hasSignInWithEmailBtn) {
    console.log('   🔗 Pre-scan: Detected Social SSO gateway — clicking "Sign in with email"...');
    const ssoBtns = await page.$$('button:has-text("Sign in with email"), a:has-text("Sign in with email"), button:has-text("Continue with email"), a:has-text("Continue with email"), [data-automation-id*="email"]');
    for (const btn of ssoBtns) {
      if (await btn.isVisible().catch(() => false)) {
        if (await isInNavOrHeader(btn)) continue;
        await btn.click({ force: true }).catch(() => btn.evaluate(el => el.click()));
        await page.waitForTimeout(2000);
        break;
      }
    }
  }

  // 2. Post-SSO state check
  const postScan = await prescanGatewayElements(page);

  if (mode === 'signin') {
    // If verifyPassword, createAccountBtn, or link under create account is present, click "Sign In" link
    if (postScan.hasVerifyPassword || postScan.hasCreateAccountBtn || postScan.hasSignInUnderCreateAccount) {
      console.log('   🔗 Pre-scan: Detected Create Account gateway — clicking "Sign In" link below Create Account button...');
      await clickGatewaySignIn(page);
    }
    // Wait for password input to appear
    try {
      await page.waitForSelector('input[data-automation-id="password"]:visible, input[type="password"]:visible', { timeout: 8000 });
      console.log('   ✅ Sign-in form ready (password input visible).');
    } catch {
      console.log('   ⚠️  Waiting for sign-in form inputs...');
    }
  } else if (mode === 'signup') {
    if (postScan.hasPasswordInput && !postScan.hasVerifyPassword && postScan.hasCreateAccountBtn) {
      console.log('   🔗 Pre-scan: On Sign In screen in signup mode — clicking "Create Account"...');
      await clickGatewayCreateAccount(page);
    }
    try {
      await page.waitForSelector('input[data-automation-id="verifyPassword"]:visible, input[data-automation-id="email"]:visible', { timeout: 8000 });
      console.log('   ✅ Create Account form ready.');
    } catch {}
  }
}

// ─── Check if Workday sign-in form inputs are already visible ──────────────
export async function isSignInFormVisible(page) {
  const pwd = await page.$('input[data-automation-id="password"]:visible, input[type="password"]:visible').catch(() => null);
  const verifyPwd = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  // Must have password AND NOT verifyPassword
  return !!(pwd && !verifyPwd);
}

// ─── Click the gateway "Sign In" link (below Create Account, not nav bar) ───
export async function clickGatewaySignIn(page) {
  // Try candidates inside modal dialog first, then main document
  const candidates = await page.$$([
    '[role="dialog"] [data-automation-id="signInLink"]',
    '[role="dialog"] [data-automation-id="signInTab"]',
    '[role="dialog"] button:has-text("Sign In")',
    '[role="dialog"] a:has-text("Sign In")',
    '[data-automation-id="signInLink"]',
    '[data-automation-id="signInTab"]',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
  ].join(', '));

  for (const el of candidates) {
    if (!await el.isVisible().catch(() => false)) continue;
    const autoId = await el.getAttribute('data-automation-id').catch(() => '');
    const type = await el.getAttribute('type').catch(() => '');

    // Skip submit buttons
    if (autoId === 'signInSubmitButton' || type === 'submit') continue;

    // Skip elements inside top nav/header
    if (await isInNavOrHeader(el)) continue;

    console.log('   Clicking gateway "Sign In" link (below Create Account, not nav bar)...');
    await el.click({ force: true }).catch(() => el.evaluate(e => e.click()));
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

// ─── Click the gateway "Create Account" button/tab (not nav bar) ───────────
export async function clickGatewayCreateAccount(page) {
  const verifyPwd = await page.$('input[data-automation-id="verifyPassword"]:visible').catch(() => null);
  if (verifyPwd) {
    console.log('   Create Account form is already visible.');
    return true;
  }

  const buttons = await page.$$([
    '[role="dialog"] button[data-automation-id="createAccountLink"]',
    '[role="dialog"] button:has-text("Create Account")',
    'button[data-automation-id="createAccountLink"]',
    '[data-automation-id="createAccountTab"]',
    'button:has-text("Create Account")',
    'a:has-text("Create Account")',
  ].join(', '));

  for (const btn of buttons) {
    if (!await btn.isVisible().catch(() => false)) continue;
    const autoId = await btn.getAttribute('data-automation-id').catch(() => '');
    const type = await btn.getAttribute('type').catch(() => '');

    if (autoId === 'createAccountSubmitButton' || type === 'submit') continue;
    if (await isInNavOrHeader(btn)) continue;

    console.log('   Clicking gateway "Create Account" button (not nav bar)...');
    await btn.click({ force: true }).catch(() => btn.evaluate(e => e.click()));
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

// ─── Portal-aware form discovery ────────────────────────────────────────────
// Each ATS has different patterns for getting from JD page to form.
export async function discoverApplicationForm(page, originalUrl, { mode = 'signin' } = {}) {
  const currentUrl = page.url();

  // Strategy 1: Greenhouse — check for #app anchor or embedded form
  if (currentUrl.includes('greenhouse.io')) {
    if (!currentUrl.includes('#app')) {
      console.log('🌿 Greenhouse detected — looking for application form...');

      const hasJobContent = await page.$('.job-post, #job_post, .opening, [data-mapped="true"], #app_body');
      if (!hasJobContent) {
        const jobLink = await page.$(`a[href*="${originalUrl.split('/').pop()}"]`);
        if (jobLink) {
          console.log('  📎 Clicking through to specific job...');
          await jobLink.click();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(2000);
        }
      }

      const applySelectors = [
        'a:has-text("Apply for this job")',
        'a:has-text("Apply")',
        'button:has-text("Apply for this job")',
        'button:has-text("Apply")',
        'a[href*="#app"]',
        '#apply_button',
        '.apply-button',
        'a.postings-btn',
      ];

      for (const sel of applySelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            const text = await btn.textContent();
            console.log(`  📎 Found: "${text.trim()}" — clicking...`);
            await btn.click();
            await page.waitForTimeout(2000);
            try {
              await page.waitForSelector('input[type="text"], input[type="email"], textarea', { timeout: 5000 });
            } catch { /* form might be further down */ }
            break;
          }
        } catch { /* selector not found, try next */ }
      }

      await page.evaluate(() => {
        const appSection = document.getElementById('application') || document.getElementById('app_body') || document.getElementById('app');
        if (appSection) appSection.scrollIntoView({ behavior: 'instant' });
        else window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(1000);
    }
    return page.url();
  }

  // Strategy 2: Lever — forms are on /apply/ path
  if (currentUrl.includes('lever.co') && !currentUrl.includes('/apply')) {
    console.log('🔧 Lever detected — looking for application form...');
    const applyLink = await page.$('a[href*="/apply"], a.postings-btn:has-text("Apply")');
    if (applyLink) {
      const href = await applyLink.getAttribute('href');
      if (href) {
        const resolvedHref = new URL(href, currentUrl).toString();
        console.log(`  📎 Navigating to Lever form: ${resolvedHref}`);
        await page.goto(resolvedHref, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        return page.url();
      }
    }
  }

  // Strategy 3: Ashby — forms are embedded or on /application path
  if (currentUrl.includes('ashbyhq.com') && !currentUrl.includes('/application')) {
    console.log('🏗️  Ashby detected — looking for application form...');
    const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForTimeout(2000);
      try {
        await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 5000 });
      } catch { /* form might load differently */ }
      return page.url();
    }
  }

  // Strategy 4: Workday — JD page to Apply / Login / Form
  if (currentUrl.includes('workday') || currentUrl.includes('myworkday')) {
    console.log('📋 Workday detected — navigating to application form...');

    // Accept cookie notice if present
    try {
      const cookieBtn = await page.$('button[data-automation-id="legalNoticeAcceptButton"], button:has-text("Accept Cookies"), button:has-text("Accept all"), button:has-text("Accept")');
      if (cookieBtn && await cookieBtn.isVisible().catch(() => false)) {
        console.log('   Dismissing cookie banner...');
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}

    // 1. Check if already on wizard form (Step 1..5)
    const isAlreadyOnWizard = await page.$([
      'button:has-text("Save and Continue")',
      'button:has-text("Save & Continue")',
      'button[data-automation-id="bottom-navigation-next-button"]',
      'input[data-automation-id="legalNameSection_firstName"]',
      '[data-automation-id*="wizardStep"]',
    ].join(', ')).catch(() => null);

    if (isAlreadyOnWizard && await isAlreadyOnWizard.isVisible().catch(() => false)) {
      console.log('   Already on Workday application wizard.');
      return page.url();
    }

    // 2. Target initial Apply button on JD page (excluding nav/header links)
    const workdayApplySelectors = [
      'a[data-automation-id="adventureButton"]',
      'a[data-automation-id="applyButton"]',
      'button[data-automation-id="applyButton"]',
      '[data-automation-id="jobPostingApplyButton"]',
      'a[data-automation-id*="apply" i]',
      'button[data-automation-id*="apply" i]',
      'a[data-uxi-element-id*="apply"]',
      'button[data-uxi-element-id*="apply"]',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ];

    let applyBtn = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const sel of workdayApplySelectors) {
        try {
          const btns = await page.$$(sel);
          for (const btn of btns) {
            if (await btn.isVisible().catch(() => false)) {
              if (await isInNavOrHeader(btn)) continue;
              applyBtn = btn;
              break;
            }
          }
        } catch {}
        if (applyBtn) break;
      }
      if (applyBtn) break;
      await page.waitForTimeout(1000);
    }

    if (applyBtn) {
      const text = (await applyBtn.textContent().catch(() => '')).trim();
      console.log(`   Found initial Workday Apply button: "${text || 'Apply'}" — clicking...`);
      await applyBtn.click({ force: true }).catch(() => applyBtn.evaluate(el => el.click()));
      await page.waitForTimeout(2000);

      // Check for popup choices — explicitly click "Apply Manually"
      const manualApplySelectors = [
        '[data-automation-id="applyManually"]',
        'a[data-automation-id="applyManually"]',
        'button[data-automation-id="applyManually"]',
        'a:has-text("Apply Manually")',
        'button:has-text("Apply Manually")',
        'a[href*="applyManually"]',
        'span:has-text("Apply Manually")',
        'div:has-text("Apply Manually")',
      ];

      console.log('   Waiting for "Apply Manually" popup option...');
      let manualClicked = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        for (const sel of manualApplySelectors) {
          try {
            const opt = await page.$(sel);
            if (opt && await opt.isVisible().catch(() => false)) {
              const optText = (await opt.textContent().catch(() => '')).trim();
              console.log(`   Selecting Workday apply option: "${optText || 'Apply Manually'}"...`);
              await opt.click({ force: true }).catch(() => opt.evaluate(el => el.click()));
              manualClicked = true;
              await page.waitForTimeout(2000);
              break;
            }
          } catch {}
        }
        if (manualClicked) break;
        await page.waitForTimeout(500);
      }

      // 3. Post-Apply Gateway Handling with adaptive element pre-scan
      await handleAdaptiveGateway(page, mode);

      try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(2000);
      return page.url();
    }

    return page.url();
  }

  // Strategy 5: Gem — direct application pages
  if (currentUrl.includes('jobs.gem.com')) {
    console.log('💎 Gem detected — looking for application form...');
    const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForTimeout(2000);
      try {
        await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 5000 });
      } catch {}
      return page.url();
    }
  }

  // Strategy 6: Generic — look for any Apply link/button and follow it
  const genericApply = await page.$([
    'a:has-text("Apply for this job")',
    'a:has-text("Apply Now")',
    'a:has-text("Apply")',
    'button:has-text("Apply for this job")',
    'button:has-text("Apply Now")',
  ].join(', '));

  if (genericApply) {
    const tagName = await genericApply.evaluate(el => el.tagName.toLowerCase());
    const text = await genericApply.textContent();

    if (tagName === 'a') {
      const href = await genericApply.getAttribute('href');
      if (href && !href.startsWith('javascript') && !href.startsWith('#')) {
        const resolvedHref = new URL(href, currentUrl).toString();
        console.log(`  📎 Generic apply link: "${text.trim()}" → ${resolvedHref}`);
        await page.goto(resolvedHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
        await page.waitForTimeout(2000);
        return page.url();
      }
    }

    console.log(`  📎 Clicking: "${text.trim()}"...`);
    await genericApply.click();
    await page.waitForTimeout(2000);
    return page.url();
  }

  return null;
}

// ─── Extract JD text from page (for resume matching) ────────────────────────
export async function extractJDText(page) {
  return page.evaluate(() => {
    const selectors = [
      '.job-post-content', '.job-description', '.posting-description',
      '#job-description', '.description', '[class*="jobDescription"]',
      '[class*="job-details"]', 'article', 'main',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) return el.textContent.trim();
    }
    return document.body?.innerText?.substring(0, 5000) || '';
  });
}
