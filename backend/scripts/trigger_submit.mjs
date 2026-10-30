import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Sending start_submit trigger to bot_control...');
  const { data, error } = await supabase
    .from('bot_control')
    .update({
      stage: 'submitting',
      is_running: true,
      is_paused: false,
      stop_requested: false,
      trigger_requested: true,
      last_action_requested: 'start_submit',
      active_worker_count: 2,
      current_action: 'Submitting approved applications across 2 dedicated workers...',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'primary')
    .select('*')
    .single();

  if (error) {
    console.error('Trigger error:', error.message);
    process.exit(1);
  }
  console.log('✓ Trigger sent successfully to bot_control!');
  console.log('State:', data);
}

main().catch(console.error);
