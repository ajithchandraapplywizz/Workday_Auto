import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://rltnrnqqmufeeqaodsif.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsdG5ybnFxbXVmZWVxYW9kc2lmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMyOTU1NSwiZXhwIjoyMTAzOTA1NTU1fQ.eNtTpBT0xWtZzySiR_9OnHZVRxSmHgEZJL_pzvyfGwg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
