import { loadLocalEnvOnce, request } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function restoreSubmissions() {
  console.log('🔍 Fetching authentic screenshots from Supabase Storage bucket "submitted-applications"...');
  const { data: storageFiles, error: storageErr } = await supabase
    .storage
    .from('submitted-applications')
    .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });

  if (storageErr || !storageFiles) {
    console.error('Failed to list storage files:', storageErr?.message);
    return;
  }

  // Filter files created on 2026-11-07
  const todayFiles = storageFiles.filter(f => f.created_at && f.created_at.startsWith('2026-11-07'));
  console.log(`📸 Found ${todayFiles.length} authentic screenshot proofs created today.`);

  const distRows = await request('job_distributions', {
    query: '?select=id,applywizz_id,company,job_url,status,application_submitted_screenshot_url&limit=1000'
  });
  console.log(`📋 Found ${distRows.length} total rows in job_distributions.`);

  let restoredAlreadyApplied = 0;
  let restoredSubmitted = 0;
  const updatedIds = new Set();

  for (const f of todayFiles) {
    const parts = f.name.split('_');
    const awl = parts[0]?.trim().toUpperCase();
    const compSlug = parts[1]?.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isAlready = f.name.includes('already-applied') || f.name.includes('already_applied');
    const isSub = f.name.includes('submission') || f.name.includes('submitted');

    if (!awl || !compSlug) continue;

    const matchingRows = distRows.filter(r => {
      if (r.applywizz_id !== awl) return false;
      const rComp = (r.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const rUrl = (r.job_url || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return rComp.includes(compSlug) || compSlug.includes(rComp) || rUrl.includes(compSlug);
    });

    const publicUrl = supabase.storage.from('submitted-applications').getPublicUrl(f.name).data.publicUrl;
    const targetStatus = isAlready ? 'already_applied' : (isSub ? 'submitted' : null);

    if (!targetStatus) continue;

    for (const r of matchingRows) {
      if (!updatedIds.has(r.id)) {
        updatedIds.add(r.id);
        const nowIso = new Date().toISOString();
        const { error } = await supabase
          .from('job_distributions')
          .update({
            status: targetStatus,
            application_submitted_screenshot_url: publicUrl,
            updated_at: nowIso,
          })
          .eq('id', r.id);

        if (!error) {
          if (isAlready) restoredAlreadyApplied++;
          else if (isSub) restoredSubmitted++;
        } else {
          console.warn(`Error updating ${r.id}:`, error.message);
        }
      }
    }
  }

  console.log(`\n🎉 RESTORATION COMPLETE:`);
  console.log(`   • Already Applied restored: ${restoredAlreadyApplied}`);
  console.log(`   • Submitted restored: ${restoredSubmitted}`);
  console.log(`   • Total applications restored: ${updatedIds.size}`);
}

restoreSubmissions().catch(console.error);
