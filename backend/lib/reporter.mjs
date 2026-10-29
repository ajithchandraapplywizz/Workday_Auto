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

export async function takeScreenshot(page, label, profileOrContext = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return null;
  }
  const { isSupabaseConfigured, uploadStorageScreenshot, updateRecordScreenshot } = await import('./supabaseClient.mjs').catch(() => ({
    isSupabaseConfigured: () => false,
    uploadStorageScreenshot: null,
    updateRecordScreenshot: null,
  }));

  const context = (profileOrContext && typeof profileOrContext === 'object') ? profileOrContext : {};
  const applywizzId = String(
    context._applyWizzId ||
    context.applywizz_id ||
    context.client_id ||
    process.env.APPLYWIZZ_ID ||
    'CLIENT'
  ).trim().toUpperCase();

  const taskId = context._taskId || context.taskId || context._queueTaskId || context.queueTaskId || null;
  const rawJobUrl = context._canonicalJobUrl || context._jobUrl || context.job_url || '';
  const jobUrl = rawJobUrl ? String(rawJobUrl).split('?')[0].trim() : '';

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = String(label || 'screenshot').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();

  // Zero Local Screenshots Policy: capture strictly in-memory buffer
  const buf = await page.screenshot({ fullPage: true, type: 'png' }).catch(async () => {
    return await page.screenshot({ type: 'png' }).catch(() => null);
  });

  if (!buf) {
    console.warn(`  ⚠️  [Screenshot] Failed to capture in-memory buffer for "${safeLabel}"`);
    return null;
  }

  // Offline / unit test mode: return synthetic in-memory URI without writing to disk
  if (!isSupabaseConfigured() || typeof uploadStorageScreenshot !== 'function') {
    const memoryPath = `in-memory://${applywizzId}/${safeLabel}-${ts}.png`;
    console.log(`  📸 [Screenshot] In-memory buffer captured: ${safeLabel} (offline mode)`);
    return memoryPath;
  }

  // Cloud Storage Mode: stream buffer directly to Supabase Storage bucket (strictly flat, zero nested folders)
  const isFailure = /fail|error|blocked|exception|timeout|stuck|missing/i.test(safeLabel);
  const isSubmitted = /submitted|complete|success|already/i.test(safeLabel);

  // Policy: Terminate all intermediate step, scan, fill, and review screenshot uploads.
  // ONLY capture & upload:
  // 1) Real final submission confirmation (to 'submitted-applications')
  // 2) Mid-flow wizard failure/error (to 'failed-applications')
  if (!isFailure && !isSubmitted) {
    console.log(`  ℹ️  [Screenshot Skipped] Intermediate/step screenshot "${safeLabel}" suppressed (only final submission and failures are stored).`);
    return null;
  }

  const bucketName = isFailure ? 'failed-applications' : 'submitted-applications';
  const filename = taskId
    ? `${applywizzId}_${taskId}_${safeLabel}_${ts}.png`
    : `${applywizzId}_${safeLabel}_${ts}.png`;

  let uploadedUrl = null;
  try {
    uploadedUrl = await uploadStorageScreenshot(bucketName, filename, buf, 'image/png');
  } catch (upErr) {
    console.warn(`  ⚠️  [Supabase Storage] Upload error for "${filename}": ${upErr.message}`);
  }

  const finalUrl = uploadedUrl || `${bucketName}/${filename}`;

  console.log(`  📸 [Screenshot Captured]: ${safeLabel}`);
  console.log(`  ☁️  [Supabase Storage]: Uploaded to "${bucketName}/${filename}"`);
  console.log(`     URL: ${uploadedUrl || 'Saved'}`);

  // Persist screenshot path ONLY for real final submissions or failures (never for review or intermediate steps)
  if (typeof updateRecordScreenshot === 'function') {
    try {
      await updateRecordScreenshot({
        taskId,
        applywizzId,
        jobUrl,
        screenshotUrl: finalUrl,
        isReview: false,
        isFailure,
      });
    } catch (dbErr) {
      console.warn(`  ⚠️  [Database] Screenshot table update notice: ${dbErr.message}`);
    }
  }

  return finalUrl;
}


const CSV_HEADER = 'date,company,role,url,status,ats,screenshot,notes\n';

export async function logToCSV(url, company, role, status, screenshotPath, { ats = '', notes = '' } = {}) {
  const { isSupabaseConfigured } = await import('./supabaseClient.mjs').catch(() => ({ isSupabaseConfigured: () => false }));
  if (isSupabaseConfigured()) {
    // Local applied.csv writes completely bypassed in Supabase DB mode
    return;
  }
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  const exists = existsSync(CSV_REPORT);
  if (!exists) {
    await writeFile(CSV_REPORT, CSV_HEADER);
  }
  const date = new Date().toISOString().split('T')[0];
  const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
  const row = `${date},${esc(company)},${esc(role)},${esc(url)},${esc(status)},${esc(ats)},${esc(screenshotPath)},${esc(notes)}\n`;
  await appendFile(CSV_REPORT, row);

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

