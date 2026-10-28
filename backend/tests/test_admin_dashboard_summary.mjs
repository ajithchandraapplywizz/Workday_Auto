import { getAdminDashboardData } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/adminDashboard.mjs';

async function test() {
  const allData = await getAdminDashboardData('all');
  console.log('=== SUMMARY (RANGE = ALL) ===');
  console.log('CAs total:', allData.cas.total);
  console.log('By Manager:', allData.cas.byManager);
  console.log('Presence:', { active: allData.presence.active, inactive: allData.presence.inactive });
  console.log('Tasks:', allData.tasks);
  console.log('Answer Sources:', allData.answerSources);
  console.log('Integrations:', allData.integrations);
  console.log('Reconciliation Excluded count:', allData.reconciliation.excluded.length);
  console.log('Reconciliation Excluded:', allData.reconciliation.excluded);
  console.log('Generated At:', allData.generatedAt);
  console.log('Range:', allData.range);
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
