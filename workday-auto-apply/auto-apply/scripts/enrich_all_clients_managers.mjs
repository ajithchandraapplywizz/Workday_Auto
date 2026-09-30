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
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BALAJI_ID = '9dc9376e-fbc5-440b-932f-38da10b89a70';
const RAMAKRISHNA_ID = 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744';

async function main() {
  console.log('Fetching clients with NULL career_associate_manager_id...');
  const { data: clients, error } = await supabase
    .from('clients')
    .select('applywizz_id, client_name')
    .is('career_associate_manager_id', null);

  if (error) {
    console.error('Error fetching clients:', error);
    return;
  }

  console.log(`Found ${clients.length} clients with NULL manager ID. Fetching static manager details from API...`);

  let updated = 0;
  let balaji = 0;
  let ramakrishna = 0;
  let notFound = 0;

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    try {
      const res = await fetch(`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(c.applywizz_id)}`);
      if (!res.ok) {
        notFound++;
        continue;
      }
      const json = await res.json();
      const client = json.client || json.data || json;
      const rawMgrId = client.careerassociatemanagerid || client.career_associate_manager_id || null;

      let managerId = null;
      let managerName = null;

      // Map raw API manager ID to current manager UUIDs
      if (rawMgrId === '9dc9376e-fbc5-440b-932f-38da10b89a70' || rawMgrId === BALAJI_ID) {
        managerId = BALAJI_ID;
        managerName = 'Balaji';
        balaji++;
      } else if (rawMgrId === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' || rawMgrId === RAMAKRISHNA_ID) {
        managerId = RAMAKRISHNA_ID;
        managerName = 'Ramakrishna';
        ramakrishna++;
      }

      if (managerId) {
        await supabase
          .from('clients')
          .update({
            career_associate_manager_id: managerId,
            current_manager_id: managerId,
            operational_manager_name: managerName,
            client_name: client.full_name || client.name || c.client_name,
            raw_profile_json: client
          })
          .eq('applywizz_id', c.applywizz_id);
        updated++;
      } else {
        notFound++;
      }
    } catch (err) {
      console.warn(`Failed for ${c.applywizz_id}:`, err.message);
      notFound++;
    }

    if ((i + 1) % 20 === 0 || i === clients.length - 1) {
      console.log(`Processed ${i + 1}/${clients.length}... (Updated: ${updated}, Balaji: ${balaji}, Ramakrishna: ${ramakrishna}, Unassigned: ${notFound})`);
    }
  }

  console.log('\n=== ENRICHMENT COMPLETE ===');
  console.log(`Total Processed:  ${clients.length}`);
  console.log(`Updated Managers: ${updated}`);
  console.log(`  - Balaji:       ${balaji}`);
  console.log(`  - Ramakrishna:  ${ramakrishna}`);
  console.log(`Unassigned/None:  ${notFound}`);
}

main().catch(console.error);
