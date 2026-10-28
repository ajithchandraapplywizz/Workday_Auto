import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function findClient() {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, company_email')
    .not('company_email', 'is', null)
    .limit(10);
  console.log('Sample clients:', data);
}

findClient().then(() => process.exit(0)).catch(console.error);
