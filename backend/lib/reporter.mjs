/**
 * reporter.mjs — Screenshots and CSV logging
 */

import { mkdir, writeFile, appendFile, readFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { existsSync } from 'fs';
import { logFieldTrace } from './trace.mjs';
import { appendManualReviewRecord } from './qaStore.mjs';

const SCREENSHOTS_DIR = resolve(process.cwd(), 'screenshots');
const CSV_REPORT = resolve(process.cwd(), 'data', 'applied.csv');
const QUEUE_FILE = resolve(process.cwd(), 'data', 'queue.csv');

export async function takeScreenshot(page, label) {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(SCREENSHOTS_DIR, `${label}-${ts}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`  📸 Screenshot: ${basename(path)}`);
  return path;
}

const CSV_HEADER = 'date,company,role,url,status,ats,screenshot,notes\n';

export async function logToCSV(url, company, role, status, screenshotPath, { ats = '', notes = '' } = {}) {
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  const exists = existsSync(CSV_REPORT);
  if (!exists) {
    await writeFile(CSV_REPORT, CSV_HEADER);
  }
  const date = new Date().toISOString().split('T')[0];
  const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
  const row = `${date},${esc(company)},${esc(role)},${esc(url)},${esc(status)},${esc(ats)},${esc(screenshotPath)},${esc(notes)}\n`;
  await appendFile(CSV_REPORT, row);
  console.log(`  📋 Logged to data/applied.csv`);

  // Auto-update queue status if this URL is in the queue
  await updateQueueStatus(url, status);
}

// ─── Queue management ──────────────────────────────────────────────────────
const QUEUE_HEADER = 'date_added,company,url,status,date_applied,notes\n';

export async function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  const raw = await readFile(QUEUE_FILE, 'utf-8');
  const lines = raw.trim().split('\n').slice(1); // skip header
  return lines.filter(l => l.trim()).map(line => {
    const parts = parseCSVLine(line);
    return {
      date_added: parts[0] || '',
      company: parts[1] || '',
      url: parts[2] || '',
      status: parts[3] || 'pending',
      date_applied: parts[4] || '',
      notes: parts[5] || '',
    };
  });
}

export async function saveQueue(entries) {
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  let content = QUEUE_HEADER;
  for (const e of entries) {
    const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
    content += `${e.date_added},${esc(e.company)},${esc(e.url)},${esc(e.status)},${e.date_applied},${esc(e.notes)}\n`;
  }
  await writeFile(QUEUE_FILE, content);
}

export async function addToQueue(url, company = '', notes = '') {
  const entries = await loadQueue();
  // Don't add duplicates
  if (entries.some(e => e.url === url)) {
    console.log(`  ⚠️  Already in queue: ${url}`);
    return entries;
  }
  entries.push({
    date_added: new Date().toISOString().split('T')[0],
    company,
    url,
    status: 'pending',
    date_applied: '',
    notes,
  });
  await saveQueue(entries);
  console.log(`  ✅ Added to queue: ${company || url}`);
  return entries;
}

export async function updateQueueStatus(url, status) {
  const entries = await loadQueue();
  const entry = entries.find(e => e.url === url);
  if (!entry) return;
  entry.status = status;
  if (['submitted', 'applied'].includes(status)) {
    entry.date_applied = new Date().toISOString().split('T')[0];
  }
  await saveQueue(entries);
}

export async function getPendingFromQueue() {
  const entries = await loadQueue();
  return entries.filter(e => e.status === 'pending');
}

export async function loadApplied() {
  if (!existsSync(CSV_REPORT)) return [];
  const raw = await readFile(CSV_REPORT, 'utf-8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.filter(l => l.trim()).map(line => {
    const parts = parseCSVLine(line);
    // Handle both old format (date,url,company,role,status,screenshot)
    // and new format (date,company,role,url,status,ats,screenshot,notes)
    if (parts.length >= 8) {
      return { date: parts[0], company: parts[1], role: parts[2], url: parts[3], status: parts[4], ats: parts[5], screenshot: parts[6], notes: parts[7] };
    }
    return { date: parts[0], url: parts[1], company: parts[2], role: parts[3], status: parts[4], screenshot: parts[5], ats: '', notes: '' };
  });
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current); current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

const FIELD_TRACE_LOG = resolve(process.cwd(), 'runs', 'field-trace.log');

/**
 * 3f. Per-Field Trace Log
 * One structured line per field per run:
 * automation-id | label text | controlType | tier used | value attempted | verified pass/fail
 */
export async function writeFieldTraceLine({
  automationId = '',
  label = '',
  controlType = '',
  tier = '',
  valueAttempted = '',
  verified = false,
  reason = '',
  step = '',
} = {}) {
  const cleanAid = String(automationId || 'unknown').trim();
  const cleanLabel = String(label || 'unlabeled').replace(/\s+/g, ' ').trim();
  const cleanType = String(controlType || 'unknown').trim();
  const cleanTier = String(tier || 'unknown').trim();
  const cleanVal = valueAttempted != null && String(valueAttempted).trim() !== '' ? String(valueAttempted).trim() : 'none';
  const passFail = verified ? 'pass' : 'fail';

  const traceLine = `${cleanAid} | ${cleanLabel} | ${cleanType} | ${cleanTier} | ${cleanVal} | verified ${passFail}`;

  console.log(`  📊 [TRACE] ${traceLine}`);

  try {
    await mkdir(resolve(process.cwd(), 'runs'), { recursive: true });
    await appendFile(FIELD_TRACE_LOG, `${new Date().toISOString()} | ${traceLine}\n`);
  } catch {}

  // Also call underlying logFieldTrace
  try {
    logFieldTrace({
      automationId: cleanAid,
      label: cleanLabel,
      controlType: cleanType,
      tier: cleanTier,
      valueAttempted: cleanVal,
      success: Boolean(verified),
      reason,
      step,
    });
  } catch {}

  return traceLine;
}

/**
 * 3e. Escalate field to manual review queue and emit failed trace line.
 */
export async function escalateToManualReview({
  candidateId = '',
  tenant = '',
  automationId = '',
  questionLabel = '',
  controlType = '',
  visibleOptions = [],
  tierAttempted = '',
  attemptedValue = '',
  reason = '',
  step = '',
} = {}) {
  await appendManualReviewRecord({
    candidateId,
    tenant,
    questionLabel,
    controlType,
    visibleOptions,
    tierAttempted,
    attemptedValue,
    reason,
    step,
  });

  return await writeFieldTraceLine({
    automationId,
    label: questionLabel,
    controlType,
    tier: tierAttempted,
    valueAttempted: attemptedValue,
    verified: false,
    reason,
    step,
  });
}

