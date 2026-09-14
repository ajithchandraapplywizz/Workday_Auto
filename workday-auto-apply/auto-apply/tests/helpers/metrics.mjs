/**
 * Sidecar metrics for the agent test report. No PII.
 */

import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname } from 'path';

export const FAILURE = {
  F1: 'DOM/field detection failure',
  F2: 'control-type classification failure',
  F3: 'Playwright interaction failure',
  F4: 'question-understanding failure',
  F5: 'profile-data retrieval failure',
  F6: 'answer-generation failure',
  F7: 'option-mapping failure',
  F8: 'validation failure',
  F9: 'dynamic-question detection failure',
  F10: 'navigation failure',
  F11: 'verification failure',
  F12: 'unexpected UI failure',
};

export function metricsPath() {
  return process.env.AGENT_METRICS_PATH || '';
}

export function metric(phase, name, ok, extra = {}) {
  const file = metricsPath();
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({
    phase,
    name,
    ok: Boolean(ok),
    code: extra.code || '',
    detail: extra.detail || '',
    ...extra,
  })}\n`);
}

export function readMetrics(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function rate(rows, name) {
  const hits = rows.filter((r) => r.name === name);
  if (!hits.length) return null;
  const ok = hits.filter((r) => r.ok).length;
  return ok / hits.length;
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}
