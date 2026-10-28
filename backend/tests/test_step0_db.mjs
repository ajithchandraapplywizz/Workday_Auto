import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log('--- TEST 1: Try information_schema via REST ---');
  try {
    const { data, error } = await supabase.from('information_schema.columns').select('*').limit(1);
    console.log('info_schema result:', { data, error });
  } catch (e) {
    console.log('info_schema exception:', e.message);
  }

  console.log('\n--- TEST 2: Query auth_users for the 9 columns ---');
  try {
    const { data, error } = await supabase
      .from('auth_users')
      .select('mfa_enrolled, setup_allowed, totp_secret_enc, totp_pending_enc, totp_last_step, failed_code_attempts, locked_until, enrolled_at, last_seen_at')
      .limit(1);
    console.log('select 9 columns result:', { data, error });
  } catch (e) {
    console.log('select exception:', e.message);
  }

  console.log('\n--- TEST 3: Check counts on auth_users ---');
  try {
    const { data, error, count } = await supabase
      .from('auth_users')
      .select('mfa_enrolled, setup_allowed, email', { count: 'exact' });
    if (error) {
      console.log('count error:', error);
    } else {
      const enrolled = data.filter(r => r.mfa_enrolled === true);
      const allowed = data.filter(r => r.setup_allowed === true);
      console.log(`Total rows: ${data.length}`);
      console.log(`Enrolled count (true): ${enrolled.length}`, enrolled.map(r => r.email));
      console.log(`Allowed count (true): ${allowed.length}`, allowed.map(r => r.email));
    }
  } catch (e) {
    console.log('count exception:', e.message);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
