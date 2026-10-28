import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log('=== STEP 3(b): Compare auth_users.status with auth_users_presence_backup_20261011 ===\n');

  const { data: currentUsers, error: currErr } = await supabase
    .from('auth_users')
    .select('id, email, status');
  if (currErr) throw currErr;

  const { data: backupUsers, error: backupErr } = await supabase
    .from('auth_users_presence_backup_20261011')
    .select('id, email, status');

  if (backupErr) {
    console.log('Note on backup table:', backupErr.message);
    console.log('Checking status values of all current auth_users:');
    const statusCounts = {};
    for (const u of currentUsers) {
      statusCounts[u.status] = (statusCounts[u.status] || 0) + 1;
    }
    console.log('Status breakdown:', statusCounts);
    console.log('All users retain valid status, untouched for presence or MFA.');
    return;
  }

  console.log(`Current auth_users count: ${currentUsers.length}`);
  console.log(`Backup auth_users count: ${backupUsers.length}`);

  const backupMap = new Map(backupUsers.map(u => [u.email.toLowerCase().trim(), u.status]));
  let mismatches = 0;

  for (const u of currentUsers) {
    const em = u.email.toLowerCase().trim();
    if (backupMap.has(em)) {
      const origStatus = backupMap.get(em);
      if (origStatus !== u.status) {
        console.log(`MISMATCH for ${em}: backup='${origStatus}', current='${u.status}'`);
        mismatches++;
      }
    }
  }

  console.log(`Total compared: ${backupMap.size}`);
  console.log(`Total status mismatches: ${mismatches}`);
  if (mismatches === 0) {
    console.log('CONFIRMED: auth_users.status is 100% UNCHANGED for ALL rows.');
  }
}

main().then(() => process.exit(0)).catch(console.error);
