/**
 * compensationPick.mjs — Pick salary/compensation options from live DOM choices.
 *
 * For range/checkbox options like "Above $10,000 per month", pick the highest
 * threshold the applicant still qualifies for (expected >= threshold). Prefer
 * "more than X" tiers, never under-state vs stored expected compensation.
 */

import { isHourlyWageQuestion, lookupSemanticCompensationAnswer } from './qaStore.mjs';

function parseNumericToken(raw = '') {
  const text = String(raw || '').replace(/,/g, '').trim();
  const kMatch = text.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) return Number(kMatch[1]) * 1000;
  const numMatch = text.match(/(\d+(?:\.\d+)?)/);
  return numMatch ? Number(numMatch[1]) : null;
}

function detectPeriod(text = '') {
  const t = String(text || '').toLowerCase();
  if (/\b(hour|hr|hourly|per hour)\b/.test(t)) return 'hour';
  if (/\b(month|mo|monthly|per month)\b/.test(t)) return 'month';
  if (/\b(year|annual|annually|yearly|per year)\b/.test(t)) return 'year';
  return 'year';
}

export function toAnnualAmount(amount, period = 'year') {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (period === 'hour') return n * 2080;
  if (period === 'month') return n * 12;
  return n;
}

export function getExpectedCompensationAnnual(profile = null) {
  const raw = profile?.compensation
    || profile?.salary
    || profile?.experience?.desired_salary
    || lookupSemanticCompensationAnswer('desired salary', profile, profile?._tenant || '');
  const period = detectPeriod(String(raw));
  const amount = parseNumericToken(String(raw));
  if (!amount) return null;
  return toAnnualAmount(amount, period);
}

/**
 * Parse a single option label into a comparable structure.
 * @returns {{ kind: string, min: number|null, max: number|null, period: string, text: string }}
 */
export function parseCompensationOption(optionText = '') {
  const text = String(optionText || '').replace(/\s+/g, ' ').trim();
  const period = detectPeriod(text);
  const lower = text.toLowerCase();

  const range = text.match(/(\d[\d,k.\s]*)\s*[-–—to]+\s*(\d[\d,k.\s]*)/i);
  if (range) {
    const min = parseNumericToken(range[1]);
    const max = parseNumericToken(range[2]);
    return { kind: 'range', min, max, period, text };
  }

  const above = text.match(/(?:above|over|more\s+than|greater\s+than|at\s+least|minimum|\+)\s*\$?\s*([\d,k.]+)/i)
    || text.match(/\$?\s*([\d,k.]+)\s*\+/);
  if (above || /above|over|more\s+than|greater\s+than|at\s+least/i.test(lower)) {
    const min = parseNumericToken(above?.[1] || text);
    return { kind: 'above', min, max: null, period, text };
  }

  const below = text.match(/(?:below|under|less\s+than|up\s+to|maximum)\s*\$?\s*([\d,k.]+)/i);
  if (below || /below|under|less\s+than|up\s+to/i.test(lower)) {
    const max = parseNumericToken(below?.[1] || text);
    return { kind: 'below', min: null, max, period, text };
  }

  const lone = parseNumericToken(text);
  if (lone) return { kind: 'exact', min: lone, max: lone, period, text };

  return { kind: 'unknown', min: null, max: null, period, text };
}

function optionQualifies(parsed, expectedAnnual) {
  if (!expectedAnnual || !parsed) return { qualifies: false, score: 0 };

  const minA = parsed.min != null ? toAnnualAmount(parsed.min, parsed.period) : null;
  const maxA = parsed.max != null ? toAnnualAmount(parsed.max, parsed.period) : null;

  if (parsed.kind === 'above' && minA != null) {
    // Expected must meet or exceed the "above X" threshold.
    if (expectedAnnual >= minA) {
      return { qualifies: true, score: minA };
    }
    return { qualifies: false, score: minA };
  }

  if (parsed.kind === 'below' && maxA != null) {
    if (expectedAnnual <= maxA) {
      return { qualifies: true, score: maxA };
    }
    return { qualifies: false, score: maxA };
  }

  if (parsed.kind === 'range' && minA != null && maxA != null) {
    if (expectedAnnual >= minA && expectedAnnual <= maxA) {
      return { qualifies: true, score: maxA };
    }
    if (expectedAnnual >= maxA) {
      return { qualifies: true, score: maxA };
    }
    if (expectedAnnual >= minA) {
      return { qualifies: true, score: minA };
    }
    return { qualifies: false, score: maxA };
  }

  if (parsed.kind === 'exact' && minA != null) {
    const diff = Math.abs(expectedAnnual - minA);
    return { qualifies: diff / expectedAnnual < 0.35, score: -diff };
  }

  return { qualifies: false, score: 0 };
}

/**
 * Pick the best compensation option from live DOM choices.
 * Prefers highest qualifying "above X" tier; falls back to lowest threshold if none qualify.
 */
export function pickCompensationFromOptions(options = [], profile = null, preferred = '') {
  const list = (options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!list.length) return preferred || null;

  const expectedAnnual = getExpectedCompensationAnnual(profile);
  if (!expectedAnnual) return preferred || list[0];

  const scored = list.map((text) => {
    const parsed = parseCompensationOption(text);
    const { qualifies, score } = optionQualifies(parsed, expectedAnnual);
    return { text, parsed, qualifies, score };
  });

  const qualifying = scored.filter((s) => s.qualifies);
  if (qualifying.length) {
    qualifying.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.text.length - a.text.length;
    });
    return qualifying[0].text;
  }

  // No perfect match — pick lowest "above" threshold (still conservative vs overstating).
  const aboveOnly = scored
    .filter((s) => s.parsed.kind === 'above' && s.parsed.min != null)
    .sort((a, b) => {
      const aMin = toAnnualAmount(a.parsed.min, a.parsed.period) || 0;
      const bMin = toAnnualAmount(b.parsed.min, b.parsed.period) || 0;
      return aMin - bMin;
    });
  if (aboveOnly.length) return aboveOnly[0].text;

  const numericPreferred = parseNumericToken(preferred);
  if (numericPreferred) {
    const prefAnnual = toAnnualAmount(numericPreferred, detectPeriod(String(preferred)));
    const byDistance = scored
      .filter((s) => s.parsed.min != null || s.parsed.max != null)
      .map((s) => {
        const anchor = s.parsed.max ?? s.parsed.min;
        const anchorAnnual = toAnnualAmount(anchor, s.parsed.period) || 0;
        return { text: s.text, dist: Math.abs(anchorAnnual - prefAnnual) };
      })
      .sort((a, b) => a.dist - b.dist);
    if (byDistance.length) return byDistance[0].text;
  }

  return preferred || list[list.length - 1];
}

/** Numeric string for plain text salary inputs (no option list). */
export function compensationInputValue(profile = null, label = '') {
  if (isHourlyWageQuestion(label) && profile?.compensation_hourly) {
    return String(profile.compensation_hourly);
  }
  const lookupLabel = isHourlyWageQuestion(label) ? label : 'desired salary';
  const raw = lookupSemanticCompensationAnswer(lookupLabel, profile, profile?._tenant || '');
  const amount = parseNumericToken(String(raw));
  if (!amount) return String(raw || '').trim();
  return String(Math.round(amount));
}
