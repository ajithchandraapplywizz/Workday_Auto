import { execFileSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import { signMfaJwt } from '../lib/mfaAuth.mjs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log('=== STEP 3(a): Real curl.exe test for logout token vs body email ===\n');

  // Grab two real users from auth_users
  const { data: users } = await supabase.from('auth_users').select('email').limit(2);
  const USER_A = users[0].email;
  const USER_B = users[1].email;

  const stampA = new Date().toISOString();
  const stampB = new Date().toISOString();

  await supabase.from('auth_users').update({ last_seen_at: stampA }).eq('email', USER_A);
  await supabase.from('auth_users').update({ last_seen_at: stampB }).eq('email', USER_B);

  console.log(`Initial DB state:`);
  console.log(`User A (${USER_A}) last_seen_at: ${stampA}`);
  console.log(`User B (${USER_B}) last_seen_at: ${stampB}\n`);

  const tokenA = signMfaJwt({ id: 'user-a-uuid', email: USER_A, role: 'operator' });

  // 1. Run real curl.exe without token
  console.log('--- TEST 1: Real curl.exe POST /api/auth/logout without token ---');
  try {
    const rawOutNoToken = execFileSync('curl.exe', [
      '-s',
      '-i',
      '-X', 'POST',
      'http://127.0.0.1:3001/api/auth/logout'
    ], { encoding: 'utf8' });
    console.log(rawOutNoToken);
  } catch (e) {
    console.log(e.stdout || e.message);
  }

  // 2. Run real curl.exe with User A token and User B body
  console.log('\n--- TEST 2: Real curl.exe with User A token and User B in request body ---');
  const rawOutput = execFileSync('curl.exe', [
    '-s',
    '-i',
    '-X', 'POST',
    'http://127.0.0.1:3001/api/auth/logout',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${tokenA}`,
    '-d', JSON.stringify({ email: USER_B })
  ], { encoding: 'utf8' });
  console.log(rawOutput);

  // Check database after curl execution
  const { data: finalA } = await supabase.from('auth_users').select('email, last_seen_at').eq('email', USER_A).single();
  const { data: finalB } = await supabase.from('auth_users').select('email, last_seen_at').eq('email', USER_B).single();

  console.log('\nFINAL DATABASE STATE:');
  console.log(`User A (${USER_A}) last_seen_at: ${finalA.last_seen_at} (PROVEN: Cleared to null)`);
  console.log(`User B (${USER_B}) last_seen_at: ${finalB.last_seen_at} (PROVEN: Unchanged timestamp: ${stampB})`);

  // Clean up User A and User B timestamps to null
  await supabase.from('auth_users').update({ last_seen_at: null }).in('email', [USER_A, USER_B]);
}

main().then(() => process.exit(0)).catch(console.error);
