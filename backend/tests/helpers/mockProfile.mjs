/**
 * Fake Apply Wizz payload → production mapper. Never hits the live API.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mapApplyWizzToProfile, buildApplyWizzQaIndex } from '../../lib/applyWizzClient.mjs';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/mock-applywizz.json');

export function loadMockApplyWizzPayload() {
  return JSON.parse(readFileSync(FIXTURE, 'utf-8'));
}

export function buildMockHydratedProfile(over = {}) {
  const data = loadMockApplyWizzPayload();
  const overlay = mapApplyWizzToProfile(data.client, data.additional_information);
  const qa = buildApplyWizzQaIndex(data.client, data.additional_information);
  return {
    _applyWizzHydrated: true,
    _applyWizzQa: qa,
    _applyWizzId: 'TEST-000',
    _persistAnswers: false,
    personal: { ...(overlay.personal || {}), ...(over.personal || {}) },
    work_auth: { ...(overlay.work_auth || {}), ...(over.work_auth || {}) },
    education: { ...(overlay.education || {}), ...(over.education || {}) },
    experience: {
      ...(overlay.experience || {}),
      current_company: 'Test Company',
      ...(over.experience || {}),
    },
    eeo: overlay.eeo || {},
    skills: over.skills || ['Python', 'JavaScript', 'React', 'SQL'],
    compensation: overlay.compensation,
    compensation_hourly: overlay.compensation_hourly,
    qa_answers: over.qa_answers || {},
    _projects: ['Project A', 'Project B'],
  };
}
