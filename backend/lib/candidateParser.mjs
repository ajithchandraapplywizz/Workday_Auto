/**
 * candidateParser.mjs — Robust parser for candidate AWL IDs.
 * Handles:
 *  - JSON arrays: '["AWL-1568","AWL-26832"]' or '[\"AWL-1568\", \"AWL-26832\"]'
 *  - Comma-separated strings: 'AWL-1568, AWL-26832'
 *  - Raw JS arrays: ['AWL-1568', 'AWL-26832']
 *  - Single strings: 'AWL-1568'
 *  - Unescaped or malformed quotes/brackets: '["AWL-1568', '"AWL-26832"]'
 * Returns clean, deduped, uppercase array: ['AWL-1568', 'AWL-26832']
 */

export function parseCandidateAwlIds(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return Array.from(new Set(
      input.flatMap((item) => parseCandidateAwlIds(item))
    ));
  }

  const str = String(input).trim();
  if (!str) return [];

  // 1. Try native JSON.parse if it looks like a JSON array
  if (str.startsWith('[') && str.endsWith(']')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return Array.from(new Set(
          parsed.map((s) => String(s || '').replace(/["'\[\]\\]/g, '').trim().toUpperCase()).filter(Boolean)
        ));
      }
    } catch {}
  }

  // 2. Regex match all AWL-\d+ tokens
  const awlMatches = str.match(/AWL-[\w\d_-]+/gi);
  if (awlMatches && awlMatches.length > 0) {
    return Array.from(new Set(
      awlMatches.map((s) => s.replace(/["'\[\]\\]/g, '').trim().toUpperCase()).filter(Boolean)
    ));
  }

  // 3. Fallback: split by comma, semicolon, whitespace and strip quotes/brackets
  return Array.from(new Set(
    str.split(/[,;\s]+/)
      .map((s) => s.replace(/["'\[\]\\]/g, '').trim().toUpperCase())
      .filter((s) => s.length > 0 && s !== 'NULL' && s !== 'UNDEFINED')
  ));
}
