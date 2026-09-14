/**
 * workdaySkills.mjs — Workday "Type to Add Skills" multi-select.
 *
 * Optional Skills: never fill.
 * Required Skills: parse the resume, add exactly 2 skills, type + click autocomplete.
 */

import { waitForDomSettled } from './workdayDom.mjs';
import { WORKDAY_DEFAULT_SKILLS } from './workdayDefaults.mjs';
import { extractResumeSkillNames, getResumePathForApply, loadResumeText } from './resumeParser.mjs';

const REQUIRED_SKILL_COUNT = 2;

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function parseSkillsList(answer) {
  if (Array.isArray(answer)) return answer.map((s) => norm(s)).filter(Boolean);
  if (!answer) return [];
  return String(answer)
    .split(/[,;|]/)
    .map((s) => norm(s))
    .filter(Boolean);
}

function uniqueSkills(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const skill = norm(raw);
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
}

/**
 * Two skills only: profile/resume first, then two safe defaults if the PDF is empty.
 * @param {object} profile
 * @returns {Promise<string[]>}
 */
export async function resolveTwoResumeSkills(profile = {}) {
  const fromProfile = [
    ...parseSkillsList(profile.skills),
    ...parseSkillsList(profile.experience?.skills),
    ...parseSkillsList(profile.qa_answers?.['type to add skills'] || profile.qa_answers?.skills),
  ];

  let fromResume = [];
  if (profile._resumeText) {
    fromResume = extractResumeSkillNames(profile._resumeText);
  } else {
    try {
      const resumePath = await getResumePathForApply(profile);
      if (resumePath) {
        const text = await loadResumeText(resumePath);
        if (text) {
          profile._resumeText = text;
          fromResume = extractResumeSkillNames(text);
        }
      }
    } catch {
      /* resume parse is best-effort */
    }
  }

  return uniqueSkills([...fromProfile, ...fromResume, ...WORKDAY_DEFAULT_SKILLS])
    .slice(0, REQUIRED_SKILL_COUNT);
}

/** @deprecated Use resolveTwoResumeSkills — kept for callers that expect a sync list. */
export function getProfileSkills(profile = {}) {
  const listed = uniqueSkills([
    ...parseSkillsList(profile.skills),
    ...parseSkillsList(profile.experience?.skills),
    ...parseSkillsList(profile.qa_answers?.['type to add skills'] || profile.qa_answers?.skills),
    ...(profile._resumeText ? extractResumeSkillNames(profile._resumeText) : []),
    ...WORKDAY_DEFAULT_SKILLS,
  ]);
  return listed.slice(0, REQUIRED_SKILL_COUNT);
}

async function locateSkillsInput(page) {
  const selectors = [
    page.locator('[data-automation-id*="formField"]').filter({ hasText: /type to add skills|enter a skill below|^skills$/i }).locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
    page.getByLabel(/type to add skills|^skills$/i).first(),
    page.locator('input[placeholder*="skill" i]').first(),
    page.locator('[data-automation-id*="skills"] input').first(),
  ];
  for (const loc of selectors) {
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) return loc;
  }
  return null;
}

async function clickSkillOption(page, skillQuery) {
  const query = norm(skillQuery);
  if (!query) return false;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');
  const optionLocators = [
    page.locator('[role="option"]').filter({ hasText: re }).first(),
    page.locator('[data-automation-id="promptOption"]').filter({ hasText: re }).first(),
    page.locator('[role="listbox"] [role="option"]').filter({ hasText: re }).first(),
  ];
  for (const opt of optionLocators) {
    if (await opt.isVisible({ timeout: 900 }).catch(() => false)) {
      await opt.click({ force: true });
      return true;
    }
  }

  const firstAuto = page.locator('[role="option"]:visible, [data-automation-id="promptOption"]:visible').first();
  if (await firstAuto.isVisible({ timeout: 700 }).catch(() => false)) {
    await firstAuto.click({ force: true });
    return true;
  }
  return false;
}

/**
 * Fill required Skills only: type 2 resume skills and click the autocomplete row.
 */
export async function fillWorkdaySkillsField(page, skillsInput, profile = {}) {
  const skills = await resolveTwoResumeSkills(profile);
  const input = skillsInput || await locateSkillsInput(page);
  if (!input) {
    console.log('    ⚠️  Skills input not found on page');
    return false;
  }

  const alreadySelected = await page.evaluate(() => {
    const chips = document.querySelectorAll('[data-automation-id*="selectedItem"], [data-automation-id*="chip"], [data-automation-id*="pill"]');
    return Array.from(chips).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  }).catch(() => []);

  if (alreadySelected.length >= REQUIRED_SKILL_COUNT) {
    console.log(`    ✓ Skills already has ${alreadySelected.length} chip(s) — enough`);
    return true;
  }

  let added = alreadySelected.length;
  console.log(`    🎯 Required Skills: adding ${skills.length} resume skill(s) (type + autocomplete)`);

  for (const skill of skills) {
    if (added >= REQUIRED_SKILL_COUNT) break;
    const query = skill.toLowerCase();
    if (alreadySelected.some((s) => s.toLowerCase().includes(query) || query.includes(s.toLowerCase()))) {
      console.log(`    ✓ Skill already selected: ${skill}`);
      added++;
      continue;
    }

    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click({ force: true }).catch(() => {});
    await input.fill('').catch(() => {});
    await page.waitForTimeout(120);
    await input.pressSequentially(skill, { delay: 35 }).catch(() => input.type(skill, { delay: 35 }));
    await page.waitForTimeout(450);

    const picked = await clickSkillOption(page, skill);
    if (!picked) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(400);
      await clickSkillOption(page, skill);
    }

    added++;
    console.log(`    ✅ Skill typed + autocomplete: ${skill}`);
    await waitForDomSettled(page);
    await page.waitForTimeout(250);
  }

  return added > 0;
}

export async function isSkillsFieldRequired(page) {
  return await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, legend, [data-automation-id*="label"], [data-automation-id*="richText"], h2, h3, h4'));
    for (const el of labels) {
      const text = norm(el.textContent);
      if (!/^(skills?|type to add skills|enter a skill below)/i.test(text) && !/type to add skills|enter a skill below/i.test(text)) {
        continue;
      }
      if (/\*/.test(text) || /\brequired\b/i.test(text)) return true;
      const field = el.closest('[data-automation-id*="formField"]') || el.parentElement;
      if (field?.querySelector?.('[aria-required="true"]')) return true;
    }
    const inputs = document.querySelectorAll('input[placeholder*="skill" i], input[aria-label*="skill" i]');
    for (const input of inputs) {
      if (input.required || input.getAttribute('aria-required') === 'true') return true;
    }
    return false;
  }).catch(() => false);
}

export async function fillWorkdaySkillsSection(page, profile = {}) {
  const hasSkills = await page.evaluate(() =>
    /type to add skills|enter a skill below|^skills\b/i.test(document.body?.innerText || '')
  ).catch(() => false);
  if (!hasSkills) return false;
  if (profile?._fillOptionalFields !== true && !(await isSkillsFieldRequired(page))) {
    console.log('    ⏭️  Skills optional — skipped');
    return false;
  }
  return await fillWorkdaySkillsField(page, null, profile);
}
