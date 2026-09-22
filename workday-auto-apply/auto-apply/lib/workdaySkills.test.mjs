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

test('resolveTwoResumeSkills returns exactly one skill from the resume', async () => {
  const two = await resolveTwoResumeSkills({
    _resumeText: 'CORE SKILLS\nPython, JavaScript, Docker\nEXPERIENCE\nRole',
  });
  assert.equal(two.length, 1);
  assert.equal(two[0], 'Python');
});

test('getProfileSkills never dumps more than one skill', () => {
  const listed = getProfileSkills({
    skills: ['Python', 'Java', 'Go', 'Rust'],
  });
  assert.equal(listed.length, 1);
});

test('parseSkillsList splits a comma list', () => {
  assert.deepEqual(parseSkillsList('Python, SQL'), ['Python', 'SQL']);
});

test('extractResumeSkillNames discards degrees and education words', () => {
  const text = `
EDUCATION
Master of Science in Computer Science, GPA: 3.8
Bachelor of Technology, Osmania University

TECHNICAL SKILLS
Python, JavaScript, React, Node.js, SQL
`;
  const skills = extractResumeSkillNames(text);
  assert.ok(skills.includes('Python'));
  assert.ok(skills.includes('JavaScript'));
  assert.ok(!skills.some((s) => /master|bachelor|degree|university|science/i.test(s)));
});

test('resolveTwoResumeSkills strips degrees even if in profile.skills', async () => {
  const skills = await resolveTwoResumeSkills({
    skills: ['Master of Science', 'Master of Computer Science', 'Python', 'SQL'],
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0], 'Python');
});
