import fs from 'fs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

async function main() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    }
  });
  const spec = await res.json();
  const authUsersDef = spec.definitions?.auth_users;
  console.log('auth_users properties in PostgREST OpenAPI:');
  const targetCols = [
    'mfa_enrolled', 'setup_allowed', 'totp_secret_enc', 'totp_pending_enc',
    'totp_last_step', 'failed_code_attempts', 'locked_until', 'enrolled_at', 'last_seen_at'
  ];
  for (const col of targetCols) {
    console.log(`Column ${col}:`, authUsersDef?.properties?.[col]);
  }
}

main().catch(console.error);
