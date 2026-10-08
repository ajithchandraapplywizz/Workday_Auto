import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function purgeRogueWorkerRows() {
  console.log('--- PURGING ROGUE ROWS FROM worker_status ---');

  // Fetch all rows
  const { data: allRows, error: fetchErr } = await sb.from('worker_status').select('*');
  if (fetchErr) {
    console.error('Fetch error:', fetchErr);
    return;
  }

  const validIds = new Set(['worker-1', 'worker-2', 'worker-3']);
  const rogueRows = allRows.filter((r) => !validIds.has(r.worker_id));

  console.log(`Found ${rogueRows.length} rogue rows to delete:`, rogueRows.map(r => r.worker_id));

  for (const r of rogueRows) {
    const { error: delErr } = await sb.from('worker_status').delete().eq('worker_id', r.worker_id);
    if (delErr) {
      console.error(`Failed to delete ${r.worker_id}:`, delErr);
    } else {
      console.log(`Deleted rogue row: ${r.worker_id}`);
    }
  }

  // Ensure worker-1, worker-2, worker-3 exist and are idle
  for (const wid of ['worker-1', 'worker-2', 'worker-3']) {
    await sb.from('worker_status').upsert({
      worker_id: wid,
      state: 'idle',
      current_application_id: null,
      updated_at: new Date().toISOString(),
    });
  }

  // Print final table
  const { data: finalRows } = await sb.from('worker_status').select('*').order('worker_id');
  console.log('\nFINAL STRICT 3 ROWS:');
  console.table(finalRows);
}

purgeRogueWorkerRows().catch(console.error);
