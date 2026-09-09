export function getTodayMMDDYYYY(timeZone = 'Asia/Kolkata', referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${values.month}/${values.day}/${values.year}`;
}

export function getTodayISODate(timeZone = 'Asia/Kolkata', referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

export function validateMMDDYYYY(value) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(String(value || '').trim());
}

export function validateISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

const DISALLOWED_DATE_PATTERNS = [
  /date\s+of\s+birth/i,
  /birth\s+date/i,
  /employment\s+start\s+date/i,
  /start\s+date/i,
  /employment\s+end\s+date/i,
  /end\s+date/i,
  /graduation\s+date/i,
  /visa\s+expiration/i,
  /expiration\s+date/i,
  /availability\s+date/i,
  /hire\s+date/i,
  /earliest\s+start/i,
  /previous\s+date/i,
  /dob/i,
  /birthday/i,
];

const CURRENT_DATE_PATTERNS = [
  /please\s+enter\s+today['’]?s\s+date/i,
  /today(?:['’]s|s)?\s+date/i,
  /current\s+date/i,
  /application\s+date/i,
  /date\s+of\s+application/i,
  /submission\s+date/i,
  /submitted\s+(?:on|date)/i,
  /application\s+submitted/i,
  /date\s+submitted/i,
];

export function isCurrentDateQuestionLabel(label = '', metadata = {}) {
  const source = [
    label,
    metadata.placeholder,
    metadata.name,
    metadata.automationId,
    metadata.question,
    metadata.id,
    metadata.containerText,
    metadata.ariaLabel,
  ].filter(Boolean).join(' ');

  if (!source.trim()) return false;
  if (DISALLOWED_DATE_PATTERNS.some((pattern) => pattern.test(source))) return false;
  if (CURRENT_DATE_PATTERNS.some((pattern) => pattern.test(source))) return true;
  if (
    /\bdate\b/i.test(label)
    && /MM\/DD\/YYYY/i.test(source)
    && /self[-\s]?identif|voluntary|current\s+value/i.test(source)
  ) {
    return true;
  }
  if (/MM\/DD\/YYYY/i.test(source) && /date/i.test(source) && /today|current|application|submission/i.test(source)) {
    return true;
  }
  const bareDate = String(label).replace(/\*+/g, '').trim();
  if (
    /^date$/i.test(bareDate)
    && /self[-\s]?identif|cc-305|voluntary self-identification of disability|omb control number/i.test(source)
  ) {
    return true;
  }
  return false;
}

export function buildCurrentDateAction(label = '', metadata = {}, referenceDate = new Date()) {
  if (!isCurrentDateQuestionLabel(label, metadata)) return null;
  const timeZone = metadata.timeZone || 'Asia/Kolkata';
  const answer = getTodayMMDDYYYY(timeZone, referenceDate);
  const rawLabel = String(label).trim();
  return {
    action: 'fill_dynamic_date',
    format: 'MM/DD/YYYY',
    timeZone,
    value: answer,
    payload: {
      date: {
        normalized_label: rawLabel.toLowerCase().replace(/\*+/g, '').replace(/\s+/g, ' ').trim(),
        raw_label: rawLabel,
        answer,
        source: 'auto_generated',
        compliance_sensitive: false,
      },
    },
  };
}

export function getDynamicDateValueForField(label = '', metadata = {}, referenceDate = new Date()) {
  const action = buildCurrentDateAction(label, metadata, referenceDate);
  return action ? action.value : null;
}

export function createManualReviewItem(label, details = {}) {
  return {
    type: 'manual_review',
    label,
    createdAt: new Date().toISOString(),
    ...details,
  };
}