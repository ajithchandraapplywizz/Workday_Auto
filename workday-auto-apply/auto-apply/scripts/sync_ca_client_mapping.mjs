/**
 * sync_ca_client_mapping.mjs
 * 
 * Synchronizes:
 * 1. 59 Career Associates (CAs) from /api/ca/emails into `operators`.
 * 2. Static Manager mapping (28 to Ramakrishna, 31 to Balaji) via /api/get-client-details.
 * 3. Dynamic CA-to-Client daily assignment via /api/ca/work-history into `client_assignment_log`.
 * 4. Master client pointers (career_associate_manager_id, current_ca_email, current_manager_id) in `clients`.
 * 
 * STRICT RULE: Zero external application metrics (emails_submitted, jobs_applied) are ingested.
 * Dashboards reflect ONLY genuine Workday auto-apply bot execution runs.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BALAJI_ID = '9dc9376e-fbc5-440b-932f-38da10b89a70';
const RAMAKRISHNA_ID = 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744';

// In-memory cache for client detail lookups to avoid repeat calls
const clientDetailsCache = new Map();

/**
 * Format Date to YYYY-MM-DD
 */
function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Determine default working day:
 * - If today is Monday (1), step back to Friday (3 days).
 * - If today is Sunday (0), step back to Friday (2 days).
 * - If today is Saturday (6), step back to Friday (1 day).
 * - Else (Tue-Fri), step back 1 day.
 */
function getPreviousWorkday(referenceDate = new Date()) {
  const d = new Date(referenceDate);
  const day = d.getDay();
  let daysToSubtract = 1;
  if (day === 1) daysToSubtract = 3;      // Monday -> Friday
  else if (day === 0) daysToSubtract = 2; // Sunday -> Friday
  else if (day === 6) daysToSubtract = 1; // Saturday -> Friday
  
  d.setDate(d.getDate() - daysToSubtract);
  return formatDate(d);
}

/**
 * Fetch all 59 CAs from master roster
 */
async function fetchCARoster() {
  console.log('Fetching CA roster from /api/ca/emails...');
  const res = await fetch('https://applywizz-ca-management.vercel.app/api/ca/emails');
  if (!res.ok) throw new Error(`Failed to fetch CA emails: ${res.statusText}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.users || data.records || data.data || [];
  console.log(`Successfully fetched ${list.length} CAs.`);
  return list;
}

/**
 * Fetch Work History for a CA with automatic holiday/weekend rollback
 */
async function fetchCAWorkHistory(caEmail, targetDate, maxDaysBack = 10) {
  let curr = new Date(targetDate);
  for (let i = 0; i < maxDaysBack; i++) {
    const dayOfWeek = curr.getDay();
    // Skip weekends (Saturday = 6, Sunday = 0)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      curr.setDate(curr.getDate() - 1);
      continue;
    }

    const dateStr = formatDate(curr);
    try {
      const url = `https://applywizz-ca-management.vercel.app/api/ca/work-history?from=${dateStr}&to=${dateStr}&ca_email=${encodeURIComponent(caEmail)}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const records = json.records || [];
        if (records.length > 0) {
          return { date: dateStr, records };
        }
      }
    } catch (err) {
      // ignore network hiccup and retry previous day
    }
    curr.setDate(curr.getDate() - 1);
  }
  return { date: targetDate, records: [] };
}

/**
 * Fetch Client Details to get static careerassociatemanagerid
 */
