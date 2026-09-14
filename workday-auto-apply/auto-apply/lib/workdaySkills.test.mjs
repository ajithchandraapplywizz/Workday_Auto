import test from 'node:test';
import assert from 'node:assert/strict';

import { extractResumeSkillNames } from './resumeParser.mjs';
import { getProfileSkills, parseSkillsList, resolveTwoResumeSkills } from './workdaySkills.mjs';

test('extractResumeSkillNames reads a CORE SKILLS block', () => {
  const text = `
SUMMARY
Engineer

CORE SKILLS
Python, Machine Learning, TensorFlow, SQL

EXPERIENCE
Intern
`;
  const skills = extractResumeSkillNames(text);
  assert.ok(skills.includes('Python'));
  assert.ok(skills.includes('Machine Learning'));
});

test('resolveTwoResumeSkills returns exactly two skills from the resume', async () => {
  const two = await resolveTwoResumeSkills({
    _resumeText: 'CORE SKILLS\nPython, JavaScript, Docker\nEXPERIENCE\nRole',
  });
  assert.equal(two.length, 2);
  assert.equal(two[0], 'Python');
  assert.equal(two[1], 'JavaScript');
});

test('getProfileSkills never dumps more than two skills', () => {
  const listed = getProfileSkills({
    skills: ['Python', 'Java', 'Go', 'Rust'],
  });
  assert.equal(listed.length, 2);
});

test('parseSkillsList splits a comma list', () => {
  assert.deepEqual(parseSkillsList('Python, SQL'), ['Python', 'SQL']);
});
