import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = {};
fs.readFileSync('./.env', 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function findClient() {
  const { data: nonApplyWizard } = await supabase
    .from('clients')
    .select('id, company_email')
    .not('company_email', 'ilike', '%applywizard.ai%')
    .limit(10);
  console.log('Non-applywizard clients:', nonApplyWizard);

  const { data: allSample } = await supabase
    .from('clients')
    .select('id, company_email')
    .limit(5);
  console.log('Sample clients:', allSample);
}

findClient().then(() => process.exit(0)).catch(console.error);