async function fetchClientDetails(applywizzId) {
  if (clientDetailsCache.has(applywizzId)) {
    return clientDetailsCache.get(applywizzId);
  }

  try {
    const url = `https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(applywizzId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const client = json.client || json.data || json;
    
    // Extract manager ID
    let managerId = client.careerassociatemanagerid || client.career_associate_manager_id || null;
    let managerName = null;

    if (managerId === BALAJI_ID) {
      managerName = 'Balaji';
    } else if (managerId === RAMAKRISHNA_ID) {
      managerName = 'Ramakrishna';
    }

    const result = {
      applywizz_id: applywizzId,
      client_name: client.full_name || client.name || client.client_name || null,
      client_email: client.company_email || client.personal_email || null,
      manager_id: managerId,
      manager_name: managerName
    };

    clientDetailsCache.set(applywizzId, result);
    return result;
  } catch (err) {
    return null;
  }
}

/**
 * Main Synchronization Routine
 */
async function syncAll() {
  console.log('=== STARTING SYNC: CA, MANAGER, & CLIENT RELATIONSHIPS ===');
  
  // CLI date support: e.g. node scripts/sync_ca_client_mapping.mjs 2026-09-25
  const cliDate = process.argv[2];
  const targetWorkday = cliDate || getPreviousWorkday();
  console.log(`Initial Target Working Date: ${targetWorkday}`);

  // Fetch all 59 CAs
  const caList = await fetchCARoster();
  if (caList.length === 0) {
    console.error('No CAs found from API. Aborting.');
    return;
  }

  let balajiCount = 0;
  let ramakrishnaCount = 0;
  let unassignedCount = 0;
  let totalAssignmentsLogged = 0;

  console.log(`Processing ${caList.length} CAs sequentially with weekend/holiday rollback...`);

  for (let i = 0; i < caList.length; i++) {
    const ca = caList[i];
    const caEmail = ca.email.trim().toLowerCase();
    
    // Fetch dynamic work history for this CA
    const { date: effectiveDate, records } = await fetchCAWorkHistory(caEmail, targetWorkday, 10);
    
    let resolvedManagerId = null;
    let resolvedManagerName = null;
    const clientAssignments = [];

    for (const record of records) {
      const applywizzId = record.applywizz_id;
      if (!applywizzId) continue;

      const clientInfo = await fetchClientDetails(applywizzId);
      if (clientInfo && clientInfo.manager_id) {
        resolvedManagerId = clientInfo.manager_id;
        resolvedManagerName = clientInfo.manager_name;
      }

      clientAssignments.push({
        applywizz_id: applywizzId,
        client_id: record.client_id || null,
        client_name: record.client_name || (clientInfo ? clientInfo.client_name : null),
        client_email: record.client_email || (clientInfo ? clientInfo.client_email : null),
        date: effectiveDate
      });
    }

    if (resolvedManagerId === BALAJI_ID) {
      balajiCount++;
    } else if (resolvedManagerId === RAMAKRISHNA_ID) {
      ramakrishnaCount++;
    } else {
      unassignedCount++;
    }

    // 1. Upsert CA into `operators` (Static Manager <-> CA mapping)
    const { error: opErr } = await supabase
      .from('operators')
      .upsert({
        id: ca.id || caEmail,
        name: ca.name.trim(),
        email: caEmail,
        role: ca.role || 'CA',
        manager_id: resolvedManagerId,
        status: 'active',
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

    if (opErr) {
      console.error(`Error saving operator ${caEmail}:`, opErr.message);
    }

    // 2. Log dynamic assignments in `client_assignment_log` (dynamic CA <-> Client daily log)
    for (const client of clientAssignments) {
      const { error: logErr } = await supabase
        .from('client_assignment_log')
        .upsert({
          applywizz_id: client.applywizz_id,
          client_id: client.client_id,
          ca_id: ca.id || caEmail,
          ca_email: caEmail,
          manager_id: resolvedManagerId,
          manager_email: resolvedManagerId === BALAJI_ID ? 'balaji@applywizz.com' : (resolvedManagerId === RAMAKRISHNA_ID ? 'ramakrishna@applywizz.com' : null),
          assignment_date: client.date,
          effective_from: new Date(`${client.date}T00:00:00Z`).toISOString()
        }, { onConflict: 'applywizz_id,assignment_date' });

      if (!logErr) totalAssignmentsLogged++;

      // 3. Update master `clients` record with current active CA & manager pointers
      await supabase
        .from('clients')
        .update({
          career_associate_manager_id: resolvedManagerId,
          operational_manager_name: resolvedManagerName,
          current_ca_email: caEmail,
          current_manager_id: resolvedManagerId,
          assigned_at: new Date().toISOString()
        })
        .eq('applywizz_id', client.applywizz_id);
    }

    const mgrTag = resolvedManagerId === BALAJI_ID ? 'Balaji' : (resolvedManagerId === RAMAKRISHNA_ID ? 'Ramakrishna' : 'Unassigned');
    console.log(`[${i + 1}/${caList.length}] ${ca.name.padEnd(25)} (${caEmail}) -> Manager: ${mgrTag.padEnd(12)} | Clients: ${clientAssignments.length} on ${effectiveDate}`);
  }

  console.log('\n=========================================');
  console.log('=== RELATIONSHIP SYNC COMPLETE SUMMARY ===');
  console.log('=========================================');
  console.log(`Total CAs Processed:                 ${caList.length}`);
  console.log(`Mapped to Balaji:                   ${balajiCount}`);
  console.log(`Mapped to Ramakrishna:              ${ramakrishnaCount}`);
  console.log(`Unassigned (on leave/no clients):   ${unassignedCount}`);
  console.log(`Dynamic Client Assignments Logged:  ${totalAssignmentsLogged}`);
  console.log('=========================================\n');
}

syncAll().catch(err => {
  console.error('Fatal error in sync:', err);
  process.exit(1);
});
