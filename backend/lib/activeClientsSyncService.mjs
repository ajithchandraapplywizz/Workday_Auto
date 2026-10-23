/**
 * activeClientsSyncService.mjs — Dynamic Active Clients Synchronization
 * ======================================================================
 * Manages daily dynamic fetching and profile synchronization of active clients
 * directly from the authoritative external API:
 * https://applywizz-ca-management.vercel.app/api/active-clients
 *
 * Daily Lifecycle:
 * 1. Fetches live active applywizz_ids list dynamically.
 * 2. Checks Supabase clients table for missing or stale client profiles.
 * 3. Enriches and syncs missing profiles from https://www.apply-wizz.me/api/get-client-details.
 * 4. Exposes in-memory cached responses with force-refresh support for zero-latency dashboard queries.
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

const ACTIVE_CLIENTS_API_URL = 'https://applywizz-ca-management.vercel.app/api/active-clients';
const CLIENT_DETAILS_API_URL = 'https://www.apply-wizz.me/api/get-client-details';

// In-memory cache for the raw active-clients API response
let cachedActiveClients = null;
let cachedActiveClientsExpiresAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes TTL for real-time freshness

/**
 * Normalizes an AWL ID to standard uppercase format (e.g. 'AWL-44789')
 */
export function normalizeAwlId(rawId) {
  if (!rawId) return '';
  const str = String(rawId).trim().toUpperCase();
  const digitsMatch = str.match(/^(?:AWL[-_]?)?(\d+)$/i);
  if (digitsMatch) {
    return `AWL-${digitsMatch[1]}`;
  }
  return str;
}

/**
 * Fetches the list of active client AWL IDs directly from the external API.
 * Updates dynamically every day when the external management portal refreshes.
 *
 * @param {Object} options
 * @param {boolean} [options.force=false] Force bypass of in-memory cache
 * @returns {Promise<{ count: number, applywizz_ids: string[] }>}
 */
