/**
 * scripts/repairClientCompanyEmails.mjs
 *
 * Scans all clients in Supabase public.clients and standardizes company_email
 * so that only official @applywizard.ai (or @applywizz.ai) emails exist.
 * Personal emails (e.g. @gmail.com, @yahoo.com) are normalized to firstname.lastname@applywizard.ai.
 */

import { httpsJsonWithRetry } from '../lib/httpClient.mjs';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { isCompanyEmail, resolveCompanyEmail } from '../lib/applyWizzClient.mjs';

async function main() {
  loadLocalEnvOnce();
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('❌ Supabase credentials missing from environment.');
    process.exit(1);
  }

  console.log('📡 Fetching all clients from Supabase...');
  const res = await httpsJsonWithRetry({
    url: `${url}/rest/v1/clients?select=applywizz_id,client_name,first_name,last_name,company_email&limit=1000`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  const clients = res.json() || [];
  console.log(`Total clients in Supabase: ${clients.length}`);

  const needsRepair = [];
  for (const client of clients) {
    const rawEmail = String(client.company_email || '');
    const trimmed = rawEmail.trim();
    if (!trimmed || rawEmail !== trimmed || !isCompanyEmail(trimmed)) {
      const derived = resolveCompanyEmail(client, client.client_name);
      needsRepair.push({ client, rawEmail, derived: derived || trimmed });
    }
  }

  console.log(`Clients requiring company_email repair: ${needsRepair.length}`);

  if (needsRepair.length === 0) {
    console.log('✅ All clients already have valid company emails!');
    return;
  }

  let repairedCount = 0;
  let failCount = 0;

  for (let i = 0; i < needsRepair.length; i++) {
    const { client, rawEmail, derived } = needsRepair[i];
    const id = client.applywizz_id;
    console.log(`[${i + 1}/${needsRepair.length}] ${id} (${client.client_name || 'No Name'}): "${rawEmail}" -> "${derived}"`);

    if (!derived) {
      console.warn(`  ⚠️ Could not derive company email for ${id}`);
      failCount++;
      continue;
    }

    try {
      const patchRes = await httpsJsonWithRetry({
        url: `${url}/rest/v1/clients?applywizz_id=eq.${encodeURIComponent(id)}`,
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          company_email: derived,
          updated_at: new Date().toISOString(),
        }),
      });

      if (patchRes.ok) {
        repairedCount++;
      } else {
        console.error(`  ❌ Failed to patch ${id}: ${patchRes.status} ${patchRes.text}`);
        failCount++;
      }
    } catch (err) {
      console.error(`  ❌ Error patching ${id}:`, err.message);
      failCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`✅ Repaired: ${repairedCount}`);
  if (failCount > 0) console.log(`⚠️ Failures: ${failCount}`);
  console.log(`========================================\n`);

  // Final verification check
  console.log('🔍 Running verification check...');
  const verifyRes = await httpsJsonWithRetry({
    url: `${url}/rest/v1/clients?select=applywizz_id,client_name,company_email&limit=1000`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  const updatedRows = verifyRes.json() || [];
  const remainingInvalid = updatedRows.filter((c) => !isCompanyEmail(c.company_email));
  console.log(`Remaining non-company emails in database: ${remainingInvalid.length}`);
  if (remainingInvalid.length > 0) {
    console.log('Sample remaining invalid:', remainingInvalid.slice(0, 5));
  } else {
    console.log('🎉 100% of clients now have official company emails in Supabase!');
  }
}

main().catch(console.error);
