import { getAdminDashboardData } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/adminDashboard.mjs';

async function test() {
  console.log('Testing getAdminDashboardData("all")...');
  const allData = await getAdminDashboardData('all');
  console.log('Result (all):', JSON.stringify(allData, null, 2));

  console.log('\nTesting getAdminDashboardData("today")...');
  const todayData = await getAdminDashboardData('today');
  console.log('Result (today):', JSON.stringify(todayData, null, 2));
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
