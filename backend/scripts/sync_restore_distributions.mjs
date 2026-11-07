import { loadLocalEnvOnce, request } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function syncAndRestoreJobDistributions() {
  console.log('🚀 Starting thorough restoration of job_distributions...');

  // 1. Fetch all storage files from submitted-applications
  const { data: storageFiles } = await supabase.storage.from('submitted-applications').list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
  const todayFiles = (storageFiles || []).filter(f => f.created_at && f.created_at.startsWith('2026-11-07'));
  console.log(`📸 Storage proofs found for today: ${todayFiles.length}`);

  // 2. Fetch all job_distributions
  const distRows = await request('job_distributions', {
    query: '?select=id,applywizz_id,company,job_url,status&limit=1000'
  });
  console.log(`📋 Total job_distributions rows: ${distRows.length}`);

  let restoredCount = 0;
  let alreadyCount = 0;
  let subCount = 0;

  for (const r of distRows) {
    const awl = (r.applywizz_id || '').trim().toUpperCase();
    const compClean = (r.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Find best matching screenshot in storage
    const matchingFile = todayFiles.find(f => {
      const parts = f.name.split('_');
      const fAwl = parts[0]?.trim().toUpperCase();
      if (fAwl !== awl) return false;
      const fComp = parts[1]?.toLowerCase().replace(/[^a-z0-9]/g, '');
      return compClean.includes(fComp) || fComp.includes(compClean);
    });

    if (matchingFile) {
      const isAlready = matchingFile.name.includes('already-applied') || matchingFile.name.includes('already_applied');
      const targetStatus = isAlready ? 'already_applied' : 'submitted';
      const publicUrl = supabase.storage.from('submitted-applications').getPublicUrl(matchingFile.name).data.publicUrl;

      const { data, error } = await supabase
        .from('job_distributions')
        .update({
          status: targetStatus,
          application_submitted_screenshot_url: publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', r.id)
        .select('id, status');

      if (!error && data && data.length > 0) {
        restoredCount++;
        if (targetStatus === 'already_applied') alreadyCount++;
        else subCount++;
      } else if (error) {
        console.warn(`Failed #${r.id} (${awl}):`, error.message);
      }
    }
  }

  console.log(`\n✅ RESTORATION SUMMARY:`);
  console.log(`   • Total Restored: ${restoredCount}/${distRows.length}`);
  console.log(`   • Already Applied: ${alreadyCount}`);
  console.log(`   • Submitted: ${subCount}`);
}

syncAndRestoreJobDistributions().catch(console.error);