export async function fetchActiveClientsFromApi({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedActiveClients && cachedActiveClientsExpiresAt > now) {
    return cachedActiveClients;
  }

  try {
    const res = await fetch(ACTIVE_CLIENTS_API_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const json = await res.json();
      let ids = [];
      if (Array.isArray(json)) {
        ids = json.map((x) => (typeof x === 'string' ? x : x.applywizz_id || x.id)).filter(Boolean);
      } else if (json && Array.isArray(json.applywizz_ids)) {
        ids = json.applywizz_ids.filter(Boolean);
      }

      if (ids.length > 0) {
        const normalized = [...new Set(ids.map(normalizeAwlId))];
        const result = {
          count: normalized.length,
          applywizz_ids: normalized,
          source: 'live_api',
          fetched_at: new Date().toISOString(),
        };
        cachedActiveClients = result;
        cachedActiveClientsExpiresAt = now + CACHE_TTL_MS;
        return result;
      }
    } else {
      console.warn(`[ACTIVE-CLIENTS] API returned status ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    console.warn('[ACTIVE-CLIENTS] Failed to fetch external active-clients API:', err.message);
  }

  // Graceful fallback: return existing cache if available
  if (cachedActiveClients && cachedActiveClients.applywizz_ids?.length > 0) {
    return cachedActiveClients;
  }

  // Graceful fallback: retrieve active client IDs from Supabase if network fails
  if (supabase) {
    try {
      const { data: dbClients } = await supabase
        .from('clients')
        .select('applywizz_id')
        .not('applywizz_id', 'is', null);

      const dbIds = [...new Set((dbClients || []).map((c) => normalizeAwlId(c.applywizz_id)).filter(Boolean))];
      if (dbIds.length > 0) {
        const fallback = {
          count: dbIds.length,
          applywizz_ids: dbIds,
          source: 'db_fallback',
          fetched_at: new Date().toISOString(),
        };
        cachedActiveClients = fallback;
        cachedActiveClientsExpiresAt = now + 60 * 1000;
        return fallback;
      }
    } catch (dbErr) {
      console.error('[ACTIVE-CLIENTS] Database fallback query error:', dbErr.message);
    }
  }

  return { count: 0, applywizz_ids: [], source: 'empty', fetched_at: new Date().toISOString() };
}

/**
 * Enriches and syncs profiles for active clients into the Supabase clients table.
 * Automatically downloads details from CRM for any clients not yet recorded in the DB.
 *
 * @param {Object} options
 * @param {boolean} [options.force=false] Force sync even if already in DB
 * @param {number} [options.concurrency=4] Concurrent requests to CRM
 * @returns {Promise<{ totalActive: number, newlySynced: number, alreadyPresent: number, errors: number }>}
 */
export async function syncActiveClientProfiles({ force = false, concurrency = 4 } = {}) {
  const activeData = await fetchActiveClientsFromApi({ force });
  const activeIds = activeData.applywizz_ids || [];

  if (!activeIds.length || !supabase) {
    return { totalActive: activeIds.length, newlySynced: 0, alreadyPresent: 0, errors: 0 };
  }

  // 1. Identify which clients are already in the DB
  const { data: existingRows, error: checkErr } = await supabase
    .from('clients')
    .select('applywizz_id, client_name')
    .in('applywizz_id', activeIds);

  if (checkErr) {
    console.warn('[ACTIVE-CLIENTS] Check existing rows warning:', checkErr.message);
  }

  const existingMap = new Map();
  for (const r of existingRows || []) {
    existingMap.set(normalizeAwlId(r.applywizz_id), r);
  }

  const toSync = force
    ? activeIds
    : activeIds.filter((id) => {
        const existing = existingMap.get(id);
        return !existing || !existing.client_name || existing.client_name === id;
      });

  let newlySynced = 0;
  let errors = 0;

  if (toSync.length === 0) {
    return {
      totalActive: activeIds.length,
      newlySynced: 0,
      alreadyPresent: activeIds.length,
      errors: 0,
    };
  }

  console.log(`[ACTIVE-CLIENTS] Syncing ${toSync.length} client profile(s) from CRM...`);

  // 2. Fetch and upsert missing client profiles in concurrent batches
  for (let i = 0; i < toSync.length; i += concurrency) {
    const batch = toSync.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (awlId) => {
        try {
          const detailRes = await fetch(`${CLIENT_DETAILS_API_URL}?applywizz_id=${encodeURIComponent(awlId)}`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!detailRes.ok) {
            errors++;
            return;
          }
          const json = await detailRes.json();
          const c = json.client || json.data || {};
          const a = json.additional_information || {};

          const fullName = c.full_name || c.name || c.client_name || null;
          const firstName = fullName ? fullName.split(' ')[0] : '';
          const lastName = fullName ? fullName.split(' ').slice(1).join(' ') : '';

          const payload = {
            applywizz_id: awlId,
            client_name: fullName || awlId,
            first_name: firstName,
            last_name: lastName,
            company_email: c.company_email || c.personal_email || null,
            mobile_number: c.whatsapp_number || c.callable_phone || null,
            resume_url: a.resume_url || c.resume_url || null,
            education: a.highest_education || null,
            university_or_school: a.university_name || null,
            latest_job_title: c.job_role_preferences?.[0] || a.role || null,
            career_associate_manager_id: c.careerassociatemanagerid || null,
            raw_profile_json: json,
            updated_at: new Date().toISOString(),
          };

          const { error: upsertErr } = await supabase
            .from('clients')
            .upsert(payload, { onConflict: 'applywizz_id' });

          if (upsertErr) {
            console.warn(`[ACTIVE-CLIENTS] Upsert error for ${awlId}:`, upsertErr.message);
            errors++;
          } else {
            newlySynced++;
          }
        } catch (err) {
          console.warn(`[ACTIVE-CLIENTS] Failed syncing ${awlId}:`, err.message);
          errors++;
        }
      })
    );
  }

  console.log(`[ACTIVE-CLIENTS] Sync complete: ${newlySynced} synced, ${errors} error(s), total active: ${activeIds.length}`);

  return {
    totalActive: activeIds.length,
    newlySynced,
    alreadyPresent: activeIds.length - toSync.length,
    errors,
  };
}

/**
 * Returns active clients enriched with database information (name, email, etc.)
 */
export async function getActiveClientsRoster({ force = false } = {}) {
  const activeData = await fetchActiveClientsFromApi({ force });
  const activeIds = activeData.applywizz_ids || [];

  if (!supabase || !activeIds.length) {
    return {
      count: activeIds.length,
      clients: activeIds.map((id) => ({ applywizz_id: id, client_name: id })),
      source: activeData.source,
      fetched_at: activeData.fetched_at,
    };
  }

  const { data: dbClients } = await supabase
    .from('clients')
    .select('applywizz_id, client_name, first_name, last_name, company_email, resume_url, latest_job_title')
    .in('applywizz_id', activeIds);

  const clientMap = new Map();
  for (const c of dbClients || []) {
    clientMap.set(normalizeAwlId(c.applywizz_id), c);
  }

  const clients = activeIds.map((id) => {
    const db = clientMap.get(id);
    const fullName = db ? [db.first_name, db.last_name].filter(Boolean).join(' ').trim() : '';
    return {
      applywizz_id: id,
      client_name: db?.client_name || fullName || id,
      company_email: db?.company_email || null,
      resume_url: db?.resume_url || null,
      latest_job_title: db?.latest_job_title || null,
      is_active: true,
    };
  });

  return {
    count: clients.length,
    clients,
    source: activeData.source,
    fetched_at: activeData.fetched_at,
  };
}
