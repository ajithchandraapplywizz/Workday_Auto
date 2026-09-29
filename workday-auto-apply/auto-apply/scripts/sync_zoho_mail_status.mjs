/**
 * sync_zoho_mail_status.mjs
 * 
 * Dynamically queries the live Zoho Mail Reader microservice
 * (https://zoho-mail-reader.onrender.com/api/zoho/ui/users)
 * and synchronizes the real-time Zoho connection and authorization status
 * into the Supabase `clients` table.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZOHO_READER_HOST = process.env.ZOHO_MAIL_READER_HOST || 'https://zoho-mail-reader.onrender.com';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function nameToEmailPrefix(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function runZohoSync() {
  console.log(`📡 Fetching live Zoho mailbox roster from ${ZOHO_READER_HOST}...`);
  const start = Date.now();

  let zohoUsers = [];
  try {
    const res = await fetch(`${ZOHO_READER_HOST}/api/zoho/ui/users`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    zohoUsers = data.users || [];
    console.log(`✓ Retrieved ${zohoUsers.length} Zoho mailboxes (${data.connectedCount || 0} connected).`);
  } catch (err) {
    console.error(`❌ Failed to query Zoho Mail Reader: ${err.message}`);
    process.exit(1);
  }

  // Build lookup map by email and prefix
  const zohoMap = new Map();
  for (const u of zohoUsers) {
    const em = normalizeEmail(u.email);
    if (em) {
      zohoMap.set(em, u);
      const prefix = em.split('@')[0].replace(/[^a-z0-9]/g, '');
      if (prefix) zohoMap.set(prefix, u);
    }
  }

  // Fetch all clients from Supabase
  console.log('📦 Loading clients from Supabase...');
  const { data: clients, error: clientErr } = await supabase
    .from('clients')
    .select('id, applywizz_id, client_name, company_email, raw_profile_json');

  if (clientErr) {
    console.error('❌ Error fetching clients from Supabase:', clientErr.message);
    process.exit(1);
  }

  console.log(`✓ Found ${clients.length} candidates in Supabase.`);

  let updatedCount = 0;
  let connectedCount = 0;
  const nowIso = new Date().toISOString();

  for (const client of clients) {
    const companyMail = normalizeEmail(client.company_email);
    const namePrefix = nameToEmailPrefix(client.client_name);

    let match = null;
    if (companyMail && zohoMap.has(companyMail)) {
      match = zohoMap.get(companyMail);
    } else if (namePrefix && zohoMap.has(namePrefix)) {
      match = zohoMap.get(namePrefix);
    }

    const zohoStatus = match
      ? (match.connected ? 'connected' : (match.status || 'pending'))
      : 'disconnected';
    const isConnected = Boolean(match && (match.connected || match.status === 'active'));

    if (isConnected) connectedCount++;

    const rawProfile = client.raw_profile_json || {};
    rawProfile.zoho_mail = {
      status: zohoStatus,
      connected: isConnected,
      last_synced: nowIso,
      zuid: match?.zuid || null,
      accountId: match?.accountId || null,
    };

    // First attempt update with top-level columns + raw_profile_json
    let { error: updErr } = await supabase
      .from('clients')
      .update({
        zoho_status: zohoStatus,
        zoho_connected: isConnected,
        zoho_last_synced: nowIso,
        raw_profile_json: rawProfile,
      })
      .eq('id', client.id);

    // If top-level columns not yet migrated, fallback cleanly to raw_profile_json
    if (updErr) {
      const fallbackRes = await supabase
        .from('clients')
        .update({
          raw_profile_json: rawProfile,
        })
        .eq('id', client.id);
      updErr = fallbackRes.error;
    }

    if (!updErr) {
      updatedCount++;
    }
  }

  console.log('\n========================================');
  console.log('✅ ZOHO MAIL STATUS SYNC COMPLETE');
  console.log(`• Total Candidates Processed: ${updatedCount}`);
  console.log(`• Connected & Active Mailboxes: ${connectedCount}`);
  console.log(`• Execution Time: ${((Date.now() - start) / 1000).toFixed(2)}s`);
  console.log('========================================\n');
}

runZohoSync();
