import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing supabase credentials in backend/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

import { getUnifiedDashboardStats } from '../lib/unifiedStatsService.mjs';

async function runAudit() {
  console.log("=== EMPIRICAL WORKDAY STATS AUDIT ===");
  const stats = await getUnifiedDashboardStats({ forceRefresh: true });
  console.log("DASHBOARD STATS RESULT:", JSON.stringify(stats, null, 2));
}

runAudit();
