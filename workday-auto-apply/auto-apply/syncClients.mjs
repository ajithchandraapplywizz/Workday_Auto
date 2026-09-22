import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { hydrateProfileFromApplyWizz } from './lib/applyWizzClient.mjs';
import { loadLocalEnvOnce } from './lib/supabaseClient.mjs';

async function syncIds(ids) {
  loadLocalEnvOnce();
  
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    console.log(`\n--- [${i + 1}/${ids.length}] Syncing ID: ${id} ---`);
    process.env.APPLYWIZZ_ID = id;
    
    // hydrateProfileFromApplyWizz will fetch the client via API, extract data,
    // and upsert the client details and answers to Supabase automatically.
    // The _isBulkSync flag tells the hydrator to delete the temp resume PDF
    // immediately after parsing instead of keeping it for application upload.
    try {
      await hydrateProfileFromApplyWizz({ _isBulkSync: true });
      console.log(`✓ Successfully synced ${id}`);
    } catch (err) {
      console.error(`✗ Error syncing ${id}:`, err);
    }
  }
  console.log('\n✅ All syncs completed!');
}

async function main() {
  const args = process.argv.slice(2);
  let ids = [];
  
  if (args.length > 0) {
    ids = args.flatMap(arg => arg.split(',')).map(id => id.trim()).filter(Boolean);
  } else {
    // Try to read from sync_ids.txt first
    const txtPath = resolve('./sync_ids.txt');
    if (existsSync(txtPath)) {
      ids = readFileSync(txtPath, 'utf8')
        .split('\n')
        .map(i => i.trim())
        .filter(Boolean);
    } else {
      // Fallback: Read from data/application-clients.json if no args provided
      const dataPath = resolve('./data/application-clients.json');
      try {
        const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
        if (data.clients) {
          // get unique applywizz_ids
          ids = [...new Set(data.clients.map(c => c.applywizz_id).filter(Boolean))];
        }
      } catch (err) {
        console.log('Could not read application-clients.json', err.message);
      }
    }
  }
  
  // Deduplicate
  const uniqueIds = [...new Set(ids)];
  console.log(`Starting sync for ${uniqueIds.length} unique clients...`);
  
  await syncIds(uniqueIds);
}

main().catch(console.error);
