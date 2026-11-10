import { request, loadLocalEnvOnce, isSupabaseConfigured } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

async function ingest() {
  console.log('═'.repeat(75));
  console.log('🚀 INGESTING SINGLE JOB INTO batch_job_queue');
  console.log('═'.repeat(75));

  const job_id = '5048418';
  const company = 'American Electric Power';
  const role_title = 'Project Data Analyst Sr. | Generation (Power BI, SQL)';
  const job_url = 'https://aep.wd1.myworkdayjobs.com/AEPCareerSite/job/Columbus-OH/Project-Data-Analyst-Sr---Generation--Power-BI--SQL-_R20784';
  
  const awlIds = [
    'AWL-2211',
    'AWL-25015',
    'AWL-26675',
    'AWL-28492',
    'AWL-30711',
    'AWL-31874',
    'AWL-32310',
    'AWL-32898',
    'AWL-35184',
    'AWL-35215',
    'AWL-36105',
    'AWL-39786',
    'AWL-46661',
    'AWL-46670',
  ];

  console.log(`Job ID:       ${job_id}`);
  console.log(`Company:      ${company}`);
  console.log(`Role Title:   ${role_title}`);
  console.log(`Job URL:      ${job_url}`);
  console.log(`Candidates:   ${awlIds.length} AWL IDs -> ${awlIds.join(', ')}`);

  // Check scanned_jobs for pre-existing scan
  const scannedJobs = await request('scanned_jobs', {
    query: `?job_url=eq.${encodeURIComponent(job_url)}&select=id,screenshot_path`,
  }).catch(() => []);
  const matchedSj = Array.isArray(scannedJobs) && scannedJobs.length > 0 ? scannedJobs[0] : null;

  // Check failed_jobs for expired status
  const failedJobs = await request('failed_jobs', {
    query: `?job_url=eq.${encodeURIComponent(job_url)}&select=id,failure_reason,failed_at_step,screenshot_path`,
  }).catch(() => []);
  const matchedFj = Array.isArray(failedJobs) && failedJobs.length > 0 ? failedJobs[0] : null;
  const isExp = matchedFj && (
    String(matchedFj.failure_reason || '').toLowerCase().includes('expired') ||
    String(matchedFj.failed_at_step || '').toLowerCase().includes('expired')
  );

  // Check if job_url already exists in batch_job_queue
  const existingQueue = await request('batch_job_queue', {
    query: `?job_url=eq.${encodeURIComponent(job_url)}`,
  }).catch(() => []);
  const eq = Array.isArray(existingQueue) && existingQueue.length > 0 ? existingQueue[0] : null;

  let initialStatus = 'pending';
  let scannedId = matchedSj?.id || null;
  let screenshotPath = matchedSj?.screenshot_path || null;

  if (eq?.status === 'already_scanned' || eq?.status === 'already_reached_review' || eq?.status === 'reached_review' || matchedSj) {
    initialStatus = 'already_scanned';
    scannedId = matchedSj?.id || eq?.scanned_job_id || null;
    screenshotPath = matchedSj?.screenshot_path || eq?.screenshot_path || null;
  } else if (eq?.status === 'already_expired' || eq?.status === 'expired' || isExp) {
    initialStatus = 'already_expired';
    screenshotPath = matchedFj?.screenshot_path || eq?.screenshot_path || null;
  }

  if (eq) {
    console.log(`\n⚠️  URL already exists in batch_job_queue (id: ${eq.id}). Updating with merged AWL IDs (Status: ${initialStatus})...`);
    let currentAwl = [];
    try {
      currentAwl = JSON.parse(eq.applywizz_id);
    } catch {
      currentAwl = [eq.applywizz_id].filter(Boolean);
    }
    const merged = Array.from(new Set([...currentAwl, ...awlIds]));

    const updateRes = await request('batch_job_queue', {
      method: 'PATCH',
      query: `?id=eq.${eq.id}`,
      prefer: 'return=representation',
      body: {
        job_id,
        company,
        role_title,
        applywizz_id: JSON.stringify(merged),
        status: initialStatus,
        attempt_count: 0,
        worker_id: null,
        locked_at: null,
        scanned_job_id: scannedId,
        screenshot_path: screenshotPath,
        updated_at: new Date().toISOString(),
      },
    });
    console.log('✅ Updated existing batch_job_queue record:', updateRes);
    return;
  }

  const now = new Date().toISOString();
  const newRow = {
    job_id,
    company,
    role_title,
    job_url,
    applywizz_id: JSON.stringify(awlIds),
    status: initialStatus,
    attempt_count: 0,
    worker_id: null,
    locked_at: null,
    screenshot_path: screenshotPath,
    scanned_job_id: scannedId,
    created_at: now,
    updated_at: now,
  };

  const insertRes = await request('batch_job_queue', {
    method: 'POST',
    prefer: 'return=representation',
    body: [newRow],
  });

  console.log('\n🎉 Successfully inserted job into batch_job_queue:');
  console.log(insertRes);

  console.log('\n═'.repeat(75));
  console.log('✅ INGESTION COMPLETED');
  console.log('═'.repeat(75));
}

ingest().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});

