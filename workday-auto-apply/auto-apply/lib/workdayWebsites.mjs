/**
 * workdayWebsites.mjs — My Experience "Websites" section
 *
 * - If profile has LinkedIn/website URL → paste into Websites 1 URL only
 * - If no URL and row is empty → click Delete on Websites 1
 * - Never click "Add another" or "Add Website"
 */

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function urlsMatch(a, b) {
  const x = norm(a).toLowerCase().replace(/\/+$/, '');
  const y = norm(b).toLowerCase().replace(/\/+$/, '');
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** @param {object} profile */
function getWebsiteUrl(profile) {
  return norm(profile?.personal?.linkedin)
    || norm(profile?.personal?.website)
    || norm(profile?.qa_answers?.linkedin)
    || norm(profile?.qa_answers?.url)
    || norm(profile?.qa_answers?.website)
    || '';
}

/**
 * Locate the URL input inside Websites 1 (or first websites row).
 * @param {import('playwright').Page} page
 */
async function findWebsitesUrlInput(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-wd-website-url]').forEach((el) => el.removeAttribute('data-wd-website-url'));
  });

  const markerId = await page.evaluate(() => {
    const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const findWebsitesRoot = () => {
      for (const h of document.querySelectorAll('h1,h2,h3,h4,legend,[data-automation-id*="title"],[data-automation-id*="heading"]')) {
        const t = normalize(h.textContent);
        if (/^websites\s*1$/i.test(t) || /^websites$/i.test(t)) {
          return h.closest('[data-automation-id*="section"], [data-automation-id*="Section"], [data-automation-id*="panel"], fieldset, [role="group"]')
            || h.parentElement?.parentElement;
        }
      }
      return document.querySelector('[data-automation-id*="websitesSection"], [data-automation-id*="websiteSection"]');
    };

    const root = findWebsitesRoot();
    if (!root) return null;

    for (const labelEl of root.querySelectorAll('label, [data-automation-id*="label"], [data-automation-id*="richText"]')) {
      const labelText = normalize(labelEl.textContent).replace(/\*+$/, '');
      if (!/^url$/i.test(labelText)) continue;

      const field = labelEl.closest('[data-automation-id*="formField"]') || labelEl.parentElement?.parentElement;
      const input = field?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if (!input) continue;

      const id = `wd-web-${Math.random().toString(36).slice(2, 8)}`;
      input.setAttribute('data-wd-website-url', id);
      return { id, value: normalize(input.value) };
    }
    return null;
  });

  if (!markerId?.id) return null;
  return {
    locator: page.locator(`[data-wd-website-url="${markerId.id}"]`).first(),
    value: markerId.value || '',
  };
}

/**
 * Click Delete on Websites 1 row only (scoped — not work/education delete).
 * @param {import('playwright').Page} page
 */
async function deleteWebsites1Row(page) {
  const heading = page.locator('h1,h2,h3,h4,legend,[data-automation-id*="title"],[data-automation-id*="heading"]')
    .filter({ hasText: /^websites\s*1$/i })
    .first();

  let deleteBtn = null;

  if (await heading.isVisible({ timeout: 600 }).catch(() => false)) {
    const panel = heading.locator(
      'xpath=ancestor::*[contains(@data-automation-id,"Panel") or contains(@data-automation-id,"panel") or contains(@data-automation-id,"section") or self::fieldset][1]'
    );
    deleteBtn = panel.locator('button').filter({ hasText: /^delete$/i }).first();
  }

  if (!deleteBtn || !(await deleteBtn.isVisible({ timeout: 400 }).catch(() => false))) {
    const websitesSection = page.locator('[data-automation-id*="websitesSection"], [data-automation-id*="websiteSection"]').first();
    deleteBtn = websitesSection.locator('button').filter({ hasText: /^delete$/i }).first();
  }

  if (!(await deleteBtn?.isVisible({ timeout: 600 }).catch(() => false))) {
    return false;
  }

  await deleteBtn.scrollIntoViewIfNeeded().catch(() => {});
  await deleteBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(450);
  return true;
}

/**
 * Handle Websites on My Experience — fill one URL or delete empty row.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @returns {Promise<boolean>}
 */
export async function handleWebsitesSection(page, profile = {}) {
  console.log('\n  ▶ WEBSITES — fill URL or delete empty (no Add another)');

  const url = getWebsiteUrl(profile);
  const field = await findWebsitesUrlInput(page);

  if (!field) {
    console.log('    ℹ️  Websites URL field not on page — skipping');
    return false;
  }

  const current = norm(await field.locator.inputValue().catch(() => field.value));

  if (url) {
    if (urlsMatch(current, url)) {
      console.log(`    ✓ URL already set: "${current}"`);
      return true;
    }
    await field.locator.scrollIntoViewIfNeeded().catch(() => {});
    await field.locator.click({ force: true }).catch(() => {});
    await field.locator.fill(url);
    await field.locator.press('Tab').catch(() => {});
    const after = norm(await field.locator.inputValue().catch(() => ''));
    if (after) {
      console.log(`    ✅ Websites 1 URL ← "${after}"`);
      profile.qa_answers = profile.qa_answers || {};
      profile.qa_answers.url = after;
      return true;
    }
    console.log('    ⚠️  URL fill did not stick');
    return false;
  }

  if (!current) {
    const deleted = await deleteWebsites1Row(page);
    if (deleted) {
      console.log('    🗑️  Deleted empty Websites 1 (no link in profile)');
      return true;
    }
    console.log('    ℹ️  Empty Websites 1 — Delete button not found, continuing');
    return false;
  }

  console.log(`    ℹ️  Websites 1 has existing URL, no profile link to add: "${current}"`);
  return true;
}
